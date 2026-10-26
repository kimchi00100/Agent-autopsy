# Agent Autopsy 패키징 EXE 실기 동작 검증 절차서

본 문서는 `<저장소 경로>\apps\desktop\release\win-unpacked\AgentAutopsy.exe` (예: `C:\dev\agent-autopsy\apps\desktop\release\win-unpacked\AgentAutopsy.exe`) 빌드 결과물을 기반으로, 사용자가 직접 전 과정을 단계별로 따라 하며 시스템의 핵심 안전 메커니즘을 점검할 수 있도록 구성된 실기 검증 매뉴얼입니다.

---

## 📋 사전 준비: 독립 데모 프로젝트 생성

Agent Autopsy는 열린 폴더의 상위 `.git` 루트를 프로젝트 단위로 자동 인식하므로, `<저장소 경로>`(예: `C:\dev\agent-autopsy`) 내부의 `examples/shopping-cart`를 직접 열지 않고 **프로젝트 외부의 독립된 폴더**로 복사하여 Git 저장소를 초기화합니다.

### 데모 폴더 복사 및 Git 초기화 (PowerShell)
```powershell
# 1. 바탕화면에 독립 검증용 폴더 생성
New-Item -ItemType Directory -Path "$HOME\Desktop\autopsy-demo" -Force

# 2. shopping-cart 예제 코드 복사
Copy-Item -Recurse "<저장소 경로>\examples\shopping-cart\*" "$HOME\Desktop\autopsy-demo\"

# 3. 독립 Git 저장소 초기화 및 첫 커밋
cd "$HOME\Desktop\autopsy-demo"
git init -b main
git config user.name "Tester"
git config user.email "tester@local"
git add .
git commit -m "Initial commit: cart with WELCOME10 coupon bug"
```

- **데모 프로젝트 경로**: `%USERPROFILE%\Desktop\autopsy-demo`
- **패키징된 EXE 경로**: `<저장소 경로>\apps\desktop\release\win-unpacked\AgentAutopsy.exe` (예: `C:\dev\agent-autopsy\apps\desktop\release\win-unpacked\AgentAutopsy.exe`)
- **번들된 배포용 MCP 서버**: `<저장소 경로>\apps\desktop\release\win-unpacked\resources\bundled\mcp-server.cjs` (예: `C:\dev\agent-autopsy\apps\desktop\release\win-unpacked\resources\bundled\mcp-server.cjs`)

---

## 1단계: EXE 실행 및 대시보드 구동 확인

