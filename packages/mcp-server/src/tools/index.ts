import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CoreManager } from '@agent-autopsy/core';
import { registerCheckpointTools } from './checkpoint.js';
import { registerProjectTools } from './project.js';
import { registerIncidentTools } from './incident.js';
import { registerRepairTools } from './repair.js';
import { registerOrchestrationTools } from './orchestration.js';
import { registerDirectivesTools } from './directives.js';
import { registerHistoryTools } from './history.js';
import { registerLocalizationTools } from './localization.js';

export function registerAllTools(
  server: McpServer,
  coreManager: CoreManager,
  resolvePath: (p?: string) => string
) {
  registerCheckpointTools(server, coreManager, resolvePath);
  registerProjectTools(server, coreManager, resolvePath);
  registerIncidentTools(server, coreManager, resolvePath);
  registerRepairTools(server, coreManager, resolvePath);
  registerOrchestrationTools(server, coreManager, resolvePath);
  registerDirectivesTools(server, coreManager, resolvePath);
  registerHistoryTools(server, coreManager, resolvePath);
  registerLocalizationTools(server, coreManager, resolvePath);
}

export {
  registerCheckpointTools,
  registerProjectTools,
  registerIncidentTools,
  registerRepairTools,
  registerOrchestrationTools,
  registerDirectivesTools,
  registerHistoryTools,
  registerLocalizationTools,
};
