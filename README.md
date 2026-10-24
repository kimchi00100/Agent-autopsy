<div align="center">

<img src="docs/images/banner.svg" alt="Agent Autopsy" width="100%" />

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](./LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-ready-111827?style=for-the-badge)
![Windows](https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)

### Stop guessing. Prove the fix. Approve what lands.

Agent Autopsy sits between your AI coding agent and your code.<br />
It turns bug reports into incidents, verifies every patch in isolation,<br />
and lets **only human-approved changes** reach your working tree.

[Features](#-features) · [How it works](#-how-it-works) · [Quick start](#-quick-start) · [Roadmap](#-roadmap)

</div>

<br />

## ✨ Features

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>🔬 Evidence first</h3>
      Bug reports become tracked incidents with test results and error context, so fixes start from facts instead of guesses.
    </td>
    <td width="33%" valign="top">
      <h3>🧪 Isolated verification</h3>
      Every patch is tested in a separate git worktree before it can touch your real files.
    </td>
    <td width="33%" valign="top">
      <h3>🔐 Human approval gate</h3>
      Agents can only propose. Approving a patch takes a click in the desktop app, backed by a session token the agent never sees.
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <h3>🛡️ Tamper detection</h3>
      Approvals are signed and re-checked at apply time. Edited databases, swapped patches, and faked test commands are caught and blocked.
    </td>
    <td width="33%" valign="top">
      <h3>🌐 Any language</h3>
      Runs your project's own tests: <code>pytest</code>, <code>unittest</code>, <code>ctest</code>, <code>go test</code>, <code>cargo test</code>, npm scripts, and more.
    </td>
    <td width="33%" valign="top">
      <h3>🧩 Works with your agent</h3>
      Plugs into Antigravity, Claude Code, Codex, and other MCP clients. No extra model or API key.
    </td>
  </tr>
</table>

## 🔁 How it works

```mermaid
flowchart LR
    A(["🐞 Bug report"]) --> B["📋 Incident"]
    B --> C["🔬 Evidence"]
    C --> D["🛠️ Patch"]
    D --> E["🧪 Worktree<br/>verification"]
    E --> F{"👤 Approve?"}
    F -- "yes" --> G(["✅ Applied"])
    F -- "no" --> H(["↩️ Discarded"])

    classDef step fill:#0f172a,stroke:#334155,color:#e2e8f0
    classDef gate fill:#422006,stroke:#f59e0b,color:#fde68a
    classDef ok fill:#052e2b,stroke:#34d399,color:#a7f3d0
    classDef no fill:#2a0f12,stroke:#f87171,color:#fecaca
    class A,B,C,D,E step
    class F gate
    class G ok
    class H no
```

<details>
<summary><b>Architecture</b></summary>
<br />

```mermaid
flowchart LR
    Agent["🤖 AI coding agent"] <-->|MCP| MCP["MCP server"]
    MCP --> Core["⚙️ Core engine"]
    Core <--> DB[("SQLite")]
    Core --> WT["🧪 Isolated worktree"]
    Core -->|approved only| Repo["📁 Your project"]
    App["🖥️ Desktop app"] <-->|token-authenticated API| Core

    classDef node fill:#0f172a,stroke:#334155,color:#e2e8f0
    class Agent,MCP,Core,DB,WT,Repo,App node
```

Everything runs locally. No cloud service is involved.

</details>

## 🚀 Quick start

**Requirements:** Node.js 22.5+ · pnpm · Git 2.40+ · Windows (desktop app)

```bash
git clone https://github.com/kimchi00100/agent-autopsy.git
cd agent-autopsy
pnpm install
pnpm run build

pnpm run desktop      # run the desktop app
pnpm run build:exe    # package a standalone Windows build
```

<details>
<summary><b>Connect your agent (MCP)</b></summary>
<br />

Add this to your agent's MCP configuration:

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

Then open your project in the desktop app and confirm its test command once.

</details>

## 🗺️ Roadmap

- [x] Shared local data store for the app and MCP server
- [x] Signed approvals and tamper detection
- [x] User-confirmed test commands with multi-language detection
- [ ] Evidence-based cause and risk scoring
- [ ] Language-agnostic evidence collector (stack locations, repro tests, coverage)
- [ ] Incident history tools and guided next steps for agents
- [ ] Faster desktop dashboard

## 🧰 Tech stack

![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/-Node.js-339933?logo=nodedotjs&logoColor=white)
![Electron](https://img.shields.io/badge/-Electron-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/-React-20232A?logo=react&logoColor=61DAFB)
![Tailwind CSS](https://img.shields.io/badge/-Tailwind%20CSS-06B6D4?logo=tailwindcss&logoColor=white)
![SQLite](https://img.shields.io/badge/-SQLite-003B57?logo=sqlite&logoColor=white)
![Git](https://img.shields.io/badge/-Git%20worktree-F05032?logo=git&logoColor=white)

## 👤 Developer

<table>
  <tr>
    <td align="center" width="140">
      <img src="docs/images/developer.png" alt="kimchi00100" width="110" />
    </td>
    <td valign="middle">
      <b>kimchi00100</b><br /><br />
      <a href="https://github.com/kimchi00100"><img src="https://img.shields.io/badge/GitHub-kimchi00100-181717?logo=github&logoColor=white" alt="GitHub" /></a><br />
      <img src="https://img.shields.io/badge/Discord-ut8419-5865F2?logo=discord&logoColor=white" alt="Discord: ut8419" />
    </td>
  </tr>
</table>

## 📄 License

Released under the [MIT License](./LICENSE).
