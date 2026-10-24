# 🤖 Agent Autopsy: AI Coding Agent Operating Rules (SOP)

이 파일은 Antigravity, Codex CLI, Claude Code 등 AI 코딩 에이전트가 본 프로젝트에서 자율적으로 안전 검증 및 복구 워크플로우를 수행하도록 지시하는 표준 운영 지침서(Standard Operating Procedure)입니다.

---

## 📌 핵심 원칙 (Core Directives)

1. **사전 체크포인트 의무 (Pre-modification Checkpoint)**
   * 새로운 기능 개발, 대규모 리팩토링, 또는 버그 수정을 시작하기 전에 반드시 `capture_checkpoint` 도구를 먼저 호출하여 현재 작업 기준점을 기록하세요.
   * 이미 최근 체크포인트가 있더라도 작업 주제가 바뀔 때는 새 라벨(`label`)로 체크포인트를 남기세요.

2. **오류 및 기능 오작동 발생 시 포렌식 수집 (Incident Forensics)**
   * 빌드/테스트 에러(`AssertionError`, `TypeError` 등)가 발생하거나, **코드는 정상인데 사용자가 의도한 기능이 작동하지 않는 경우(기능 불일치)** 즉시 `collect_incident_bundle` 도구를 호출하세요.
   * **⚠️ 중요 (과대해석 금지 및 사용자 사전 확인 의무)**:
     * 사용자의 말을 자의적으로 짐작해 코드를 바로 고쳐서는 안 됩니다.
     * 기능 오작동 시 반드시 채팅으로 사용자에게 다음 4가지를 되물어 확인을 받고 `userConfirmedIntent: true`를 넘기세요:
       1. `expectedBehavior`: 사용자가 원래 의도한 정상 동작
       2. `observedBehavior`: 실제 발생한 오작동 증상
       3. `reproductionCondition`: 어떤 입력과 상황에서 문제가 발생하는지
       4. `verificationMethod`: 기대 결과를 검증할 테스트/관찰 수단
   * `title`: 핵심 요약
   * `agentName`: 본인 에이전트 식별자 (`antigravity`, `claude-code`, `codex` 등)

3. **위험 적응형 AI 오케스트레이션 및 독립 검증 게이트 (Risk-Adaptive Evidence Gate)**
   * **검증 실행 방식 (3대 모드)**:
     * `자동 판단 모드 (AUTO)`: 메인 AI가 작업 난이도·위험 신호(보안/결제/할인 경로, 다중 모듈 영향도, 원인 불확실성)를 평가하여 필요한 경우에만 AI 오케스트레이션을 가동합니다.
     * `메인 AI 전용 모드 (MAIN_ONLY)`: 추가 AI 오케스트레이션을 호출하지 않고 메인 AI 단독으로 빠르게 처리합니다. 고위험 검증 생략 시 대시보드에 경고가 안내됩니다.
     * `심층 검증 우선 모드 (DEEP_PRIORITY)`: 가능한 모든 작업에 대해 독립 서브에이전트 교차 검증을 강력하게 요구합니다.
   * **단일 메인 모델 기반 호스트 네이티브 서브에이전트 활용**:
     * 별도의 다중 LLM이나 추가 API 키 설정 없이, 선택된 메인 환경의 네이티브 서브에이전트(`Model='inherit'`)를 호출하여 독립 검토를 수행하세요.
     * 검토 완료 후 `submit_orchestration_review` 도구로 분석 결과(`findings`), 반증(`counterEvidence`), 한계점(`limitations`), 호스트 서브에이전트 작업 식별자(`subagentTaskId` 또는 `transcriptPath`)를 제출하세요.
   * **가짜 검증 방지**:
     * 메인 AI가 자체적으로 작성한 대리 요약은 `COMPLETED_UNVERIFIED`로 기록되어 대시보드에 주의 경고가 표시됩니다.
     * 호스트 서브에이전트의 실제 실행이 확인된 경우에만 `COMPLETED_VERIFIED`로 승인 준비 완료됩니다.

4. **자가 치유 격리 검증 루프 (Self-Healing Loop: Max 3 Retries - 단 한 번의 검증된 수정 원칙)**
   * 코드를 실제 프로젝트 파일에 짐작으로 바로 수정해서는 절대 안 됩니다. (직접 수정 시 Agent Autopsy 감시기에 의해 미승인 정책 우회 경고가 발생합니다)
   * 원인 판정이 `UNKNOWN`(증거 부족)인 경우, 맹목적인 코드 패치 제출을 중단하고 필요한 추가 증거(로그, 프로브)를 먼저 확보하세요.
   * 반드시 `propose_and_verify_repair` 도구에 **Search & Replace 블록**을 넘겨 **격리 Worktree에서 먼저 3단계 검증(코드 정상, 기능 정상, 요구사항 충족)을 수행**하도록 하세요.
   * **원인 분석 리포트(`rootCauseAnalysis`) 작성 원칙**:
     * 무엇 때문에 의도와 실제 동작 사이에 괴리가 발생했고 어떻게 수정했는지를 **명확하고 논리적인 한국어**로 작성하세요. (대시보드에서 사용자가 읽고 승인 여부를 판단하는 핵심 근거가 됩니다)
   * **격리 검증이 실패(`VERIFIED_FAIL`)했을 경우**:
     * 실패 로그(`testExecutionOutput`)를 정밀 분석하여 최대 **3회까지** 자율적으로 수정안을 다시 제출하세요.
     * 3회 연속 실패 시에는 맹목적인 코드 수정을 중단하고 사용자에게 현재까지의 원인 분석과 실패 로그를 보고하세요.
   * **격리 검증이 통과(`VERIFIED_PASS`)했을 경우**:
     * 고위험(`HIGH`) 작업인 경우 서브에이전트 독립 검토(`submit_orchestration_review`)를 완료한 후, 사용자에게 *"격리 Worktree 검증을 통과했습니다. 대시보드(http://localhost:3847)에서 사건 흐름도와 수정안을 검토하고 승인해 주세요."*라고 안내하세요.

5. **하드 승인 게이트 준수 (Respect Human Gate)**
   * 사용자가 대시보드에서 수정안을 승인하기 전에는 `apply_approved_repair` 도구를 호출하지 마세요. (서버에서 거부됩니다)
   * 사용자가 승인을 완료했거나, 대시보드에서 직접 패치를 적용할 때까지 대기하세요.
   * 패치 적용 후에는 워킹 트리에 수정된 상태로 남겨두어 사용자가 최종 확인 후 원하는 메시지로 직접 Git 커밋할 수 있도록 하세요.
