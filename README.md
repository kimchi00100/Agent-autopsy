<p align="center">
  <b>English</b> · <a href="./README.ko.md">한국어</a>
</p>

<h1 align="center">Agent Autopsy</h1>

<p align="center">
  <b>Your AI agent proposes. You approve. Nothing else lands.</b>
</p>

<p align="center">
  <a href="docs/screenshots/repair-center.jpeg"><img src="docs/screenshots/repair-center.jpeg" alt="Repair Center: a verified patch waiting for human approval" width="100%" /></a>
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
  <a href="#why-agent-autopsy">Why</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#philosophy--trust-evidence-not-the-agents-word">Philosophy</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#contact">Contact</a>
</p>

---

## Why Agent Autopsy

> *"All tests pass."* — every coding agent, right before the feature still doesn't work.

AI coding agents are great at code that compiles. The painful bugs are the ones that **run but do the wrong thing**: auto-hunt stops attacking at the edge of its range, a discount subtracts 10 won instead of 10%, a save file quietly drops items.

When you report one, the agent usually guesses, patches your files directly, and tells you it is fixed. Agent Autopsy puts a checkpoint in that loop.

| | Asking the agent again | **Agent Autopsy** |
| --- | --- | --- |
| Where the fix is tested | In your working tree, if at all | In an isolated git worktree, before anything touches your files |
| What "verified" means | The agent says so | Syntax, target test, and full regression run separately, with logs |
| Who decides | The agent | You, with one click in the desktop app |
| If something is tampered with | Nobody notices | The approval is signed; edits, swapped patches, and faked test commands are blocked |
| What you can review | A chat message | Incident, evidence, side-by-side diff, and the exact command used to verify |

## Quickstart

```bash
# 1. Build
git clone https://github.com/kimchi00100/agent-autopsy.git
cd agent-autopsy
pnpm install
pnpm run build

# 2. Run the desktop app
pnpm run desktop

# 3. Or package a standalone Windows build
pnpm run build:exe   # -> apps/desktop/release/win-unpacked/AgentAutopsy.exe
```

Requires Node.js 22.5+, pnpm, and Git 2.40+. The packaged app targets Windows.

### Connect your agent

Add Agent Autopsy to your agent's MCP config (Antigravity, Claude Code, Codex, or any MCP client):

```json
{
  "mcpServers": {
    "agent-autopsy": {
      "command": "node",
      "args": ["<install path>/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Then open your project in the desktop app and confirm its test command once. Unconfirmed commands are never run.

## What you get

**Repair Center — review, then approve.** A verified patch with its root-cause summary, three-stage verification results, and a side-by-side diff. Nothing is applied until you click approve.

**Incident Analysis — see where it broke.** Each bug report becomes an incident with the expected vs. observed behavior, a flow graph that separates observed evidence from inferred links, and ranked cause candidates.

<p align="center">
  <a href="docs/screenshots/incident-analysis.jpeg"><img src="docs/screenshots/incident-analysis.jpeg" alt="Incident Analysis" width="100%" /></a>
</p>

**Dashboard — the project at a glance.** Build and test status, open incidents, fix success rate, and git state.

<p align="center">
  <a href="docs/screenshots/dashboard.jpeg"><img src="docs/screenshots/dashboard.jpeg" alt="Dashboard" width="100%" /></a>
</p>

<sub>Screenshots are from a sample project (<code>idle-rpg</code>). The dashboard UI is Korean-first today; full English UI is on the roadmap.</sub>

## How it works

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

- **MCP server** — the tools your agent calls: register incidents, propose and verify patches, propose test commands.
- **Core engine** — checkpoints, worktree runner, approval gate, and a local SQLite store.
- **Desktop app** — Electron + React. The only place a patch can be approved.

## Philosophy — trust evidence, not the agent's word

- **Agents propose, humans approve.** The approval API needs a per-launch session token that only the desktop app holds.
- **Verify before you touch.** Every patch runs in its own worktree first. Writes into linked dependency folders during a run fail the verification.
- **Sign what you approve.** Approvals carry a signed fingerprint of the exact file changes, re-checked right before applying. Any mismatch is marked `TAMPERED`.
- **"Unknown" is an answer.** Missing evidence is reported as unknown instead of being upgraded to a guess.
- **Rules live in code, not in prompts.** Instructions to an agent are not a security boundary.

## Project layout

```text
agent-autopsy/
├─ apps/desktop/          Electron + React dashboard
├─ packages/core/         Engine: checkpoints, worktree runner, approval gate, SQLite, local API
├─ packages/mcp-server/   MCP tools for coding agents
├─ examples/              Sample projects
└─ docs/                  Screenshots and images
```

## Development

```bash
pnpm install
pnpm run build   # core, MCP server, desktop app
pnpm test        # core integration tests
```

## Roadmap

- [x] Shared local store for the desktop app and MCP server
- [x] Signed approvals and tamper detection
- [x] User-confirmed test commands with multi-language detection
- [ ] Evidence-based cause and change-risk scoring
- [ ] Language-agnostic evidence collector (stack locations, repro tests, coverage on demand)
- [ ] Incident history tools and guided next steps for agents
- [ ] Faster dashboard and full English UI

## Contact

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

Released under the [MIT License](./LICENSE).
