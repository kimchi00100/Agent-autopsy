const { app, BrowserWindow, dialog, ipcMain, utilityProcess } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');

let mainWindow = null;
let serverProcess = null;

const DEFAULT_PORT = 3847;
let currentPort = DEFAULT_PORT;
const sessionAuthToken = process.env.AUTOPSY_AUTH_TOKEN || crypto.randomBytes(32).toString('hex');
let backendStatus = {
  state: 'STARTING', // 'STARTING' | 'READY' | 'ERROR'
  port: DEFAULT_PORT,
  host: '127.0.0.1',
  error: null,
  recoveryGuide: null,
};

function getRuntimeDataDir() {
  if (process.env.AUTOPSY_DATA_DIR && process.env.AUTOPSY_DATA_DIR.trim()) {
    return path.resolve(process.env.AUTOPSY_DATA_DIR);
  }
  const base = process.env.APPDATA || process.env.HOME || '.';
  return path.resolve(base, 'AgentAutopsy');
}

function getRuntimeCacheDir() {
  if (process.env.AUTOPSY_CACHE_DIR && process.env.AUTOPSY_CACHE_DIR.trim()) {
    return path.resolve(process.env.AUTOPSY_CACHE_DIR);
  }
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.HOME || '.';
  return path.resolve(base, 'AgentAutopsy', 'cache');
}

function checkHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/health',
        timeout: 1000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode === 200 && data.service === 'agent-autopsy') {
              resolve(data);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function resolveServerScript() {
  const candidates = [
    // 1. Packaged bundled CJS (preferred in production)
    path.resolve(__dirname, 'bundled/server-cli.cjs'),
    path.resolve(__dirname, '../bundled/server-cli.cjs'),
    path.resolve(process.resourcesPath, 'bundled/server-cli.cjs'),
    path.resolve(process.resourcesPath, 'app.asar.unpacked/electron/bundled/server-cli.cjs'),
    // 2. Dev mode monorepo fallback
    path.resolve(__dirname, '../../../packages/core/dist/src/bin/server-cli.js'),
    path.resolve(process.cwd(), 'packages/core/dist/src/bin/server-cli.js'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function resolveMcpScript() {
  const candidates = [
    path.resolve(__dirname, 'bundled/mcp-server.cjs'),
    path.resolve(__dirname, '../bundled/mcp-server.cjs'),
    path.resolve(process.resourcesPath, 'bundled/mcp-server.cjs'),
    path.resolve(process.resourcesPath, 'app.asar.unpacked/electron/bundled/mcp-server.cjs'),
    path.resolve(__dirname, '../../../packages/mcp-server/dist/index.js'),
    path.resolve(process.cwd(), 'packages/mcp-server/dist/index.js'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

async function ensureBackendServer() {
  const dataDir = getRuntimeDataDir();
  const cacheDir = getRuntimeCacheDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  // 1. Check if an Agent Autopsy instance is already running on DEFAULT_PORT with matching dataDir
  const defaultHealth = await checkHealth(DEFAULT_PORT);
  if (defaultHealth) {
    const srvDir = path.resolve(defaultHealth.dataDir || '').toLowerCase();
    const myDir = path.resolve(dataDir).toLowerCase();
    if (srvDir === myDir) {
      console.log('[Agent Autopsy] Existing compatible backend server detected on port', DEFAULT_PORT);
      currentPort = DEFAULT_PORT;
      backendStatus = { state: 'READY', port: DEFAULT_PORT, host: '127.0.0.1', error: null, recoveryGuide: null };
      broadcastBackendStatus();
      return;
    } else {
      console.warn(`[Agent Autopsy] Server on port ${DEFAULT_PORT} is using different dataDir ("${defaultHealth.dataDir}" vs "${dataDir}"). Will spawn isolated backend on dynamic port.`);
    }
  }

  // Check runtime.json for prior dynamic port
  const runtimeJsonPath = path.join(dataDir, 'runtime.json');
  if (fs.existsSync(runtimeJsonPath)) {
    try {
      const savedInfo = JSON.parse(fs.readFileSync(runtimeJsonPath, 'utf8'));
      if (savedInfo.port && savedInfo.port !== DEFAULT_PORT) {
        const savedHealth = await checkHealth(savedInfo.port);
        if (savedHealth) {
          const srvDir = path.resolve(savedHealth.dataDir || '').toLowerCase();
          const myDir = path.resolve(dataDir).toLowerCase();
          if (srvDir === myDir) {
            console.log('[Agent Autopsy] Existing backend server detected on dynamic port', savedInfo.port);
            currentPort = savedInfo.port;
            backendStatus = { state: 'READY', port: currentPort, host: '127.0.0.1', error: null, recoveryGuide: null };
            broadcastBackendStatus();
            return;
          }
        }
      }
    } catch {}
  }

  // 2. Spawn backend server process using Electron's built-in Node runtime
  const serverScript = resolveServerScript();
  if (!serverScript) {
    const errMsg = '백엔드 실행 스크립트(server-cli.cjs)를 찾을 수 없습니다.';
    console.error('[Agent Autopsy] ' + errMsg);
    backendStatus = {
      state: 'ERROR',
      port: currentPort,
      host: '127.0.0.1',
      error: errMsg,
      recoveryGuide: '프로그램을 재설치하거나 "pnpm run build"를 통해 백엔드를 번들링하세요.',
    };
    broadcastBackendStatus();
    return;
  }

  console.log('[Agent Autopsy] Starting embedded backend server via utilityProcess from:', serverScript);

  try {
    // Launch embedded backend via Electron's built-in utilityProcess (isolated, self-contained, high-performance)
    serverProcess = utilityProcess.fork(serverScript, [], {
      env: {
        ...process.env,
        AUTOPSY_DATA_DIR: dataDir,
        AUTOPSY_CACHE_DIR: cacheDir,
        PORT: String(currentPort),
        AUTOPSY_AUTH_TOKEN: sessionAuthToken,
      },
      stdio: 'pipe',
    });

    serverProcess.stdout.on('data', (data) => {
      const line = data.toString();
      const portMatch = line.match(/AUTOPSY_PORT=(\d+)/);
      if (portMatch) {
        currentPort = Number(portMatch[1]);
        console.log('[Agent Autopsy] Backend successfully bound to port:', currentPort);
        backendStatus = { state: 'READY', port: currentPort, host: '127.0.0.1', error: null, recoveryGuide: null };
        broadcastBackendStatus();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('[Agent Autopsy Backend Err]:', data.toString().trim());
    });

    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.warn('[Agent Autopsy] Backend process exited unexpectedly with code:', code);
        backendStatus = {
          state: 'ERROR',
          port: currentPort,
          host: '127.0.0.1',
          error: `백엔드 프로세스가 비정상 종료되었습니다 (종료 코드: ${code}).`,
          recoveryGuide: '로그를 확인하거나 다른 프로그램이 포트를 강제 점유하고 있는지 확인하세요.',
        };
        broadcastBackendStatus();
      }
    });

    // Bounded health check polling
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (await checkHealth(currentPort)) {
        clearInterval(interval);
        backendStatus = { state: 'READY', port: currentPort, host: '127.0.0.1', error: null, recoveryGuide: null };
        broadcastBackendStatus();
      } else if (attempts > 30) {
        clearInterval(interval);
        if (backendStatus.state !== 'READY') {
          backendStatus = {
            state: 'ERROR',
            port: currentPort,
            host: '127.0.0.1',
            error: '백엔드 서버 응답 대기 시간이 초과되었습니다.',
            recoveryGuide: '작업 관리자에서 기존 충돌 프로세스를 종료하고 프로그램을 다시 실행해 보세요.',
          };
          broadcastBackendStatus();
        }
      }
    }, 300);
  } catch (err) {
    backendStatus = {
      state: 'ERROR',
      port: currentPort,
      host: '127.0.0.1',
      error: `서버 기동 중 예외: ${err.message}`,
      recoveryGuide: '프로그램 실행 권한을 확인하세요.',
    };
    broadcastBackendStatus();
  }
}

function broadcastBackendStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend-status-change', backendStatus);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'Agent Autopsy',
    backgroundColor: '#F8FAFC',
    autoHideMenuBar: true,
    show: false, // Show gracefully once ready-to-show
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Fast Zero-Delay Local Loading: Load packaged HTML immediately without external server dependency!
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const htmlPath = path.join(__dirname, '../dist/index.html');
    if (fs.existsSync(htmlPath)) {
      mainWindow.loadFile(htmlPath);
    } else {
      // Fallback if built directory differs
      const altHtml = path.resolve(process.resourcesPath, 'app/dist/index.html');
      if (fs.existsSync(altHtml)) {
        mainWindow.loadFile(altHtml);
      } else {
        mainWindow.loadFile(path.join(__dirname, 'index.html'));
      }
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers
ipcMain.handle('select-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '프로젝트 폴더 선택 (Git 저장소)',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('get-backend-config', async () => {
  return {
    url: `http://127.0.0.1:${currentPort}`,
    port: currentPort,
    host: '127.0.0.1',
  };
});

ipcMain.handle('get-auth-token', async () => {
  return sessionAuthToken;
});

ipcMain.handle('get-backend-status', async () => {
  return backendStatus;
});

ipcMain.handle('get-mcp-info', async () => {
  const mcpScript = resolveMcpScript();
  return {
    command: 'node',
    args: mcpScript ? [mcpScript] : [],
    env: {
      AUTOPSY_DATA_DIR: getRuntimeDataDir(),
    },
    packaged: app.isPackaged,
  };
});

// App Lifecycle
app.whenReady().then(async () => {
  // 1. Immediately create window so user sees UI instantly (< 0.5s)
  createWindow();

  // 2. Start backend server in parallel without blocking UI
  ensureBackendServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

const cleanupProcesses = () => {
  if (serverProcess) {
    try {
      serverProcess.kill();
    } catch {}
    serverProcess = null;
  }
};

app.on('will-quit', cleanupProcesses);

app.on('window-all-closed', () => {
  cleanupProcesses();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
