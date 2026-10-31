<p align="center">
  <a href="./README.md">English</a> · <b>한국어</b>
</p>

<h1 align="center">Agent Autopsy</h1>

<p align="center">
  <b>AI 에이전트는 제안하고, 승인은 사람이 합니다. 승인 없이는 아무것도 반영되지 않습니다.</b>
</p>

<p align="center">
  <a href="docs/screenshots/repair-center.jpeg"><img src="docs/screenshots/repair-center.jpeg" alt="복구 센터: 사람의 승인을 기다리는 검증된 수정안" width="100%" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/last-commit/kimchi00100/agent-autopsy?style=flat-square&color=black" alt="last commit" />
  <img src="https://img.shields.io/github/languages/top/kimchi00100/agent-autopsy?style=flat-square&color=black" alt="top language" />
  <img src="https://img.shields.io/badge/TypeScript-black?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/React-black?style=flat-square&logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/Electron-black?style=flat-square&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/Node.js-black?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/SQLite-black?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/MCP-black?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/tree--sitter-black?style=flat-square" alt="tree-sitter" />
  <img src="https://img.shields.io/badge/Claude%20Code-black?style=flat-square&logo=anthropic&logoColor=white" alt="Claude Code" />
  <img src="https://img.shields.io/badge/Codex-black?style=flat-square" alt="Codex" />
  <img src="https://img.shields.io/badge/Antigravity-black?style=flat-square" alt="Antigravity" />
  <img src="https://img.shields.io/badge/local--first-white?style=flat-square" alt="local-first" />
  <img src="https://img.shields.io/badge/no%20API%20key-white?style=flat-square" alt="no API key" />
  <img src="https://img.shields.io/badge/human--in--the--loop-white?style=flat-square" alt="human-in-the-loop" />
  <img src="https://img.shields.io/badge/license-MIT-white?style=flat-square" alt="MIT license" />
</p>

<p align="center">
  <a href="#왜-agent-autopsy인가">왜 필요한가</a> ·
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#주요-기능">주요 기능</a> ·
  <a href="#동작-방식">동작 방식</a> ·
  <a href="#철학--에이전트의-말이-아니라-증거를-믿는다">철학</a> ·
  <a href="#로드맵">로드맵</a> ·
  <a href="#연락처">연락처</a>
</p>

---

## 왜 Agent Autopsy인가

> *"모든 테스트를 통과했습니다."* — 기능이 여전히 안 되는데 코딩 에이전트가 늘 하는 말

AI 코딩 에이전트는 컴파일되는 코드를 잘 만듭니다. 정말 골치 아픈 버그는 **돌아가지만 틀리게 동작하는** 버그입니다. 자동 사냥이 사거리 끝의 몬스터를 안 때리고, 10% 할인이 10원 차감으로 처리되고, 저장 파일에서 아이템이 조용히 사라집니다.

이런 버그를 신고하면 에이전트는 대개 짐작으로 저장소를 여기저기 다시 읽고, 원본 파일을 바로 고치고, "해결했다"고 말합니다. Agent Autopsy는 그 사이에 검문소를 둡니다.

| | 에이전트에게 다시 부탁하기 | **Agent Autopsy** |
| --- | --- | --- |
| 신고한 내용 | 에이전트가 자기 말로 바꿔 씀 | 사용자 원문을 그대로 저장하고, 에이전트의 해석 옆에 둠. 항목마다 원문 인용인지 추론인지 표시 |
| 에이전트가 먼저 보는 곳 | 짐작한 곳, 대개 저장소 전체 | 지난 체크포인트 이후 바뀐 함수와, 그 함수를 직접 호출하거나 호출받는 함수 |
| 버그가 진짜라는 증거 | 에이전트가 재현했다고 말함 | 지금 단언 실패로 실패하는 테스트. 마지막 정상 체크포인트, 단언을 뒤집은 사본과 비교한 뒤 잠가서 수정안이 그 테스트를 고칠 수 없음 |
| 수정을 시험하는 곳 | 작업 중인 원본 폴더, 그마저도 안 할 때가 많음 | 원본을 건드리기 전, 격리된 git 워크트리 |
| "검증됨"의 의미 | 에이전트가 그렇다고 말함 | 문법, 대상 테스트, 전체 회귀 테스트를 따로 실행하고 로그를 남김 |
| 에이전트가 막혔을 때 | 계속 짐작으로 고침 | 재현 실패 3번이면 멈춤. 계속할지는 사용자만 정하고, 그 이유가 기록됨 |
| 결정하는 사람 | 에이전트 | 사용자. 데스크톱 앱에서 클릭 한 번 |
| 승인 뒤에 수정안이 바뀌면 | 아무도 모름 | 승인에 서명된 지문이 붙고 적용 직전에 다시 확인. 다르면 `TAMPERED`로 표시 |

