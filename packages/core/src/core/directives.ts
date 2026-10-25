import * as crypto from 'node:crypto';
import { CoreContext } from './context.js';
import {
  AgentDirective,
  DirectiveKind,
  DirectiveDeliveryStatus,
  AgentEvent,
  AgentEventKind,
  ConfirmedIntentData,
} from '../types.js';

  export function recordAgentEvent(ctx: CoreContext, 
    repoPath: string,
    kind: AgentEventKind,
    title: string,
    detail: string = '',
    filePath: string | null = null,
    agentName: string = 'mcp-agent',
    sessionId?: string
  ): AgentEvent {
    const project = ctx.ensureProject(repoPath);
    const ev: AgentEvent = {
      id: `ev_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
      projectId: project.id,
      agentName,
      sessionId,
      kind,
      title,
      detail,
      filePath,
      createdAt: new Date().toISOString(),
    };
    ctx.db.insertAgentEvent(ev);
    ctx.emitChange('event_recorded', ev);
    return ev;
  }

  /**
   * Project Dashboard Overview
   */

  export function listActiveAgents(ctx: CoreContext) {
    return ctx.db.listAgentSessions();
  }

  /**
   * Creates a user directive from dashboard or workflow and attempts live delivery to waiting agent,
   * otherwise enqueues for next-call delivery or manual copy-prompt.
   */
  export function createDirective(ctx: CoreContext, 
    repoPath: string,
    params: {
      incidentId?: string;
      proposalId?: string;
      patchHash?: string;
      kind: DirectiveKind;
      feedbackText?: string;
      confirmedIntent?: ConfirmedIntentData;
    }
  ): AgentDirective {
    const project = ctx.ensureProject(repoPath);
    const directiveId = `dir_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();

    // Check if there is an active waiter waiting on this proposal or repoPath
    let activeWaiterKey: string | null = null;
    let waiterObj: { resolve: (val: any) => void; timer: NodeJS.Timeout; proposalId: string; repoPath: string } | null = null;

    if (params.proposalId) {
      const key = `${repoPath}:${params.proposalId}`;
      if (ctx.activeWaiters.has(key)) {
        activeWaiterKey = key;
        waiterObj = ctx.activeWaiters.get(key)!;
      }
    }
    if (!waiterObj) {
      for (const [k, v] of ctx.activeWaiters.entries()) {
        if (v.repoPath === repoPath) {
          activeWaiterKey = k;
          waiterObj = v;
          break;
        }
      }
    }

    let deliveryStatus: DirectiveDeliveryStatus = 'WAITING_AGENT';
    let deliveredAt: string | undefined = undefined;
    const resumeMethod: 'HOST_AUTO' | 'MANUAL_COPY_PROMPT' = 'MANUAL_COPY_PROMPT';

    // Clear, actionable Korean instruction snippet for user copy-paste if agent isn't live-waiting
    let manualPromptSnippet = '';
    switch (params.kind) {
      case 'REJECT_WITH_FEEDBACK':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 수정안 #${params.proposalId?.slice(-6) || ''}을 거절했습니다.\n피드백 사유: "${params.feedbackText || '추가 수정 필요'}"\n사유를 분석하여 격리 Worktree에서 3단계 검증을 통과하는 새로운 수정안을 제출하세요.`;
        break;
      case 'REQUEST_DEEP_REVIEW':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 수정안 #${params.proposalId?.slice(-6) || ''}에 대해 서브에이전트 심층 검토를 요청했습니다.\n네이티브 서브에이전트(Model='inherit')를 호출하여 독립 검증을 수행하고 submit_orchestration_review 도구로 증거를 제출하세요.`;
        break;
      case 'CONFIRM_INTENT':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 기능 의도를 확정했습니다.\n기대 동작: ${params.confirmedIntent?.expectedBehavior || '-'}\n실제 동작: ${params.confirmedIntent?.observedBehavior || '-'}\n재현 조건: ${params.confirmedIntent?.reproductionCondition || '-'}\n검증 수단: ${params.confirmedIntent?.verificationMethod || '-'}\n이 의도에 맞춰 사건을 분석하고 격리 검증을 수행하세요.`;
        break;
      case 'APPROVE_AND_APPLY':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 대시보드에서 수정안 #${params.proposalId?.slice(-6) || ''} 승인 및 적용을 확인했습니다.`;
        break;
    }

    if (waiterObj && activeWaiterKey) {
      deliveryStatus = 'DELIVERED_LIVE';
      deliveredAt = now;
      clearTimeout(waiterObj.timer);
      ctx.activeWaiters.delete(activeWaiterKey);
    }

    const directive: AgentDirective = {
      id: directiveId,
      projectId: project.id,
      incidentId: params.incidentId,
      proposalId: params.proposalId,
      patchHash: params.patchHash,
      kind: params.kind,
      feedbackText: params.feedbackText,
      confirmedIntent: params.confirmedIntent,
      deliveryStatus,
      resumeMethod,
      manualPromptSnippet,
      createdAt: now,
      deliveredAt,
    };

    ctx.db.insertDirective(directive);

    // If active waiter was waiting, resolve it immediately with the delivered directive
    if (waiterObj) {
      waiterObj.resolve({
        status: 'DIRECTIVE_DELIVERED',
        directive,
      });
    }

    // Side effects on incident / proposal
    if (params.kind === 'CONFIRM_INTENT' && params.incidentId && params.confirmedIntent) {
      const summary = `사용자 직접 확정: 기대="${params.confirmedIntent.expectedBehavior || ''}" / 실제="${params.confirmedIntent.observedBehavior || ''}"`;
      ctx.db.updateIncidentIntent(params.incidentId, params.confirmedIntent, true, summary);
    }
    if (params.kind === 'REJECT_WITH_FEEDBACK' && params.proposalId) {
      try {
        ctx.rejectProposal(params.proposalId);
      } catch {
        // Ignored if already rejected
      }
    }

    ctx.recordAgentEvent(
      repoPath,
      'COMMAND',
      `대시보드 지시 발행: ${params.kind}`,
      `전달 상태: ${deliveryStatus}${params.feedbackText ? ` | 피드백: ${params.feedbackText}` : ''}`,
      null,
      'dashboard'
    );

    ctx.emitChange('directive_created', { directive });
    if (deliveryStatus === 'DELIVERED_LIVE') {
      ctx.emitChange('directive_delivered', { directive });
    }

    return directive;
  }

  /**
   * Bounded long-poll for agent to await human decision on a repair proposal.
   * Max 120s timeout window ensures agent hosts (with 3-minute hard kill limits) never crash.
   */
  export async function awaitUserDecision(ctx: CoreContext, 
    repoPath: string,
    proposalId: string,
    timeoutSec: number = 90
  ): Promise<{
    status: 'DIRECTIVE_DELIVERED' | 'WAIT_TIMEOUT';
    directive?: AgentDirective;
    message?: string;
  }> {
    const project = ctx.ensureProject(repoPath);
    const boundedSec = Math.min(Math.max(timeoutSec || 90, 5), 120);

    // 1. Check if there is already a pending directive waiting for agent
    const pending = ctx.db.listPendingDirectives(project.id);
    const matching = pending.find((d) => d.proposalId === proposalId || d.deliveryStatus === 'WAITING_AGENT');
    if (matching) {
      const now = new Date().toISOString();
      ctx.db.updateDirectiveStatus(matching.id, 'DELIVERED_LIVE', { deliveredAt: now });
      matching.deliveryStatus = 'DELIVERED_LIVE';
      matching.deliveredAt = now;
      ctx.emitChange('directive_delivered', { directive: matching });
      return {
        status: 'DIRECTIVE_DELIVERED',
        directive: matching,
      };
    }

    // 2. Otherwise register bounded long-poll waiter
    return new Promise((resolve) => {
      const waiterKey = `${repoPath}:${proposalId}`;
      const timer = setTimeout(() => {
        ctx.activeWaiters.delete(waiterKey);
        resolve({
          status: 'WAIT_TIMEOUT',
          message: `대기 시간(${boundedSec}초)이 경과했습니다. 에이전트 호스트 타임아웃 방지를 위해 안전하게 대기를 종료합니다. 사용자가 대시보드에서 결정을 내리면 영속 Directive Queue에 보존되며 다음 도구 호출 시 전달되거나 수동 재개 프롬프트가 대시보드에 표시됩니다.`,
        });
      }, boundedSec * 1000);

      ctx.activeWaiters.set(waiterKey, {
        resolve,
        timer,
        proposalId,
        repoPath,
      });
    });
  }

  /**
   * Retrieve pending directives for an agent and mark WAITING_AGENT ones as DELIVERED_ON_NEXT_CALL.
   */
  export function getPendingDirectives(ctx: CoreContext, repoPath: string, agentName: string = 'agent'): AgentDirective[] {
    const project = ctx.ensureProject(repoPath);
    const pending = ctx.db.listPendingDirectives(project.id);
    const now = new Date().toISOString();

    for (const d of pending) {
      if (d.deliveryStatus === 'WAITING_AGENT') {
        ctx.db.updateDirectiveStatus(d.id, 'DELIVERED_ON_NEXT_CALL', { deliveredAt: now });
        d.deliveryStatus = 'DELIVERED_ON_NEXT_CALL';
        d.deliveredAt = now;
        ctx.emitChange('directive_delivered', { directive: d });
      }
    }

    return pending;
  }

  /**
   * Agent acknowledges receipt of a directive and commits to taking action.
   */
  export function acknowledgeDirective(ctx: CoreContext, directiveId: string, agentName: string = 'agent'): AgentDirective {
    const directive = ctx.db.getDirective(directiveId);
    if (!directive) {
      throw new Error(`Directive "${directiveId}" not found.`);
    }

    const now = new Date().toISOString();
    ctx.db.updateDirectiveStatus(directiveId, 'ACKNOWLEDGED', { acknowledgedAt: now });
    directive.deliveryStatus = 'ACKNOWLEDGED';
    directive.acknowledgedAt = now;

    const project = ctx.db.getProject(directive.projectId);
    if (project) {
      ctx.recordAgentEvent(
        project.rootPath,
        'NOTE',
        `지시 수신 확인: ${directive.kind}`,
        `에이전트가 지시(ID: ${directive.id})를 확인하고 후속 작업을 착수했습니다.`,
        null,
        agentName
      );
    }

    ctx.emitChange('directive_acknowledged', { directive });
    return directive;
  }
