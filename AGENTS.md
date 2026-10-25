# 🤖 Agent Autopsy: AI Coding Agent Operating Rules (SOP)

이 파일은 Antigravity, Codex CLI, Claude Code 등 AI 코딩 에이전트가 본 프로젝트에서 자율적으로 안전 검증 및 복구 워크플로우를 수행하도록 지시하는 표준 운영 지침서(Standard Operating Procedure)입니다.

---

## 📌 핵심 원칙 (Core Directives)

1. **사전 체크포인트 및 과거 기록 조회 의무 (Pre-modification Checkpoint & History Search)**
   * 새로운 기능 개발, 대규모 리팩토링, 또는 버그 수정을 시작하기 전에 반드시 `capture_checkpoint` 도구를 먼저 호출하여 현재 작업 기준점을 기록하세요.
   * 이미 최근 체크포인트가 있더라도 작업 주제가 바뀔 때는 새 라벨(`label`)로 체크포인트를 남기세요.
   * 작업 시작 전 `search_history`, `get_incident_attempts`, `get_changes_since_good_checkpoint` 도구를 활용하여 과거 유사 버그 해결 기록, 이전 실패 원인, 최근 변경 사항을 확인하세요.

2. **오류 및 기능 오작동 발생 시 포렌식 수집 및 되묻기 흐름 (Incident Forensics & Intent Clarification)**
   * 사용자가 버그나 기능 오작동을 신고하면, 코드를 읽거나 조사하기 전에 먼저 `collect_incident_bundle`을 호출하라.
   * `userReportText`에 사용자 원문을 그대로 넣고, 4가지 의도 중 원문에서 알 수 있는 것만 채워라. 빠진 항목은 `next_action`(`CLARIFY_INTENT`)에 따라 그 항목만 사용자에게 되물어라. 의도를 정리하려고 먼저 코드를 조사하지 마라.
   * **사용자 신고 원문 및 구조화된 의도 전달**:
     * 사용자의 말을 자의적으로 짐작해 코드를 바로 고쳐서는 안 됩니다.
     * `userReportText`: 사용자가 채팅이나 지시서에 작성한 원문을 그대로 넘기세요. 원문이 누락되면 출처 판정이 불가능하므로 `action: 'PROVIDE_USER_REPORT'`가 안내됩니다.
     * 4가지 의도 필드(`expectedBehavior`, `observedBehavior`, `reproductionCondition`, `verificationMethod`)를 함께 전달하면 출처(`USER_QUOTE`, `AI_INFERRED`, `MISSING`)가 자동 판별됩니다.
   * **누락 항목 되묻기 (`next_action.action: 'CLARIFY_INTENT'` 또는 `'PROVIDE_USER_REPORT'`)**:
     * `userReportText`가 없으면 `next_action.action`이 `PROVIDE_USER_REPORT`로 안내되며, 사용자에게 원문을 요청하여 확인한 후 다시 등록해야 합니다.
     * 원문이 있고 네 가지 의도가 모두 채워져 있으면 질문 없이 사건이 즉시 등록되고 다음 단계로 진행됩니다.
     * 빈 의도 항목이 있으면 `next_action.action`이 `CLARIFY_INTENT`로 안내되며, `missing_fields`에 명시된 누락 항목만 채팅창에서 사용자에게 질문하여 구체적인 답변을 확인하세요.
   * `title`: 핵심 요약
   * `agentName`: 본인 에이전트 식별자 (`antigravity`, `claude-code`, `codex` 등)
   * **사건 등록 후 변경 범위 확인 (`get_change_scope`)**:
     * 사건 등록 후 바뀐 함수 범위를 `get_change_scope`로 먼저 확인하라. 이 범위는 순위가 아니고 원인 확정도 아니다.

