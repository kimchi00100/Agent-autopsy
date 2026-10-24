import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { CoreManager } from '../core-manager.js';
import { resolveDataDir } from '../utils/paths.js';

export class ApiServer {
  private server: http.Server | null = null;
  private sseClients = new Set<http.ServerResponse>();
  private pollTimer: NodeJS.Timeout | null = null;
  private assignedPort: number = 3847;
  private sessionToken: string;

  constructor(
    private coreManager: CoreManager,
    private staticDir?: string
  ) {
    this.sessionToken = process.env.AUTOPSY_AUTH_TOKEN?.trim() || crypto.randomBytes(32).toString('hex');
  }

  public getSessionToken(): string {
    return this.sessionToken;
  }

  private verifySessionToken(req: http.IncomingMessage): boolean {
    const clientToken =
      (req.headers['x-autopsy-token'] as string) ||
      new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('token');
    return !!clientToken && clientToken === this.sessionToken;
  }

  public broadcastSse(type: string, data: any = {}): void {
    const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  public getPort(): number {
    return this.assignedPort;
  }

  public start(preferredPort: number = 3847): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryBind = (port: number) => {
        const srv = http.createServer(async (req, res) => {
          // 1. Strict Local Loopback Access Control (127.0.0.1 only)
          const remoteIp = req.socket.remoteAddress || '';
          const isLocalIp =
            remoteIp === '127.0.0.1' ||
            remoteIp === '::1' ||
            remoteIp === '::ffff:127.0.0.1' ||
            remoteIp === '';
          if (!isLocalIp) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden: Agent Autopsy only permits local loopback connections (127.0.0.1)' }));
            return;
          }

          // 2. Strict Origin verification against malicious external websites
          const origin = (req.headers.origin as string) || '';
          if (origin) {
            const isAllowedOrigin =
              origin === 'null' ||
              origin.startsWith('http://127.0.0.1') ||
              origin.startsWith('http://localhost') ||
              origin.startsWith('file://') ||
              origin.startsWith('vscode-webview://');
            if (!isAllowedOrigin) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Forbidden: Origin "${origin}" is not authorized.` }));
              return;
            }
            res.setHeader('Access-Control-Allow-Origin', origin);
          } else {
            res.setHeader('Access-Control-Allow-Origin', '*');
          }

          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Autopsy-Token');

          if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
          }

          try {
            await this.handleRequest(req, res);
          } catch (error: any) {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: error.message || 'Internal Server Error' }));
            }
          }
        });

        srv.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE' && port < preferredPort + 20) {
            console.warn(`[Agent Autopsy] Port ${port} is occupied. Attempting port fallback to ${port + 1}...`);
            tryBind(port + 1);
          } else {
            reject(err);
          }
        });

        srv.listen(port, '127.0.0.1', () => {
          this.server = srv;
          this.assignedPort = port;

          // Save runtime metadata so desktop UI and MCP clients can discover assigned dynamic port
          try {
            const dataDir = resolveDataDir();
            fs.mkdirSync(dataDir, { recursive: true });
            const runtimeInfo = this.coreManager.getRuntimeInfo(port);
            fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify(runtimeInfo, null, 2), 'utf8');
          } catch {}

          // Start periodic sync (every 1.5s) to guarantee real-time updates across processes
          this.pollTimer = setInterval(() => {
            if (this.sseClients.size > 0) {
              this.broadcastSse('db_sync', { time: Date.now() });
            }
          }, 1500);

          resolve(port);
        });
      };

      tryBind(preferredPort);
    });
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        if (!body.trim()) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
    if (!this.staticDir || !fs.existsSync(this.staticDir)) {
      return false;
    }

    const safeSuffix = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(this.staticDir, safeSuffix === '/' ? 'index.html' : safeSuffix);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(this.staticDir, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
      return false;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    const db = this.coreManager.getDatabase();

    // Check static files if not an /api route
    if (!pathname.startsWith('/api')) {
      if (this.serveStatic(req, res, pathname)) {
        return;
      }
    }

    // GET /api/stream (Server-Sent Events for real-time UI updates)
    if (req.method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('data: {"type":"connected"}\n\n');
      this.sseClients.add(res);
      const unsubscribe = this.coreManager.subscribe((type, data) => {
        try {
          res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
        } catch {
          this.sseClients.delete(res);
        }
      });
      req.on('close', () => {
        this.sseClients.delete(res);
        unsubscribe();
      });
      return;
    }

    // POST /api/internal/notify (Cross-process notification from MCP server or external process)
    if (req.method === 'POST' && pathname === '/api/internal/notify') {
      const body = await this.parseJsonBody(req);
      this.broadcastSse(body.type || 'db_sync', body.data || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // GET /api/health
    if (req.method === 'GET' && pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.coreManager.getRuntimeInfo(this.assignedPort)));
      return;
    }

    // GET /api/projects
    if (req.method === 'GET' && pathname === '/api/projects') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects: db.listProjects() }));
      return;
    }

    // GET /api/incidents
    if (req.method === 'GET' && pathname === '/api/incidents') {
      const projectId = url.searchParams.get('projectId');
      const incidents = projectId ? db.listIncidents(projectId) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ incidents }));
      return;
    }

    // GET /api/agents (List truly connected/active agent sessions)
    if (req.method === 'GET' && pathname === '/api/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: this.coreManager.listActiveAgents() }));
      return;
    }

    // POST /api/overview  { repoPath }
    if (req.method === 'POST' && pathname === '/api/overview') {
      const body = await this.parseJsonBody(req);
      const overview = this.coreManager.getOverview(body.repoPath || process.cwd());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(overview));
      return;
    }

    // POST /api/workspace-diff  { repoPath, checkpointId, commitSha }
    if (req.method === 'POST' && pathname === '/api/workspace-diff') {
      const body = await this.parseJsonBody(req);
      const comparison = this.coreManager.getWorkspaceComparison(body.repoPath || process.cwd(), {
        checkpointId: body.checkpointId,
        commitSha: body.commitSha,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(comparison));
      return;
    }

    // GET /api/projects/:projectId/timeline
    const tlMatch = pathname.match(/^\/api\/projects\/([^\/]+)\/timeline$/);
    if (req.method === 'GET' && tlMatch) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: this.coreManager.getTimeline(tlMatch[1]) }));
      return;
    }

    // GET /api/incidents/:incidentId/analysis
    const anMatch = pathname.match(/^\/api\/incidents\/([^\/]+)\/analysis$/);
    if (req.method === 'GET' && anMatch) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.coreManager.analyzeIncidentCauses(anMatch[1])));
      return;
    }

    // POST /api/events  { repoPath, kind, title, detail?, filePath?, agentName? }
    if (req.method === 'POST' && pathname === '/api/events') {
      const body = await this.parseJsonBody(req);
      const ev = this.coreManager.recordAgentEvent(
        body.repoPath || process.cwd(),
        body.kind || 'NOTE',
        body.title || '(제목 없음)',
        body.detail || '',
        body.filePath || null,
        body.agentName || 'agent'
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ event: ev }));
      return;
    }

    // POST /api/projects/select
    if (req.method === 'POST' && pathname === '/api/projects/select') {
      const body = await this.parseJsonBody(req);
      const repoPath = body.repoPath || process.cwd();
      const project = this.coreManager.ensureProject(repoPath);
      const health = this.coreManager.inspectProjectState(repoPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project, health }));
      return;
    }

    // GET /api/projects/:projectId/checkpoints
    const cpMatch = pathname.match(/^\/api\/projects\/([^\/]+)\/checkpoints$/);
    if (req.method === 'GET' && cpMatch) {
      const projectId = cpMatch[1];
      const checkpoints = db.listCheckpoints(projectId, 50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ checkpoints }));
      return;
    }

    // GET /api/projects/:projectId/incidents
    const incMatch = pathname.match(/^\/api\/projects\/([^\/]+)\/incidents$/);
    if (req.method === 'GET' && incMatch) {
      const projectId = incMatch[1];
      const incidents = db.listIncidents(projectId, 50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ incidents }));
      return;
    }

    // GET /api/incidents/:incidentId/proposals
    const propMatch = pathname.match(/^\/api\/incidents\/([^\/]+)\/proposals$/);
    if (req.method === 'GET' && propMatch) {
      const incidentId = propMatch[1];
      const proposals = db.listProposalsForIncident(incidentId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proposals }));
      return;
    }

    // POST /api/projects/:projectId/settings
    const settingsMatch = pathname.match(/^\/api\/projects\/([^\/]+)\/settings$/);
    if (req.method === 'POST' && settingsMatch) {
      if (!this.verifySessionToken(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid X-Autopsy-Token is required to update project settings.' }));
        return;
      }
      const projectId = settingsMatch[1];
      const body = await this.parseJsonBody(req);
      const project = db.getProject(projectId);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Project "${projectId}" not found.` }));
        return;
      }
      const updated = this.coreManager.updateProjectSettings(project.rootPath, {
        verificationMode: body.verificationMode,
        preferredHost: body.preferredHost,
        testCommand: body.testCommand,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, project: updated }));
      return;
    }

    // POST /api/projects/:projectId/confirm-test-command
    const confirmCmdMatch = pathname.match(/^\/api\/projects\/([^\/]+)\/confirm-test-command$/);
    if (req.method === 'POST' && confirmCmdMatch) {
      if (!this.verifySessionToken(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid X-Autopsy-Token is required to confirm test command.' }));
        return;
      }
      const projectId = confirmCmdMatch[1];
      const project = db.getProject(projectId);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Project "${projectId}" not found.` }));
        return;
      }
      const body = await this.parseJsonBody(req);
      const commandToConfirm = body?.testCommand || project.proposedTestCommand || project.testCommand;
      if (!commandToConfirm) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '확정할 테스트 명령이 지정되지 않았습니다.' }));
        return;
      }
      const updated = this.coreManager.confirmTestCommand(project.rootPath, commandToConfirm);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, project: updated }));
      return;
    }

    // GET /api/projects/:projectId/commands
    const cmdMatch = pathname.match(/^\/api\/projects\/([^\/]+)\/commands$/);
    if (req.method === 'GET' && cmdMatch) {
      const projectId = cmdMatch[1];
      const project = db.getProject(projectId);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Project "${projectId}" not found.` }));
        return;
      }
      const commands = this.coreManager.discoverSafeTestCommands(project.rootPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, commands }));
      return;
    }

    // POST /api/projects/:projectId/diagnose
    const diagMatch = pathname.match(/^\/api\/projects\/([^\/]+)\/diagnose$/);
    if (req.method === 'POST' && diagMatch) {
      const projectId = diagMatch[1];
      const project = db.getProject(projectId);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Project "${projectId}" not found.` }));
        return;
      }
      const diagnostics = this.coreManager.diagnoseProject(project.rootPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, diagnostics }));
      return;
    }

    // POST /api/projects/:projectId/onboard
    const onboardMatch = pathname.match(/^\/api\/projects\/([^\/]+)\/onboard$/);
    if (req.method === 'POST' && onboardMatch) {
      const projectId = onboardMatch[1];
      const project = db.getProject(projectId);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Project "${projectId}" not found.` }));
        return;
      }
      const result = this.coreManager.onboardProject(project.rootPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // POST /api/proposals/:proposalId/review
    const reviewMatch = pathname.match(/^\/api\/proposals\/([^\/]+)\/review$/);
    if (req.method === 'POST' && reviewMatch) {
      const proposalId = reviewMatch[1];
      const body = await this.parseJsonBody(req);
      const proposal = db.getRepairProposal(proposalId);
      if (!proposal) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Proposal "${proposalId}" not found.` }));
        return;
      }
      const incident = db.getIncident(proposal.incidentId);
      const project = incident ? db.getProject(incident.projectId) : null;
      const repoPath = project ? project.rootPath : (body.repoPath || process.cwd());

      const result = this.coreManager.submitOrchestrationReview(repoPath, {
        proposalId,
        reviewer: body.reviewer,
        findings: body.findings,
        counterEvidence: body.counterEvidence,
        limitations: body.limitations,
        subagentTaskId: body.subagentTaskId,
        transcriptPath: body.transcriptPath,
        challengeToken: body.challengeToken,
        submittedByRole: body.submittedByRole,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
      return;
    }

    // POST /api/proposals/:proposalId/approve
    const approveMatch = pathname.match(/^\/api\/proposals\/([^\/]+)\/approve$/);
    if (req.method === 'POST' && approveMatch) {
      if (!this.verifySessionToken(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid X-Autopsy-Token is required to approve proposals.' }));
        return;
      }
      const proposalId = approveMatch[1];
      const body = await this.parseJsonBody(req);
      const fingerprint = this.coreManager.approveProposal(
        proposalId,
        body.selectedFiles,
        body.forceOverrideWithRiskAck === true
      );
      const updated = db.getRepairProposal(proposalId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, proposal: updated, fingerprint }));
      return;
    }

    // POST /api/proposals/:proposalId/reject
    const rejectMatch = pathname.match(/^\/api\/proposals\/([^\/]+)\/reject$/);
    if (req.method === 'POST' && rejectMatch) {
      if (!this.verifySessionToken(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid X-Autopsy-Token is required to reject proposals.' }));
        return;
      }
      const proposalId = rejectMatch[1];
      this.coreManager.rejectProposal(proposalId);
      const updated = db.getRepairProposal(proposalId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, proposal: updated }));
      return;
    }

    // POST /api/proposals/:proposalId/apply
    const applyMatch = pathname.match(/^\/api\/proposals\/([^\/]+)\/apply$/);
    if (req.method === 'POST' && applyMatch) {
      const proposalId = applyMatch[1];
      const body = await this.parseJsonBody(req);
      const repoPath = body.repoPath || process.cwd();
      const result = this.coreManager.applyApprovedRepair(repoPath, proposalId, body.selectedFiles);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // POST /api/checkpoints/:checkpointId/rollback
    const rollbackMatch = pathname.match(/^\/api\/checkpoints\/([^\/]+)\/rollback$/);
    if (req.method === 'POST' && rollbackMatch) {
      if (!this.verifySessionToken(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid X-Autopsy-Token is required to rollback checkpoints.' }));
        return;
      }
      const checkpointId = rollbackMatch[1];
      const body = await this.parseJsonBody(req);
      const repoPath = body.repoPath || process.cwd();
      const result = this.coreManager.rollbackToCheckpoint(repoPath, checkpointId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
      return;
    }

    // POST /api/directives
    if (req.method === 'POST' && pathname === '/api/directives') {
      if (!this.verifySessionToken(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid X-Autopsy-Token is required to submit user directives.' }));
        return;
      }
      const body = await this.parseJsonBody(req);
      let repoPath = body.repoPath;
      if (!repoPath && body.projectId) {
        const proj = db.getProject(body.projectId);
        if (proj) repoPath = proj.rootPath;
      }
      if (!repoPath && body.incidentId) {
        const inc = db.getIncident(body.incidentId);
        if (inc) {
          const proj = db.getProject(inc.projectId);
          if (proj) repoPath = proj.rootPath;
        }
      }
      repoPath = repoPath || process.cwd();

      const directive = this.coreManager.createDirective(repoPath, {
        incidentId: body.incidentId,
        proposalId: body.proposalId,
        patchHash: body.patchHash,
        kind: body.kind,
        feedbackText: body.feedbackText,
        confirmedIntent: body.confirmedIntent,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, directive }));
      return;
    }

    // GET /api/projects/:projectId/directives
    const dirListMatch = pathname.match(/^\/api\/projects\/([^\/]+)\/directives$/);
    if (req.method === 'GET' && dirListMatch) {
      const projectId = dirListMatch[1];
      const directives = db.listDirectivesByProject(projectId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ directives }));
      return;
    }

    // POST /api/incidents/:incidentId/confirm-intent
    const confirmIntentMatch = pathname.match(/^\/api\/incidents\/([^\/]+)\/confirm-intent$/);
    if (req.method === 'POST' && confirmIntentMatch) {
      if (!this.verifySessionToken(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid X-Autopsy-Token is required to confirm intent.' }));
        return;
      }
      const incidentId = confirmIntentMatch[1];
      const body = await this.parseJsonBody(req);
      const inc = db.getIncident(incidentId);
      if (!inc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Incident "${incidentId}" not found.` }));
        return;
      }
      const proj = db.getProject(inc.projectId);
      const repoPath = proj ? proj.rootPath : process.cwd();

      const directive = this.coreManager.createDirective(repoPath, {
        incidentId,
        kind: 'CONFIRM_INTENT',
        confirmedIntent: {
          expectedBehavior: body.expectedBehavior,
          observedBehavior: body.observedBehavior,
          reproductionCondition: body.reproductionCondition,
          verificationMethod: body.verificationMethod,
        },
      });

      const updated = db.getIncident(incidentId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, incident: updated, directive }));
      return;
    }

    // POST /api/directives/:directiveId/acknowledge
    const ackDirMatch = pathname.match(/^\/api\/directives\/([^\/]+)\/acknowledge$/);
    if (req.method === 'POST' && ackDirMatch) {
      const directiveId = ackDirMatch[1];
      const body = await this.parseJsonBody(req);
      const directive = this.coreManager.acknowledgeDirective(directiveId, body.agentName || 'dashboard');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, directive }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }
}