## 빠른 시작

```bash
# 1. 빌드
git clone https://github.com/kimchi00100/agent-autopsy.git
cd agent-autopsy
pnpm install
pnpm run build

# 2. 데스크톱 앱 실행
pnpm run desktop

# 3. 또는 Windows 실행 파일로 패키징
pnpm run build:exe   # -> apps/desktop/release/win-unpacked/AgentAutopsy.exe
```

Node.js 22.5 이상, pnpm, Git 2.40 이상이 필요합니다. 패키징된 앱은 Windows용입니다.

### 에이전트 연결

사용하는 에이전트(Antigravity, Claude Code, Codex 등 MCP 클라이언트)의 MCP 설정에 추가합니다.

```json
{
  "mcpServers": {
    "agent-autopsy": {
      "command": "node",
      "args": ["<설치 경로>/packages/mcp-server/dist/index.js"]
    }
  }
}
```

패키징된 앱을 쓴다면 `args`에 `apps/desktop/release/win-unpacked/resources/bundled/mcp-server.cjs`를 넣으세요. 다시 빌드한 뒤에는 에이전트를 재시작해야 새 도구가 보입니다.

그다음 데스크톱 앱에서 프로젝트를 열고 테스트 명령을 한 번 확인해 주세요. 확인하지 않은 명령은 절대 실행되지 않습니다.

## 주요 기능

**복구 센터: 확인하고 승인하기.** 검증된 수정안의 원인 분석 요약, 3단계 검증 결과, 좌우 비교 Diff를 보여줍니다. 사용자의 원문과 에이전트의 해석을 나란히 보여주고 원문에서 인용한 부분을 표시해서, 정말 내가 요청한 내용인지 확인할 수 있습니다. 승인 버튼 옆에는 재현 증거 수준과 수정안 무결성 검사 결과가 나옵니다. 승인 버튼을 누르기 전에는 아무것도 적용되지 않습니다.

**사건 분석: 어디서 깨졌는지 보기.** 버그 신고는 사건으로 등록됩니다. 기대 동작과 실제 동작, 관찰된 증거와 추론된 연결을 구분한 흐름도, 심각도와 위험도마다 그렇게 판정한 근거를 보여줍니다. 신고에 빠진 항목이 있으면 에이전트는 그 항목만 사용자에게 되묻도록 안내받습니다.

<p align="center">
  <a href="docs/screenshots/incident-analysis.jpeg"><img src="docs/screenshots/incident-analysis.jpeg" alt="사건 분석" width="100%" /></a>
</p>

**재현 게이트: 맞는 이유로 실패하는 테스트.** 에이전트가 만든 재현 테스트는 현재 작업 폴더의 스냅샷에서 실행됩니다. 단언 실패로 실패할 때만 인정하고, 프로그램 오류·import 오류·테스트 0개·실행마다 결과가 다른 경우는 되돌려 보냅니다. 같은 테스트를 마지막 정상 체크포인트에서도 돌려 보고(이번 변경이 버그를 만들었나?), 지금의 틀린 값을 기대하도록 단언을 뒤집은 사본은 현재 코드에서 통과해야 합니다(테스트가 정말 신고한 동작을 확인하나?). 셋이 모두 맞을 때만 강한 증거로 표시합니다. 재현된 테스트는 잠기므로, 그 테스트를 고치는 수정안이나 디스크에서 바뀐 테스트는 거부됩니다. 실패 3번이면 사건은 기권 상태가 되고, 사용자가 앱에서 결정할 때까지 에이전트는 멈춥니다.

