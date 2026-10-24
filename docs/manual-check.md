# Agent Autopsy 패키징 EXE 실기 동작 검증 절차서

본 문서는 `apps/desktop/release/win-unpacked/AgentAutopsy.exe` 빌드 결과물을 기반으로, 사용자가 직접 전 과정을 단계별로 따라 하며 시스템의 핵심 안전 메커니즘을 점검할 수 있도록 구성된 수동 검증 매뉴얼입니다.

---

## 📋 사전 준비 사항

- **빌드된 EXE 경로**: `C:\Users\xjwoz\OneDrive\Desktop\procject\apps\desktop\release\win-unpacked\AgentAutopsy.exe`
- **번들된 MCP 서버 경로**: `C:\Users\xjwoz\OneDrive\Desktop\procject\apps\desktop\release\win-unpacked\resources\bundled\mcp-server.cjs`
- **테스트용 예제 프로젝트**: `C:\Users\xjwoz\OneDrive\Desktop\procject\examples\shopping-cart`
  - *참고*: 예제 프로젝트가 Git 저장소가 아닌 경우, 해당 폴더에서 한 번 `git init && git add . && git commit -m "Initial commit"`을 실행해 두세요.

---

## 1단계: EXE 실행 및 대시보드 구동 확인

### 1.1 실행 방법
1. 파일 탐색기에서 아래 경로로 이동합니다:
   `C:\Users\xjwoz\OneDrive\Desktop\procject\apps\desktop\release\win-unpacked\`
2. `AgentAutopsy.exe`를 더블 클릭하여 실행합니다.

### 1.2 무엇이 보이면 성공인가?
- ✅ **즉각적인 창 로딩**: 1초 이내에 독립된 Electron 애플리케이션 창이 정상적으로 표시됩니다.
- ✅ **로컬 백엔드 서버 연결 상태**:
  - 화면 상단(또는 헤더 상태 표시줄)에 `포트 3847 연결됨` (또는 동적 할당 포트)과 함께 **초록색 상태 뱃지**가 표시됩니다.
- ✅ **메인 대시보드 렌더링**:
  - 좌측 사이드바에 프로젝트 목록 및 네비게이션(Overview, Repair, Diagnostics, Settings)이 나타납니다.
  - 아직 프로젝트를 열지 않았다면 `"프로젝트를 열어 안전한 코딩을 시작하세요"` 안내 화면이 뜹니다.

---

## 2단계: 예제 프로젝트 폴더 열기 및 테스트 명령 [확인/서명]

에이전트가 임의의 위험한 쉘 명령을 실행하지 못하도록 방지하는 **테스트 명령 사용자 확정(HMAC 서명)** 메커니즘을 확인합니다.

### 2.1 수행 방법
1. 좌측 사이드바 상단의 **`[+ 프로젝트 열기]`** 버튼을 클릭합니다.
2. 파일 선택 창에서 테스트용 예제 프로젝트 폴더(`C:\Users\xjwoz\OneDrive\Desktop\procject\examples\shopping-cart`)를 선택합니다.
3. 프로젝트가 로드되면 상단에 노란색 주의 배너와 함께 탐지된 테스트 명령이 표시됩니다:
   - 예: `자동 탐지된 테스트 명령: node test.js (미확정)`
4. 명령 확인 창 또는 프로젝트 설정(Settings) 탭에서 해당 테스트 명령 옆의 **`[명령 확정]`** (또는 `[확인]`) 버튼을 클릭합니다.

### 2.2 무엇이 보이면 성공인가?
- ✅ **안전 서명 완료 상태**:
  - 노란색 경고 배너가 사라지고, **초록색 체크 아이콘**과 함께 `테스트 명령이 안전하게 확정되었습니다 (서명 완료)` 문구가 표시됩니다.
  - 이로써 `X-Autopsy-Token` 세션 토큰을 통해 변조 불가능한 HMAC 서명이 로컬 DB에 영구 고정됩니다.

---

## 3단계: 안티그래비티(Antigravity) MCP 설정 연동

패키징된 독립형 MCP 서버를 안티그래비티 에이전트와 연결합니다.

### 3.1 설정 파일 위치
- 안티그래비티 글로벌 MCP 설정 파일:
  **`C:\Users\xjwoz\.gemini\config\mcp_config.json`**

### 3.2 넣을 내용 (JSON)
`C:\Users\xjwoz\.gemini\config\mcp_config.json` 파일을 열고 `mcpServers` 항목에 아래 설정을 입력합니다:

```json
{
  "mcpServers": {
    "agent-autopsy": {
      "command": "node",
      "args": [
        "C:\\Users\\xjwoz\\OneDrive\\Desktop\\procject\\apps\\desktop\\release\\win-unpacked\\resources\\bundled\\mcp-server.cjs"
      ],
      "env": {
        "AUTOPSY_DATA_DIR": "C:\\Users\\xjwoz\\AppData\\Roaming\\AgentAutopsy"
      }
    }
  }
}
```

> 💡 **참고**: `AgentAutopsy.exe` 앱의 대시보드 상단 또는 프로젝트 설정 화면에서 **`[MCP 설정 복사]`** 버튼을 클릭하면 클립보드에 위 설정 블록이 자동으로 생성되어 간편하게 붙여넣을 수 있습니다.

### 3.3 무엇이 보이면 성공인가?
- ✅ 안티그래비티 대화 세션에서 MCP 서버 목록을 조회할 때 `agent-autopsy`가 정상 로드됩니다.
- ✅ 사용 가능한 MCP 도구 목록에 아래 17개 Agent Autopsy 공식 도구가 등록됩니다:
  `capture_checkpoint`, `inspect_project_state`, `collect_incident_bundle`, `propose_test_command`, `propose_and_verify_repair`, `apply_approved_repair`, `rollback_to_checkpoint`, `record_agent_event`, `submit_orchestration_review`, `request_review_challenge`, `await_user_decision`, `get_pending_directives`, `acknowledge_directive`, `run_reproduction`, `search_history`, `get_incident_attempts`, `get_changes_since_good_checkpoint`

---

## 4단계: 버그 신고 및 실시간(SSE) 대시보드 등록 확인

### 4.1 수행 방법
안티그래비티 채팅창에 아래와 같이 `shopping-cart` 예제의 버그 증상을 구체적인 원문으로 신고합니다:

> **사용자 입력 예시**:
> "examples/shopping-cart 예제에서 calculateTotal에 WELCOME10 쿠폰을 적용하면 200원의 10%인 180원이 나와야 하는데 단순 10원만 차감되어 190원이 나옵니다. test.js를 실행해서 실패를 확인하고 원인을 찾아 수정해 주세요."

안티그래비티는 내부적으로 `collect_incident_bundle` 도구를 호출하여 사건 번들을 패키징하고 등록합니다.

### 4.2 무엇이 보이면 성공인가?
- ✅ **실시간(SSE) 무새로고침 반영**:
  - `AgentAutopsy.exe` 앱 화면을 새로고침(F5)하지 않아도, 수 초 이내에 실시간 이벤트 수신과 함께 사건 알림 토스트가 뜨고 목록에 새 사건이 추가됩니다.
- ✅ **좌우 대비 분할 화면 및 원문 강조**:
  - 사건 클릭 시 좌측 **`User Report`** 박스에 사용자가 입력한 신고 원문이 그대로 표시되며, 의도와 일치하는 구절이 **노란색 형광펜(`mark`)으로 강조**됩니다.
  - 우측 **`AI 의도 해석 및 출처 검증`** 박스에 4대 의도(기대 동작, 관찰 증상, 재현 조건, 검증 수단)가 파란색 **`USER_QUOTE`** 뱃지와 함께 나타납니다.
  - 만약 원문이 제공되지 않은 경우 `"사용자 원문이 제공되지 않았습니다"` 및 `AI_INFERRED`로 정직하게 표기됩니다.

---

## 5단계: 격리 검증 및 하드 승인 게이트(Human Gate) 확인

에이전트가 제안한 패치가 작업공간을 직접 오염시키지 않고 격리 검증을 거치며, **오직 사람이 [승인] 버튼을 누를 때만** 실제 파일에 반영되는지 확인합니다.

### 5.1 수행 방법
1. 안티그래비티가 원인 분석 리포트와 함께 Search & Replace 수정안을 격리 워크트리에서 검증(`propose_and_verify_repair`)합니다.
2. 에이전트의 검증 보고가 올라오면, **승인 버튼을 누르기 전에 실제 작업공간 파일을 직접 확인**합니다:
   - 파일 탐색기나 에디터(VS Code 등)에서 `examples/shopping-cart/cart.js`를 열어봅니다.
3. `AgentAutopsy.exe` 대시보드의 **`Repair (수정안 승인 검토)`** 탭으로 이동합니다:
   - 제안된 수정 내용(Diff Viewer)과 격리 워크트리 3단계 검증 통과 로그(`VERIFIED_PASS`)를 확인합니다.
4. 우측 상단의 초록색 **`[수정안 승인 및 적용]`** 버튼을 클릭합니다.

### 5.2 무엇이 보이면 성공인가?
- ✅ **승인 전 완벽한 원본 보호**:
  - 대시보드에서 `[수정안 승인 및 적용]`을 누르기 전에는 `examples/shopping-cart/cart.js`의 코드가 **기존 버그 상태 그대로** 유지되며, 작업공간 파일이 단 한 줄도 수정되지 않았음을 확인합니다.
  - 에이전트가 `apply_approved_repair`를 미리 호출하더라도 서버가 차단하여 `403 Forbidden: User approval required` 오류가 발생합니다.
- ✅ **승인 후 안전한 워크스페이스 반영**:
  - 대시보드에서 `[수정안 승인 및 적용]`을 누르면 즉시 상태가 `APPLIED`로 바뀌고 승인 지문(Fingerprint) 서명이 검증됩니다.
  - 에디터에서 `examples/shopping-cart/cart.js`를 다시 확인하면 코드가 아래와 같이 올바른 10% 할인 로직으로 깔끔하게 갱신되어 있습니다:
    ```javascript
    if (discountCode === 'WELCOME10') {
      total = total * 0.9;
    }
    ```
- ✅ **테스트 재실행 확인**:
  - `node examples/shopping-cart/test.js`를 터미널에서 실행하면 `✔ 장바구니 결제 테스트 통과 (ALL TESTS PASSED)`가 출력됩니다.
