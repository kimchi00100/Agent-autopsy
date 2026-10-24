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
  <a href="#주요-화면">주요 화면</a> ·
  <a href="#동작-방식">동작 방식</a> ·
  <a href="#철학--에이전트의-말이-아니라-증거를-믿는다">철학</a> ·
  <a href="#로드맵">로드맵</a> ·
  <a href="#연락처">연락처</a>
</p>

---

## 왜 Agent Autopsy인가

> *"모든 테스트를 통과했습니다."* — 기능이 여전히 안 되는데 코딩 에이전트가 늘 하는 말

AI 코딩 에이전트는 컴파일되는 코드를 잘 만듭니다. 정말 골치 아픈 버그는 **돌아가지만 틀리게 동작하는** 버그입니다. 자동 사냥이 사거리 끝의 몬스터를 안 때리고, 10% 할인이 10원 차감으로 처리되고, 저장 파일에서 아이템이 조용히 사라집니다.

이런 버그를 신고하면 에이전트는 대개 짐작으로 원본 파일을 바로 고치고 "해결했다"고 말합니다. Agent Autopsy는 그 사이에 검문소를 둡니다.

| | 에이전트에게 다시 부탁하기 | **Agent Autopsy** |
| --- | --- | --- |
| 수정을 시험하는 곳 | 작업 중인 원본 폴더, 그마저도 안 할 때가 많음 | 원본을 건드리기 전, 격리된 git 워크트리 |
| "검증됨"의 의미 | 에이전트가 그렇다고 말함 | 문법, 대상 테스트, 전체 회귀 테스트를 따로 실행하고 로그를 남김 |
| 결정하는 사람 | 에이전트 | 사용자. 데스크톱 앱에서 클릭 한 번 |
| 누가 몰래 조작하면 | 아무도 모름 | 승인에 서명이 붙어 있어서, DB 수정, 수정안 바꿔치기, 가짜 테스트 명령을 막음 |
| 확인할 수 있는 것 | 채팅 메시지 한 줄 | 사건, 증거, 좌우 비교 Diff, 검증에 쓴 실제 명령 |

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

그다음 데스크톱 앱에서 프로젝트를 열고 테스트 명령을 한 번 확인해 주세요. 확인하지 않은 명령은 절대 실행되지 않습니다.

## 주요 화면

**복구 센터: 확인하고 승인하기.** 검증된 수정안의 원인 분석 요약, 3단계 검증 결과, 좌우 비교 Diff를 보여줍니다. 승인 버튼을 누르기 전에는 아무것도 적용되지 않습니다.

**사건 분석: 어디서 깨졌는지 보기.** 버그 신고는 사건으로 등록됩니다. 기대 동작과 실제 동작, 관찰된 증거와 추론된 연결을 구분한 흐름도, 원인 후보 순위를 보여줍니다.

<p align="center">
  <a href="docs/screenshots/incident-analysis.jpeg"><img src="docs/screenshots/incident-analysis.jpeg" alt="사건 분석" width="100%" /></a>
</p>

**대시보드: 프로젝트를 한눈에.** 빌드·테스트 상태, 미해결 사건, 수정 성공률, git 상태를 보여줍니다.

<p align="center">
  <a href="docs/screenshots/dashboard.jpeg"><img src="docs/screenshots/dashboard.jpeg" alt="대시보드" width="100%" /></a>
</p>

<sub>스크린샷은 예제 프로젝트(<code>idle-rpg</code>)로 찍었습니다.</sub>

## 동작 방식

```text
+--------------+   MCP    +---------------------- Agent Autopsy (local) -------+
| Coding agent | -------> |                                                    |
|  (proposes)  |          |   incident --> evidence --> patch                  |
+--------------+          |                               |                    |
                          |                               v                    |
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

- **MCP 서버**: 에이전트가 호출하는 도구입니다. 사건 등록, 수정안 제안과 검증, 테스트 명령 제안을 맡습니다.
- **코어 엔진**: 체크포인트, 워크트리 실행기, 승인 게이트, 로컬 SQLite 저장소입니다.
- **데스크톱 앱**: Electron + React. 수정안을 승인할 수 있는 유일한 곳입니다.

## 철학 — 에이전트의 말이 아니라 증거를 믿는다

- **에이전트는 제안하고, 사람이 승인한다.** 승인 API는 실행할 때마다 새로 만들어지는 세션 토큰이 필요하고, 이 토큰은 데스크톱 앱만 가지고 있습니다.
- **건드리기 전에 검증한다.** 모든 수정안은 별도 워크트리에서 먼저 실행됩니다. 검증 중에 연결된 의존성 폴더에 쓰기가 일어나면 검증은 실패합니다.
- **승인한 것에 서명한다.** 승인에는 실제 파일 변경 내용의 서명된 지문이 붙고, 적용 직전에 다시 확인합니다. 하나라도 다르면 `TAMPERED`로 표시합니다.
- **"모른다"도 답이다.** 증거가 없으면 짐작으로 채우지 않고 "모름"으로 남깁니다.
- **규칙은 프롬프트가 아니라 코드에 둔다.** 에이전트에게 주는 지시문은 보안 경계가 아닙니다.

## 프로젝트 구조

```text
agent-autopsy/
├─ apps/desktop/          Electron + React 대시보드
├─ packages/core/         엔진: 체크포인트, 워크트리 실행기, 승인 게이트, SQLite, 로컬 API
├─ packages/mcp-server/   코딩 에이전트용 MCP 도구
├─ examples/              예제 프로젝트
└─ docs/                  스크린샷과 이미지
```

## 개발

```bash
pnpm install
pnpm run build   # 코어, MCP 서버, 데스크톱 앱
pnpm test        # 코어 통합 테스트
```

## 로드맵

- [x] 데스크톱 앱과 MCP 서버의 로컬 저장소 통일
- [x] 서명된 승인과 변조 감지
- [x] 사용자가 확인하는 테스트 명령, 다중 언어 감지
- [ ] 증거 기반 원인 확신도와 수정 위험도 판정
- [ ] 언어와 무관한 증거 수집기 (오류 위치, 재현 테스트, 필요할 때 커버리지)
- [ ] 에이전트용 사건 기록 조회와 다음 단계 안내
- [ ] 더 빠른 대시보드, 영어 UI 완성

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
