const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autopsy', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getMcpInfo: () => ipcRenderer.invoke('get-mcp-info'),
  getBackendConfig: () => ipcRenderer.invoke('get-backend-config'),
  getBackendStatus: () => ipcRenderer.invoke('get-backend-status'),
  getAuthToken: () => ipcRenderer.invoke('get-auth-token'),
  onBackendStatusChange: (callback) => {
    const handler = (_, status) => callback(status);
    ipcRenderer.on('backend-status-change', handler);
    return () => ipcRenderer.removeListener('backend-status-change', handler);
  },
});