**결정은 기록으로 남는다.** 재현 없이 진행, 재현 시도 3번 더 허락, 손상된 감사 기록 확인은 데스크톱 앱의 버튼으로만 할 수 있고 MCP 도구에는 없습니다. 결정마다 이유를 적어야 합니다. 이유는 감사 기록 옆에 저장되고, 나중에 정상·불일치·기록 없음·검증 안 됨(그 앞에서 감사 기록이 손상된 경우)으로 표시됩니다.

**변경 범위: 어디부터 볼지 알려주기.** 사건이 등록되면 에이전트는 곧바로 지난 체크포인트 이후 바뀐 함수와, 그 함수를 호출하거나 그 함수가 호출하는 함수 목록을 받습니다. Python, JavaScript/TypeScript, C/C++를 tree-sitter로 분석합니다. 이것은 탐색 범위일 뿐 순위도, 원인 판정도 아닙니다. 에이전트는 저장소 전체를 다시 읽기 전에 이 함수들을 사용자 신고와 먼저 비교하도록 안내받습니다.

**대시보드: 프로젝트를 한눈에.** 빌드·테스트 상태, 미해결 사건, 수정 성공률, git 상태, 감사 기록 검사 결과를 보여줍니다.

<p align="center">
  <a href="docs/screenshots/dashboard.jpeg"><img src="docs/screenshots/dashboard.jpeg" alt="대시보드" width="100%" /></a>
</p>

측정 결과([자세히](docs/performance.md)), 변경 파일이 50개일 때 `POST /api/overview` 응답 시간은 4,351 ms → 199 ms(3회 측정의 중앙값)로 줄었고, 60초 동안 아무 작업도 안 할 때 실행된 git 프로세스 수는 1,104 → 9로 줄었습니다. 측정 조건(노트북 1대, 작은 예제 저장소)은 [performance.md](docs/performance.md)에 정리되어 있습니다.

<sub>스크린샷은 회귀 버그 하나를 심은 작은 예제 프로젝트(<code>idle-rpg</code>)로 찍었습니다. 메뉴는 영어로 바꿀 수 있고, 나머지 화면은 지금 한국어가 기본입니다.</sub>

## 동작 방식

버그를 신고한 뒤 일어나는 일입니다.

```mermaid
flowchart TD
    A[사용자가 버그 신고] --> B[사건 등록<br/>사용자 원문 그대로 저장]
    B --> C{기대 결과, 관찰 결과,<br/>재현 조건, 확인 방법 중<br/>빠진 것이 있나?}
    C -- 있음 --> D[빠진 항목만<br/>사용자에게 질문] --> B
    C -- 없음 --> E[변경 범위<br/>체크포인트 이후 바뀐 함수]
    E --> F[작업 폴더 스냅샷에서<br/>재현 테스트 실행]
    F --> G{단언 실패로 실패했나?}
    G -- 예 --> H[REPRODUCED, 테스트 잠금<br/>정상 시점 비교와 뒤집기로 증거 수준 결정]
    G -- 아니오 --> I{실패 3번?}
    I -- 아니오 --> F
    I -- 예 --> J[에이전트 멈춤<br/>사용자가 이유를 적고 생략 또는 3번 더 허락]
    H --> K[워크트리에서 수정안 검증<br/>문법, 대상 테스트, 전체 회귀]
    J -- 재현 없이 진행 --> K
    K --> L[데스크톱 앱에서 사용자 승인<br/>버튼 옆에 증거 수준 표시]
    L --> M[서명 재확인 후<br/>원본에 적용]
```

