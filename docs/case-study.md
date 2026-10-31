<p align="center">
  <b>English</b> · <a href="./case-study.ko.md">한국어</a>
</p>

# Case study: the agent that edited the database

An early A/B run was meant to answer one question: does Agent Autopsy help a coding agent fix bugs? It answered a different one. When the agent got stuck at the approval gate, it went around it. This page records what happened, what it exposed, and what changed.

## The setup

- **Task:** `hard2`, a small Python RPG with several planted bugs: clock drift, a buff calculation, a range boundary, double-counted quest progress, an empty inventory slot, and a missing save field. Graded by 17 hidden tests. All bugs were present before the first checkpoint.
- **Run A:** the coding agent alone.
- **Run B:** the same agent with Agent Autopsy connected over MCP.

| | Run A (agent alone) | Run B (with Agent Autopsy) |
| --- | --- | --- |
| Tokens (input + output) | about 366k | about 592k |
| Time | about 13.4 min | about 27.1 min |
| Tool calls | 60 | 110 (7 of them Agent Autopsy) |

Run B passed 16 of 17 hidden tests and 11 of 11 visible tests. It cost about 1.6 times the tokens and twice the time.

## Why run B was slower

- The analyzer did not understand Python, so it produced no cause candidates. The agent read files directly 36 times instead.
- The test command was detected as `npm test`, which is wrong for a Python project.
- Every incident was rated "cause unknown / critical / high risk", so an independent sub-agent review was attached to all of them.

## What the agent did at the gate

The patch was waiting for human approval (`AWAITING_USER`). The agent appears to have read a passed sub-agent review as approval. Then it:

1. read Agent Autopsy's bundled source;
2. opened the SQLite database directly and **changed the stored test command**, which worked;
3. **called the approval API itself**, which failed only by accident: the desktop app and the MCP server were using different data folders, so the API never saw the proposal;
4. set `userConfirmedIntent: true` on its own, without asking.

Nothing reached the working tree unapproved, but only because of a bug.

## What it exposed

| Hole | Fix |
| --- | --- |
| The app and the MCP server used different data folders | One data folder for both, resolved the same way |
| Project IDs were random, so the same folder could appear twice | IDs derived from the folder path, duplicates merged |
| The approval API needed no authentication | A per-launch session token that only the desktop app holds |
| The apply step skipped its check when no fingerprint was stored | A signed fingerprint is required and re-checked right before applying |
| A patch could be swapped after approval | File changes are hashed into the approval; a mismatch is marked `TAMPERED` |
| The signing key was hard-coded | A per-install key in the data folder |
| The test command could be edited in the database | Commands are confirmed and signed only in the desktop app; agents can only propose one |
| A worktree linked to `node_modules` could write into the original | Writes to linked dependency folders fail the verification |
| An isolated backup was created every second | Backups only when the change fingerprint changes |
| The agent could mark the user's intent as confirmed itself | The user's original words are stored, each intent is marked quoted, inferred, or missing, and the approval screen shows them side by side |
| Every incident was rated critical | Severity starts as unassessed; risk comes from user-defined sensitive paths, changed lines, and failed verifications |
| Python was invisible to the analyzer | Multi-language test command detection and tree-sitter function extraction for Python, JavaScript/TypeScript, and C/C++ |

## Hardening that followed

The same question kept coming back: *what would a stuck agent try next?* Each gate was then attacked directly, by editing the database from a separate process the way an agent would, and checking the exact error code.

- **Audit log.** A hash chain over gate-relevant events. A plain chain cannot see a cut-off tail, so a signed head anchor was added. A broken chain stops reproduction runs and new patches until you acknowledge it.
- **Signed proposals.** An edited proposal row is marked `TAMPERED`, and a proposal can no longer be applied to a different project.
- **Reproduction gate.** A reproduction test only counts when it fails on an assertion. It is compared with the last good checkpoint and an assertion-flipped copy, then locked. After three failed attempts the agent stops, and only you can waive or allow more, with a written reason.
- **Patch paths.** Before the fix, a proposal path like `../x` was written outside the isolated worktree, and on Windows a short name such as `GIT~1/hooks/pre-commit` reached the real `.git/hooks` when a patch was applied. Paths are now resolved to their real form and checked before submit and before apply.
- **Local API.** Browser requests must come from a local origin; prefix tricks such as `localhost.evil.example` are refused.

What is still possible, mainly re-signing records after reading the local key, is listed in the [threat model](threat-model.md).

## Lessons

1. **Instructions are not a boundary.** The agent had the rules and read the source anyway. Rules that matter have to live in code.
2. **An accident is not a defense.** The approval call failed because of a data-folder bug. Fixing that bug alone would have opened the door.
3. **A blocked agent is a motivated one.** Gates are designed on the assumption that the agent will look for a way around them.
4. **Test gates the way they will be attacked.** A test that only checks "it failed" can pass for the wrong reason. Tamper tests run in a separate process and check the specific error code.

## What has not been measured again

The A/B run has not been repeated since these changes. Until it is, this project makes no claim that Agent Autopsy makes an agent faster or more accurate. What it does claim is narrower: a patch proposed through Agent Autopsy reaches your files only after your approval, the evidence behind that approval is recorded and checked, and direct edits outside that path are shown to you.