### 1.1 실행 방법
1. 파일 탐색기에서 아래 경로로 이동합니다:
   `<저장소 경로>\apps\desktop\release\win-unpacked\` (예: `C:\dev\agent-autopsy\apps\desktop\release\win-unpacked\`)
2. `AgentAutopsy.exe`를 더블 클릭하여 실행합니다.

> ⚠️ **주의 (실행 경로)**: 최신 빌드 결과물은 반드시 `<저장소 경로>\apps\desktop\release\win-unpacked\AgentAutopsy.exe`에 생성됩니다. 이전 배포 폴더나 바탕화면의 이전 바로가기를 실행할 경우 최신 UI와 기능이 반영되지 않은 구버전 화면이 표시될 수 있으므로, 반드시 위 경로의 최신 실행 파일을 직접 실행하세요.

### 1.2 무엇이 보이면 성공인가?
- ✅ **즉각적인 창 로딩**: 1초 이내에 독립된 Electron 애플리케이션 창이 정상적으로 표시됩니다.
- ✅ **로컬 백엔드 서버 연결 상태**:
  - 화면 좌측 사이드바 하단의 **`로컬 MCP`** 카드에 초록색 점과 함께 **`실행 중`** 표시가 나타납니다.
  - 백엔드 프로세스 오류 배너가 뜨지 않고 정상 대기 상태를 유지합니다.
- ✅ **메인 대시보드 렌더링**:
  - 좌측 사이드바에 6개 메인 메뉴(**`대시보드`**, **`사건 분석`**, **`작업 타임라인`**, **`코드 비교`**, **`복구 센터`**, **`프로젝트 설정`**)가 표시됩니다.
  - 아직 프로젝트가 선택되지 않았다면 중앙에 `"시작하려면 프로젝트 폴더를 선택하세요"` 안내와 **`[프로젝트 폴더 선택]`** 버튼이 나타납니다.

---

## 2단계: 데모 프로젝트 폴더 열기 및 테스트 명령 [확인 및 서명]

에이전트가 임의의 위험한 쉘 명령을 실행하지 못하도록 방지하는 **테스트 명령 사용자 확정(HMAC 전자 서명)** 메커니즘을 확인합니다.

### 2.1 수행 방법
1. 화면 상단 헤더 우측의 **`[폴더 선택]`** 버튼(또는 중앙의 **`[프로젝트 폴더 선택]`** 버튼)을 클릭합니다.
2. 폴더 선택 창에서 방금 준비한 독립 데모 폴더(`%USERPROFILE%\Desktop\autopsy-demo`)를 선택합니다.
3. 프로젝트가 로드되면 상단에 노란색 경고 배너가 표시됩니다:
   - `테스트 명령 미확정: 프로젝트 검증 테스트 명령이 서명되지 않았습니다. 격리 검증을 위해 사용자의 확인이 필요합니다.`
4. 배너 우측의 **`[설정에서 확인하기]`** 버튼을 클릭하거나, 좌측 사이드바에서 **`프로젝트 설정`** 메뉴를 클릭합니다.
5. `테스트 명령 (격리 검증용)` 카드에서 테스트 명령 입력창(`node test.js` 등) 우측의 **`[확인 및 서명]`** 버튼(또는 AI 제안이 있는 경우 **`[이 제안으로 확정 및 서명]`** 버튼)을 클릭합니다.

### 2.2 무엇이 보이면 성공인가?
- ✅ **안전 서명 완료 상태**:
  - 상단 노란색 미확정 경고 배너가 즉시 사라집니다.
  - 상태 배지가 노란색 `미확정 (확인 필요)`에서 초록색 **`확정됨 (서명 완료)`**로 바뀝니다.
  - 하단에 초록색 방패 아이콘과 함께 `현재 명령: node test.js (HMAC 전자 서명 유효)` 문구가 표시됩니다.
  - 이로써 `X-Autopsy-Token` 세션 토큰을 통해 변조 불가능한 HMAC 서명이 로컬 DB에 영구 고정됩니다.

---

## 3단계: 안티그래비티(Antigravity) MCP 설정 연동

패키징된 독립형 MCP 서버를 안티그래비티 에이전트와 연결합니다.

### 3.1 설정 파일 위치
- 안티그래비티 글로벌 MCP 설정 파일:
  **`%USERPROFILE%\.gemini\config\mcp_config.json`**

### 3.2 넣을 내용 (JSON)
`%USERPROFILE%\.gemini\config\mcp_config.json` 파일을 열고 `mcpServers` 항목에 아래 설정을 입력합니다:

```json
{
  "mcpServers": {
    "agent-autopsy": {
      "command": "node",
      "args": [
        "<저장소 경로>\\apps\\desktop\\release\\win-unpacked\\resources\\bundled\\mcp-server.cjs"
      ]
    }
  }
}
```

> ⚠️ **참고 (데이터 경로)**: DB 저장 경로는 기본값(`%APPDATA%\AgentAutopsy`)으로 자동 감지되므로 `AUTOPSY_DATA_DIR` 환경 변수를 별도로 지정할 필요가 없습니다. 만약 환경 변수로 직접 지정하려면 `%APPDATA%` 대신 실제 절대 경로(예: `C:\\Users\\<사용자명>\\AppData\\Roaming\\AgentAutopsy`)를 입력해야 합니다.

> 💡 **참고**: `AgentAutopsy.exe` 앱의 좌측 사이드바 하단에 있는 **`로컬 MCP (실행 중)`** 카드를 클릭하면 **`코딩 에이전트 연결 및 규칙 설정`** 팝업 창이 열립니다. 여기서 `Antigravity` 탭을 선택하고 **`[설정 복사]`** 버튼을 클릭하여 복사할 수도 있습니다.

### 3.3 에이전트 권장 규칙 설정 (프롬프트 / 시스템 규칙용)

MCP 도구 연결만으로는 에이전트가 문제를 조사하기 전에 코드를 먼저 열람하거나 임의로 수정할 수 있습니다. 아래의 **권장 운영 규칙**을 에이전트의 커스텀 지침(System Instructions)이나 새 대화의 첫 프롬프트에 추가하세요:

```markdown
# Agent Autopsy 에이전트 필수 운영 규칙
1. [작업 전 기준점] 작업 시작 전 반드시 capture_checkpoint를 호출하여 기준점을 기록하라.
2. [사전 코드 조사 금지] 버그나 기능 오작동 신고 시 코드를 읽거나 조사하기 전에 먼저 collect_incident_bundle을 호출하라.
   - userReportText에 사용자 원문을 그대로 넣고, 4대 의도는 원문에서 알 수 있는 것만 채워라.
   - 누락 항목은 안내되는 next_action(CLARIFY_INTENT)에 따라 사용자에게 질문하라. 의도 정리를 위한 사전 코드 조사는 금지된다.