재현은 권장 사항이지 필수는 아닙니다. 재현 테스트가 없는 사건의 수정안도 검증할 수 있고, 그때 승인 화면 버튼 옆에는 "재현 시도 없음"이 표시됩니다. 실패 이유 판정은 지금 pytest, unittest, `node:test`를 지원합니다. 다른 실행기의 실패는 "검증 못 함"으로 기록되고 실행 증거로 인정되지 않습니다.

구성 요소의 연결은 이렇습니다.

```text
+--------------+   MCP    +---------------------- Agent Autopsy (local) -------+
| Coding agent | -------> |                                                    |
|  (proposes)  |          |   incident --> change scope --> evidence --> patch |
+--------------+          |   (your words)  (since last                 |      |
                          |                  checkpoint)                v      |
                          |                  isolated git worktree             |
                          |       syntax --> target test --> full regression   |
                          |                               |                    |
                          |                               v                    |
+--------------+  token   |                  +-------------------------+       |
| Desktop app  | -------> |                  |      approval gate      |       |
| (you decide) |          |                  |   signed fingerprint    |       |
+--------------+          |                  +------------+------------+       |
                          |                               | approved only      |
                          +-------------------------------|--------------------+
                                                          v
                                                  your working tree
```

- **MCP 서버**: 에이전트가 호출하는 도구 18개입니다. 체크포인트, 사건 등록, 변경 범위, 재현 테스트 실행, 수정안 제안과 검증, 사건 기록 조회를 맡고, 모든 응답에 다음 행동 안내(`next_action`)를 붙입니다.
- **코어 엔진**: 체크포인트, 변경 범위 분석기, 워크트리 실행기, 승인 게이트, 로컬 SQLite 저장소입니다.
- **데스크톱 앱**: Electron + React. 테스트 명령을 확정하고 수정안을 승인할 수 있는 유일한 곳입니다.

## 철학 — 에이전트의 말이 아니라 증거를 믿는다

- **에이전트는 제안하고, 사람이 승인한다.** 승인 API는 실행할 때마다 새로 만들어지는 세션 토큰이 필요하고, 이 토큰은 데스크톱 앱만 가지고 있습니다. 서브에이전트의 독립 검토 통과는 승인이 아닙니다.
- **건드리기 전에 검증한다.** 모든 수정안은 별도 워크트리에서 먼저 실행됩니다. 검증 중에 연결된 의존성 폴더에 쓰기가 일어나면 검증은 실패합니다.
- **승인한 것에 서명한다.** 승인에는 실제 파일 변경 내용의 서명된 지문이 붙고, 적용 직전에 다시 확인합니다. 하나라도 다르면 `TAMPERED`로 표시합니다.
- **"모른다"도 답이다.** 증거가 없으면 짐작으로 채우지 않고 "모름"으로 남깁니다. 실행 증거 없이는 원인을 확정하지 않습니다.
- **짐작하느니 멈춘다.** 버그를 세 번 안에 재현하지 못한 에이전트는 멈춥니다. 재현 없이 진행할지는 사용자가 이유를 적어 정합니다.
- **조작은 드러나게 한다.** 승인, 수정안, 잠긴 테스트, 감사 기록은 설치마다 만든 키로 서명됩니다. 그 키 없이 한 수정은 조용히 넘어가지 않고 드러납니다. 무엇을 막고 무엇을 못 막는지는 [위협 모델](docs/threat-model.ko.md)에 적었습니다.
- **범위는 좁히되, 답을 지어내지 않는다.** 변경 범위는 어디부터 볼지 알려줄 뿐, 어느 줄이 틀렸다고 주장하지 않습니다.
- **규칙은 프롬프트가 아니라 코드에 둔다.** 에이전트에게 주는 지시문은 보안 경계가 아닙니다.

## 현재 한계