3. **구조화된 next_action 지침 준수 및 승인 착각 방지 (Respect Structured next_action)**
   * 모든 Agent Autopsy 도구의 응답에는 `{ "actor", "action", "agent_should", "forbidden", "note?" }` 형식의 `next_action`이 포함되어 있습니다. 에이전트는 반드시 `next_action`의 지시를 따라야 합니다.
   * **⚠️ 중요 (서브에이전트 검토 완료 ≠ 사용자 승인)**:
     * 독립 서브에이전트 검토(`submit_orchestration_review`)가 통과된 것은 고위험 패치의 '승인 잠금 해제'일 뿐, 사용자의 최종 승인이 아닙니다.
     * 사용자가 앱 대시보드(http://localhost:3847)에서 직접 승인 버튼을 누르기 전에는 절대로 패치를 워크스페이스에 적용할 수 없으며, 에이전트가 이를 승인으로 간주해서는 안 됩니다.

4. **위험 적응형 AI 오케스트레이션 및 독립 검증 게이트 (Risk-Adaptive Evidence Gate)**
   * **검증 실행 방식 (3대 모드)**:
     * `자동 판단 모드 (AUTO)`: 메인 AI가 작업 난이도·위험 신호(민감 경로, 바뀐 줄 수 등)를 평가하여 필요한 경우(고위험)에만 AI 오케스트레이션을 가동합니다.
     * `메인 AI 전용 모드 (MAIN_ONLY)`: 추가 AI 오케스트레이션을 호출하지 않고 메인 AI 단독으로 빠르게 처리합니다. 고위험 검증 생략 시 대시보드에 자체 점검표와 경고가 안내됩니다.
     * `심층 검증 우선 모드 (DEEP_PRIORITY)`: 중간 위험 이상의 모든 작업에 대해 독립 서브에이전트 교차 검증을 강력하게 요구합니다.
   * **단일 메인 모델 기반 호스트 네이티브 서브에이전트 활용**:
     * 별도의 다중 LLM이나 추가 API 키 설정 없이, 선택된 메인 환경의 네이티브 서브에이전트(`Model='inherit'`)를 호출하여 독립 검토를 수행하세요.
     * 검토 완료 후 `submit_orchestration_review` 도구로 분석 결과(`findings`), 반증(`counterEvidence`), 한계점(`limitations`), 호스트 서브에이전트 작업 식별자(`subagentTaskId` 또는 `transcriptPath`)를 제출하세요.
   * **가짜 검증 방지**:
     * 메인 AI가 자체적으로 작성한 대리 요약은 `COMPLETED_UNVERIFIED`로 기록되어 대시보드에 주의 경고가 표시됩니다.
     * 호스트 서브에이전트의 실제 실행이 확인된 경우에만 `COMPLETED_VERIFIED`로 승인 준비 완료됩니다.

5. **자가 치유 격리 검증 루프 (Self-Healing Loop: Max 3 Retries - 단 한 번의 검증된 수정 원칙)**
   * 코드를 실제 프로젝트 파일에 짐작으로 바로 수정해서는 절대 안 됩니다. (직접 수정 시 Agent Autopsy 감시기에 의해 미승인 정책 우회 경고가 발생합니다)
   * 원인 판정이 `UNKNOWN`(증거 부족)인 경우, 맹목적인 코드 패치 제출을 중단하고 `run_reproduction`을 통해 재현 테스트를 실행하여 실행 증거를 먼저 확보하세요.
   * 반드시 `propose_and_verify_repair` 도구에 **Search & Replace 블록**을 넘겨 **격리 Worktree에서 먼저 3단계 검증(구문, 타깃 검증, 전체 회귀)을 수행**하도록 하세요.
   * **원인 분석 리포트(`rootCauseAnalysis`) 작성 원칙**:
     * 무엇 때문에 의도와 실제 동작 사이에 괴리가 발생했고 어떻게 수정했는지를 **명확하고 논리적인 한국어**로 작성하세요. (대시보드에서 사용자가 읽고 승인 여부를 판단하는 핵심 근거가 됩니다)
   * **격리 검증이 실패(`VERIFIED_FAIL`)했을 경우**:
     * 실패 로그(`testExecutionOutput`)를 정밀 분석하여 최대 **3회까지** 자율적으로 수정안을 다시 제출하세요.
     * 3회 연속 실패 시에는 맹목적인 코드 수정을 중단하고 사용자에게 현재까지의 원인 분석과 실패 로그를 보고하세요.
   * **격리 검증이 통과(`VERIFIED_PASS`)했을 경우**:
     * 고위험(`HIGH`) 작업인 경우 서브에이전트 독립 검토(`submit_orchestration_review`)를 완료한 후, `await_user_decision`을 호출하여 사용자 승인을 기다리거나 사용자에게 대시보드(http://localhost:3847)에서 승인을 요청하세요.

6. **하드 승인 게이트 준수 (Respect Human Gate)**
   * 사용자가 대시보드에서 수정안을 승인하기 전에는 `apply_approved_repair` 도구를 호출하지 마세요. (서버에서 거부됩니다)
   * 사용자가 승인을 완료했거나, 대시보드에서 직접 패치를 적용할 때까지 대기하세요.
   * 패치 적용 후에는 워킹 트리에 수정된 상태로 남겨두어 사용자가 최종 확인 후 원하는 메시지로 직접 Git 커밋할 수 있도록 하세요.