3. [변경 범위 확인] 사건 등록 직후 get_change_scope로 변경 범위를 먼저 확인하라(원인 확정 아님).
4. [지침 준수] 모든 도구 응답의 next_action 구조화 지침을 엄격히 준수하라.
5. [직접 수정 금지] 소스 코드를 직접 수정하지 마라. 반드시 propose_and_verify_repair로 격리 검증을 수행하라.
6. [승인 착각 방지] 서브에이전트 독립 검토(submit_orchestration_review) 완료는 사용자 승인이 아니다.
7. [인간 승인 대기] 사용자가 앱 대시보드(http://localhost:3847)에서 직접 승인할 때까지 대기하라(await_user_decision). 사용자 승인 없이 apply_approved_repair를 호출하지 마라.
```

> 💡 **참고**: `AgentAutopsy.exe` 앱의 **`코딩 에이전트 연결 및 규칙 설정`** 팝업 창에서도 위 권장 규칙을 확인하고 **`[규칙 복사]`** 버튼으로 간편하게 복사할 수 있습니다.

### 3.4 무엇이 보이면 성공인가?
- ✅ 안티그래비티 대화 세션에서 MCP 서버 목록을 조회할 때 `agent-autopsy`가 정상 로드됩니다.
- ✅ 사용 가능한 MCP 도구 목록에 아래 18개 Agent Autopsy 공식 도구가 활성화됩니다:
  `capture_checkpoint`, `inspect_project_state`, `collect_incident_bundle`, `propose_test_command`, `get_change_scope`, `propose_and_verify_repair`, `apply_approved_repair`, `rollback_to_checkpoint`, `record_agent_event`, `submit_orchestration_review`, `request_review_challenge`, `await_user_decision`, `get_pending_directives`, `acknowledge_directive`, `run_reproduction`, `search_history`, `get_incident_attempts`, `get_changes_since_good_checkpoint`
- ✅ `AgentAutopsy.exe` 앱 좌측 사이드바의 **`연결된 에이전트`** 영역에 안티그래비티 세션이 **`활성`** 상태(초록색 펄스 점)로 나타납니다.

---

## 4단계: 버그 신고 및 실시간(SSE) 대시보드 등록 확인

### 4.1 수행 방법
안티그래비티 채팅창에 `%USERPROFILE%\Desktop\autopsy-demo` 프로젝트 경로를 지정하고 버그 증상을 구체적인 원문으로 신고합니다:

> **사용자 입력 예시**:
> "내 바탕화면의 데모 프로젝트(%USERPROFILE%\Desktop\autopsy-demo)에서 cart.js의 calculateTotal에 WELCOME10 쿠폰을 적용하면 200원의 10%인 180원이 나와야 하는데 단순 10원만 차감되어 190원이 나옵니다. node test.js를 실행해서 실패를 확인하고 사건을 수집한 뒤 격리 검증으로 수정안을 제안해 주세요."

안티그래비티는 `collect_incident_bundle` 도구를 호출하여 사건 번들을 패키징하고 등록합니다.

### 4.2 무엇이 보이면 성공인가?
- ✅ **실시간(SSE) 무새로고침 반영**:
  - `AgentAutopsy.exe` 화면을 새로고침(F5)하지 않아도, SSE 스트림을 통해 즉시 실시간 알림 토스트가 뜨고 좌측 사이드바의 **`사건 분석`** 메뉴 옆에 미해결 사건 카운트 배지(예: `1`)가 뜹니다.
- ✅ **좌우 대비 분할 화면 및 원문 강조 (`사건 분석` 뷰)**:
  - 좌측 **`User Report`** 박스에 사용자가 입력한 신고 원문이 그대로 표시되며, 의도와 일치하는 구절이 **노란색 형광펜(`<mark>`)으로 강조**됩니다.
  - 우측 **`AI 의도 해석 및 출처 검증`** 박스에 4대 의도(기대 동작, 관찰 증상, 재현 조건, 검증 수단)가 파란색 **`USER_QUOTE`** 배지와 함께 나타납니다.
  - 만약 원문이 제공되지 않고 등록된 경우 `"사용자 원문이 제공되지 않았습니다."` 이탤릭 문구와 함께 회색 `AI_INFERRED`로 표기됩니다.

---

## 5단계: 격리 검증 및 하드 승인 게이트(Human Gate) 확인

에이전트가 제안한 패치가 실제 작업공간 파일을 직접 건드리지 않고 격리 워크트리에서만 테스트되며, **오직 사용자가 [승인 및 복구 실행] 버튼을 누를 때만** 실제 파일에 반영되는지 확인합니다.

### 5.1 수행 방법
1. 안티그래비티가 원인 분석 리포트와 함께 Search & Replace 수정안을 격리 워크트리에서 검증(`propose_and_verify_repair`)합니다.
2. 에이전트의 격리 검증 완료 보고가 올라오면, **승인 버튼을 누르기 전에 실제 작업공간 파일을 직접 확인**합니다:
   - 메모장이나 에디터에서 `%USERPROFILE%\Desktop\autopsy-demo\cart.js`를 열어봅니다.
3. (선택적 보안 검증) 만약 에이전트가 사용자 승인 없이 `apply_approved_repair`를 미리 호출하는 경우:
   - 서버는 즉시 차단하며 아래의 실제 보안 위반 오류를 반환합니다:
     ```
     [SECURITY GATE VIOLATION]: Repair proposal "prop_xxxx" cannot be applied because its status is "AWAITING_USER". It must be explicitly approved by the user in Agent Autopsy first.
     ```
   - (외부에서 HTTP API를 직접 조작하려는 경우에도 유효한 세션 토큰이 없어 `401 Unauthorized`로 차단됩니다.)
4. `AgentAutopsy.exe` 좌측 사이드바에서 **`복구 센터`** 메뉴로 이동합니다:
   - 상단에 **`3단계 격리 검증 파이프라인 (Security & Isolation Pipeline)`**의 3단계 통과 결과(`PASS`)를 확인합니다.
   - 중앙 코드 뷰에서 `왼쪽: 현재 코드`와 `오른쪽: 수정안` Diff를 확인합니다.
5. 하단 우측의 초록색 **`[승인 및 복구 실행]`** 버튼을 클릭합니다.
6. 확인 팝업(`적용 전 안전한 Checkpoint가 자동으로 저장되며... 진행할까요?`)에서 **[확인]**을 누릅니다.

### 5.2 무엇이 보이면 성공인가?
- ✅ **승인 전 완벽한 원본 보호**:
  - `[승인 및 복구 실행]`을 누르기 전에는 `%USERPROFILE%\Desktop\autopsy-demo\cart.js`의 코드가 기존 버그 코드(`total = total - 10;`) 상태를 온전히 유지하고 있음을 확인합니다.
- ✅ **승인 후 안전한 워크스페이스 반영**:
  - 승인 버튼 클릭 시 `"수정안을 적용했습니다. 변경 사항을 확인한 뒤 직접 Commit 해 주세요."` 토스트가 뜹니다.
  - 에디터에서 `%USERPROFILE%\Desktop\autopsy-demo\cart.js`를 다시 확인하면 올바른 10% 할인 로직(`total = total * 0.9;` 또는 `total - total * 0.1`)으로 안전하게 갱신되어 있습니다.
- ✅ **검증 통과 확인**:
  - 터미널에서 `node test.js`를 실행하면 `✔ 장바구니 결제 테스트 통과 (ALL TESTS PASSED)`가 출력됩니다.
