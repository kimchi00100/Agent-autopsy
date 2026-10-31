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

When you report one, the agent usually guesses, rereads half the repository, patches your files directly, and tells you it is fixed. Agent Autopsy puts a checkpoint in that loop.

| | Asking the agent again | **Agent Autopsy** |
| --- | --- | --- |
| What you reported | Paraphrased by the agent | Your original words, stored next to the agent's reading, with each intent marked as quoted or inferred |
| Where the agent looks first | Wherever it guesses, often the whole repo | The functions changed since the last checkpoint, plus their direct callers and callees |
| Proof that the bug is real | The agent says it reproduced it | A test that fails on an assertion now, compared against the last good checkpoint and an assertion-flipped twin, then locked so the fix cannot edit it |
| Where the fix is tested | In your working tree, if at all | In an isolated git worktree, before anything touches your files |
| What "verified" means | The agent says so | Syntax, target test, and full regression run separately, with logs |
| When the agent is stuck | It keeps guessing | After 3 failed reproduction attempts it stops; only you can let it continue, and your reason is recorded |
| Who decides | The agent | You, with one click in the desktop app |
| If the patch changes after approval | Nobody notices | The approval carries a signed fingerprint, re-checked before applying; a mismatch is marked `TAMPERED` |

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

If you use the packaged app, point `args` at `apps/desktop/release/win-unpacked/resources/bundled/mcp-server.cjs` instead. Restart your agent after rebuilding so it picks up new tools.

Then open your project in the desktop app and confirm its test command once. Unconfirmed commands are never run.

## What you get

**Repair Center — review, then approve.** A verified patch with its root-cause summary, three-stage verification results, and a side-by-side diff. Your original report is shown next to the agent's interpretation, with the quoted parts highlighted, so you can check it is really what you asked for. The approve button sits next to the reproduction evidence level and the patch's integrity check. Nothing is applied until you click approve.

**Incident Analysis — see where it broke.** Each bug report becomes an incident with the expected vs. observed behavior, a flow graph that separates observed evidence from inferred links, and the evidence behind every severity and risk label. If part of the report is missing, the agent is told to ask you for that item only.

<p align="center">
  <a href="docs/screenshots/incident-analysis.jpeg"><img src="docs/screenshots/incident-analysis.jpeg" alt="Incident Analysis" width="100%" /></a>
</p>

**Reproduction gate — a test that fails for the right reason.** The agent's reproduction test runs on a snapshot of your working tree. It only counts when it fails on an assertion; a crash, an import error, zero tests, or a flaky result is sent back. The same test is then run at the last good checkpoint (did this change introduce the bug?), and an assertion-flipped copy that expects today's wrong value must pass on the current code (does the test really check the reported behavior?). Only all three together are shown as strong evidence. A reproduced test is locked: a patch that edits it, or a change to it on disk, is rejected. After three failed attempts the incident is abandoned and the agent stops until you decide in the app.

**Decisions on record.** Waiving reproduction, allowing three more attempts, and acknowledging a damaged audit log are buttons in the desktop app, never MCP tools. Each one needs a written reason. The reason is stored next to an audit log entry and shown later as verified, mismatched, missing, or unverified if the log was damaged before it.

**Change Scope — where to look first.** When an incident is registered, the agent immediately gets the functions that changed since the last checkpoint and the functions that call them or are called by them, parsed with tree-sitter for Python, JavaScript/TypeScript, and C/C++. It is a search range, not a ranking and not a verdict: the agent is told to compare these functions with your report before rereading the whole repository.

**Dashboard — the project at a glance.** Build and test status, open incidents, fix success rate, git state, and the audit log check.

<p align="center">
  <a href="docs/screenshots/dashboard.jpeg"><img src="docs/screenshots/dashboard.jpeg" alt="Dashboard" width="100%" /></a>
</p>

In benchmark runs ([details](docs/performance.md)), `POST /api/overview` response time with 50 changed files went from 4,351 ms → 199 ms (median of 3 rounds), and git processes spawned while idle for 60 seconds went from 1,104 → 9. Measurement conditions (a single laptop, small sample repositories) are documented in [performance.md](docs/performance.md).

<sub>Screenshots are from a small sample project (<code>idle-rpg</code>) with one planted regression. The menus can be switched to English; the rest of the UI is Korean-first today, and full English UI is on the roadmap.</sub>

## How it works

What happens after you report a bug:

```mermaid
flowchart TD
    A[You report a bug] --> B[Incident registered<br/>your original words saved]
    B --> C{Expected, observed,<br/>repro or check missing?}
    C -- yes --> D[Agent asks you only<br/>for the missing items] --> B
    C -- no --> E[Change scope<br/>functions changed since the checkpoint]
    E --> F[Reproduction test runs<br/>on a snapshot of your working tree]
    F --> G{Failed on an assertion?}
    G -- yes --> H[REPRODUCED and locked<br/>baseline + flipped test set the evidence level]
    G -- no --> I{3 failed attempts?}
    I -- no --> F
    I -- yes --> J[Agent stops<br/>you waive or allow 3 more, with a reason]
    H --> K[Patch verified in a worktree<br/>syntax, target test, full regression]
    J -- waived --> K
    K --> L[You approve in the desktop app<br/>evidence level shown next to the button]
    L --> M[Signatures re-checked,<br/>patch applied to your files]
```