- 같은 OS 사용자 권한으로 도는 에이전트는 로컬 서명 키를 읽을 수 있습니다. 목표는 조작을 불가능하게 하는 것이 아니라, 키 없이 한 조작이 몰래 통과하지 못하게 하는 것입니다. 자세한 내용은 [위협 모델](docs/threat-model.ko.md)에 있습니다.
- 변경 범위는 지난 체크포인트 이후 바뀐 코드만 보고, 바뀐 함수들 사이에 순위를 매기지 않습니다. 커버리지 기반 순위가 다음 목표입니다.
- 재현은 에이전트가 좋은 테스트를 쓰느냐에 달려 있습니다. 테스트하기 어려운 버그(게임 루프, UI, 통합)는 변경 범위까지만 도움을 받을 수 있습니다.
- 패키징된 앱은 Windows용이고 Electron 기반이라 용량이 큽니다.

## 문서

- [위협 모델](docs/threat-model.ko.md): 사용자 PC의 에이전트가 들키지 않고 할 수 있는 것과 없는 것
- [사례 기록](docs/case-study.ko.md): A/B 실험에서 에이전트가 승인 게이트를 넘으려고 DB를 직접 고친 일과, 그 뒤에 바뀐 것
- [성능](docs/performance.md): 대시보드 갱신 속도 측정 (영어)
- [수동 확인 절차](docs/manual-check.md): 전체 흐름을 단계별로 확인하는 방법

## 프로젝트 구조

```text
agent-autopsy/
├─ apps/desktop/                     Electron + React 대시보드
├─ packages/core/                    엔진: 체크포인트, 워크트리 실행기, 승인 게이트, SQLite, 로컬 API
│  └─ src/localization/              tree-sitter 함수 추출기, 변경 범위 분석기, AI 전달 패키지
├─ packages/mcp-server/              코딩 에이전트용 MCP 서버와 도구
├─ examples/                         예제 프로젝트
└─ docs/                             위협 모델, 사례 기록, 성능 측정 기록, 스크린샷
```

## 개발

```bash
pnpm install
pnpm run build   # 코어, MCP 서버, 데스크톱 앱
pnpm test        # 코어와 변경 범위 테스트, 임시 데이터 폴더에서 실행
```

## 로드맵

- [x] 데스크톱 앱과 MCP 서버의 로컬 저장소 통일
- [x] 서명된 승인과 변조 감지
- [x] 사용자가 확인하는 테스트 명령, 다중 언어 감지
- [x] 증거 기반 원인 확신도와 수정 위험도 판정
- [x] 언어와 무관한 증거 수집기 (오류 위치, 확정된 실행기로만 돌리는 재현 테스트)
- [x] 에이전트용 사건 기록 조회와 구조화된 다음 단계 안내
- [x] 변경 범위: 지난 체크포인트 이후 바뀐 함수와 호출 관계 (Python, JS/TS, C/C++)
- [x] 재현 테스트 게이트: 실패 이유 판정(pytest, unittest, `node:test`), 마지막 정상 체크포인트 비교, 단언 뒤집기, 테스트 잠금, 실패 3번이면 멈춤
- [x] 데스크톱 앱의 재현 생략·추가 시도 결정과, 감사 기록 옆에 남는 결정 이유
- [ ] 변경 범위 안에서 커버리지 기반 순위 (Python, JS/TS, C/C++ 순서)
- [x] 서명된 기준점이 있는 감사 기록과 수정안 서명
- [ ] 서명하지 않는 표(체크포인트, 에이전트 이벤트, 지시)의 직접 수정 감지
- [x] 더 빠른 대시보드 갱신 ([자세히](docs/performance.md))
- [ ] 영어 UI 완성

## 연락처

<table>
  <tr>
    <td align="center" width="140">
      <img src="docs/images/developer.png" alt="kimchi00100" width="110" />
    </td>
    <td valign="middle">
      <b>kimchi00100</b><br /><br />
      GitHub · <a href="https://github.com/kimchi00100">@kimchi00100</a><br />
      Discord · <code>ut8419</code>
    </td>
  </tr>
</table>

[MIT 라이선스](./LICENSE)로 배포됩니다.
