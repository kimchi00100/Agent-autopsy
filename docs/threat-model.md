<p align="center">
  <b>English</b> · <a href="./threat-model.ko.md">한국어</a>
</p>

# Threat model

Agent Autopsy sits between a coding agent and your files. This page states what it protects, who it protects against, which controls exist, and where they stop.

## Who the attacker is

The main threat is **the coding agent itself**, running on your machine as your OS user. It can:

- run shell commands, read and write files, and read Agent Autopsy's own source and bundles;
- open the local SQLite database directly and edit any row;
- call the local HTTP API on `127.0.0.1`.

The expected motive is not malice but impatience: an agent blocked at a gate tries to get past it. This is not hypothetical. In an early A/B run an agent did exactly that ([case study](case-study.md)).

Out of scope: malware with administrator rights, attackers on the network (the API only listens on `127.0.0.1`), and a user who approves without reading.

## Design goal

> **Anything the agent can do without the signing key is either blocked or shown to you.**
> Forging records with the key is a documented limit, not something the design claims to stop.

Each install creates its own signing key (`.auth_secret` in the data folder). Approvals, patches, the test command, locked reproduction tests, and the audit log are signed with it (HMAC-SHA256). When a new bypass is found, the first question is: *can it be done without the key?* If yes, it gets fixed. If no, it is written down here.

## Controls

| What the agent might try | What happens | Where |
| --- | --- | --- |
| Call the approval API itself | Rejected (401). Approving needs a per-launch session token that only the desktop app holds and that is never written to disk. | `api-server.ts`, `electron/main.cjs` |
| Edit the test command in the database | The command is signed when you confirm it in the app. An edited or unsigned command is never run (`BLOCKED_TEST_COMMAND_UNCONFIRMED`). | `incident.ts`, `project.ts` |
| Swap the patch after you approved it | The approval carries a signed fingerprint of the exact file changes, re-checked right before applying. A mismatch is marked `TAMPERED`. | `repair.ts` |
| Edit a stored patch proposal | Each proposal row is signed. An edited row is marked `TAMPERED`; an unsigned row (`LEGACY_UNSIGNED`) cannot be approved. A patch from another project is refused (`PROJECT_MISMATCH`). | `repair.ts`, `database.ts` |
| Write outside the repository through a patch | Paths are checked before submit and again before apply: absolute paths, `..`, `.git`, drive or stream colons, junctions, symbolic links, and Windows short names (`GIT~1`) are refused (`INVALID_FILE_PATH`). | `utils/paths.ts` |
| Touch your files while "verifying" | Every patch runs in its own git worktree first. Writes into linked dependency folders during a run fail the verification. | `worktree-runner.ts` |
| Make the fix pass by editing the reproduction test | A reproduced test is locked with a signed hash. A patch that edits it is refused (`REPAIR_MODIFIES_LOCKED_TEST`), a change on disk is refused (`LOCKED_TEST_MODIFIED`), and removing the lock is detected from the audit log (`LOCK_REMOVED`). | `repair.ts`, `reproduction.ts` |
| Keep retrying a test that never reproduces the bug | After three failed attempts the incident is abandoned. The gate is computed from audit log entries, not from a status column, so editing the stored status does not unlock it. | `reproduction.ts` |
| Waive reproduction or grant more attempts itself | These are buttons in the desktop app (token required), never MCP tools. Each needs a written reason. | `api-server.ts`, `DecisionModal.tsx` |
| Edit, delete, reorder, or cut off audit log entries | Entries form an HMAC hash chain, and a signed head anchor (`audit_head.json`) records the last entry, so a cut-off tail is caught too. A broken chain stops reproduction runs and new patches until you acknowledge it in the app; incidents from before the break then need a fresh decision. | `database.ts` |
| Rewrite the reason you gave for a decision | The reason is stored next to the audit entry it belongs to and checked against that entry's hash. It is shown as verified, mismatched, missing, or unverified (when the log was damaged before it). | `database.ts` |
| Edit your working tree directly instead of proposing a patch | Not blocked. Changes since the last checkpoint are detected and shown as unapproved direct edits. | `project.ts`, `IncidentAnalysisView.tsx` |
| Call the API from a web page | The API listens on `127.0.0.1` only. Browser requests must come from a local origin (`127.0.0.1`, `localhost`, `[::1]`, the app itself). | `api-server.ts` |

Most of these cases have a test in `packages/core/test` that edits the database from a **separate process** (the way an agent would) and checks the exact error code, not just that something failed.

## Known limits

These are accepted, not fixed:

- **The signing key is readable.** An agent running as your OS user can read `.auth_secret` and re-sign anything: proposals, locks, the whole audit chain, and the head anchor. The controls above then no longer detect the change.
- **Deleting everything at once.** Removing the entire audit log together with the head anchor is not distinguishable from a fresh install.
- **The session token lives in memory.** It is kept by the desktop app and passed to its backend process at launch. Another process running as the same user can, in principle, read process memory or environment. This has not been tested.
- **Some API routes need no token.** Running a reproduction, reading the overview, posting agent events, submitting a sub-agent review, and applying a patch you already approved can be called by any local process. None of them can approve a patch, confirm a test command, or make a reproduction decision.
- **Your report can be invented.** The agent submits your original words (`userReportText`). The approval screen shows them next to the agent's interpretation; checking that they are really yours is your job.
- **Unsigned tables.** Checkpoints, agent events, and directives are not signed, so direct writes to them are not detected.
- **No sandbox.** Agent Autopsy does not restrict the agent's own shell. It shows direct edits; it does not stop them.
- **False alarms.** The dependency-folder watch also notices writes by other programs (for example your own `npm install` during a run).
- **Platform.** The path checks and tamper tests are run on Windows. On Linux, file names containing `:` are refused even though they are legal there.