Reproduction is recommended, not mandatory: a patch for an incident without a reproduction test can still be verified, and the approval screen shows "no reproduction" next to the button. The failure-reason check currently covers pytest, unittest, and `node:test`. Failures from other runners are recorded as unverified and never count as evidence.

How the pieces connect:

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

- **MCP server** — 18 tools your agent calls: checkpoints, incidents, change scope, reproduction runs, patch proposals and verification, incident history, and structured `next_action` guidance in every response.
- **Core engine** — checkpoints, change-scope localizer, worktree runner, approval gate, and a local SQLite store.
- **Desktop app** — Electron + React. The only place a test command can be confirmed and a patch can be approved.

## Philosophy — trust evidence, not the agent's word

- **Agents propose, humans approve.** The approval API needs a per-launch session token that only the desktop app holds. An independent sub-agent review is not an approval.
- **Verify before you touch.** Every patch runs in its own worktree first. Writes into linked dependency folders during a run fail the verification.
- **Sign what you approve.** Approvals carry a signed fingerprint of the exact file changes, re-checked right before applying. Any mismatch is marked `TAMPERED`.
- **"Unknown" is an answer.** Missing evidence is reported as unknown instead of being upgraded to a guess. A cause is never marked confirmed without execution evidence.
- **Stop instead of guessing.** An agent that cannot reproduce the bug in three tries is stopped. Moving on without reproduction is your call, written down with your reason.
- **Make tampering visible.** Approvals, patches, locked tests, and the audit log are signed with a per-install key. Edits made without that key are reported, not silently accepted. See the [threat model](docs/threat-model.md) for what this does and does not cover.
- **Narrow the search, don't fake the answer.** Change scope tells the agent where to look first. It never claims which line is wrong.
- **Rules live in code, not in prompts.** Instructions to an agent are not a security boundary.

## Current limits

- An agent running as the same OS user can read the local signing key. The goal is that tampering without the key cannot pass silently, not that tampering is impossible. Details in the [threat model](docs/threat-model.md).
- Change scope only sees code changed after the last checkpoint, and it does not rank the changed functions. Coverage-based ranking is the next milestone.
- Reproduction depends on the agent writing a good test. Bugs that are hard to test (game loops, UI, integrations) may end with change scope only.
- The packaged app targets Windows and ships with Electron, so it is large.

## Docs

- [Threat model](docs/threat-model.md): what an agent on your machine can and cannot do unnoticed
- [Case study](docs/case-study.md): how an A/B run exposed an agent editing the database to get past the approval gate, and what changed
- [Performance](docs/performance.md): dashboard refresh measurements
- [Manual check](docs/manual-check.md): step-by-step checks of the full flow (Korean)

## Project layout

```text
agent-autopsy/
├─ apps/desktop/                     Electron + React dashboard
├─ packages/core/                    Engine: checkpoints, worktree runner, approval gate, SQLite, local API
│  └─ src/localization/              tree-sitter function extractor, change-scope localizer, context packer
├─ packages/mcp-server/              MCP server and tools for coding agents
├─ examples/                         Sample projects
└─ docs/                             Threat model, case study, performance notes, screenshots
```

## Development

```bash
pnpm install
pnpm run build   # core, MCP server, desktop app
pnpm test        # core and localization tests, run against a temporary data directory
```

## Roadmap

- [x] Shared local store for the desktop app and MCP server
- [x] Signed approvals and tamper detection
- [x] User-confirmed test commands with multi-language detection
- [x] Evidence-based cause certainty and change-risk scoring
- [x] Language-agnostic evidence collector (stack locations, confirmed-runner reproduction runs)
- [x] Incident history tools and structured next steps for agents
- [x] Change scope: functions changed since the last checkpoint, with callers and callees (Python, JS/TS, C/C++)
- [x] Reproduction test gate: failure-reason check (pytest, unittest, `node:test`), last-good-checkpoint comparison, assertion flip, test lock, stop after 3 failed attempts
- [x] Waive and retry decisions in the desktop app, with reasons kept next to the audit log
- [ ] Coverage-based ranking inside the change scope (Python, then JS/TS, then C/C++)
- [x] Tamper-evident audit log with a signed head anchor, and signed patch proposals
- [ ] Detection of direct writes to tables that are not signed (checkpoints, agent events, directives)
- [x] Faster dashboard refresh ([details](docs/performance.md))
- [ ] Full English UI

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
