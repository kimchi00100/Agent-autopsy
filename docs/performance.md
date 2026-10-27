# Performance: Before and After

This page records how the desktop app's background refresh got faster, and how it was measured.

## Summary

Medians of 3 rounds. "Before" is commit `908b33b`, "After" is commit `0dd56f3`.

| Metric | No changes (S0) | 50 changed files (S50) |
| --- | --- | --- |
| `POST /api/overview` response | 380 ms → **90 ms** | 4,351 ms → **199 ms** |
| git processes per overview | 5 → **2** | 55 → **3** |
| git processes while idle (60 s) | 504 → **6** | 1,104 → **9** |
| `GET /api/agents` worst delay while idle | 658 ms → **5 ms** | 36,895 ms → **6 ms** |

The biggest gain is when an agent has left many uncommitted files. Before, every refresh ran one `git diff` per changed file, synchronously, so the local backend stopped answering other requests for seconds at a time.

## What changed

| Stage | Commit | Change |
| --- | --- | --- |
| Before | `908b33b` | UI refreshed on a 2.5 s poll plus an unconditional 1.5 s `db_sync` event. Every refresh also ran project diagnostics. All git calls were synchronous. |
| 2 | `b4fd68c` | Refreshes no longer overlap. Diagnostics run only when the Settings screen opens or on request. |
| 3 | `0a554f1` | `db_sync` is sent only when `PRAGMA data_version` shows another process wrote to the database. The poll is now a 20 s fallback. |
| 4 | `b87bf3b`, `80a37dc`, `243c017`, `0dd56f3` | `/api/overview` runs git asynchronously. Per-file `git diff` calls are batched (with a per-file fallback if a batch fails). Repository root and recent commits are cached; `git status` and `git diff` are never cached. Non-ASCII file names are read correctly (`core.quotepath=false`). |

## Method

- Each commit was checked out into a temporary `git worktree`, built, and its backend (`server-cli`) started with temporary data and cache folders.
- A script called the same endpoints, with the same HTTP methods, as the desktop app (`apps/desktop/src/api.ts`). Every response was checked to be HTTP 200.
- git processes were counted by putting a small logging wrapper in front of `git.exe` on `PATH`. The wrapper was checked to pass a 50-file `git diff` command line through without truncation.
- The four commits were measured in turn (before → 2 → 3 → 4), three rounds. Tables use the median of the three rounds.
- Two measurements in round 2 overlapped with the laptop going to sleep. They were discarded and measured again under the same conditions.

Scenarios:

- **S0**: a small repository with no uncommitted changes.
- **S50**: 50 files that are listed in the latest checkpoint and were modified again after it, so the unapproved-change check has to compare them against the checkpoint.

Measurements:

- **M1**: each endpoint called 25 times (min / median / max).
- **M2**: 60 s idle, imitating that commit's front-end refresh behaviour, with `GET /api/agents` probed once per second.
- **M3**: `GET /api/agents` probed every 10 ms while a single overview request runs.
- **M4**: git processes started by one overview request.

Environment: Windows 11 laptop, Node.js 24.20.0, Git 2.55.0 (MinGit).

## Results

### S0: no uncommitted changes

M1, response time median (ms)

| Endpoint | Before | Stage 2 | Stage 3 | Stage 4 |
| --- | --- | --- | --- | --- |
| `POST /api/overview` | 379.72 | 388.01 | 401.32 | **90.21** |
| `POST /api/projects/:id/diagnose` | 235.77 | 242.63 | 258.08 | **100.79** |
| `GET /api/projects/:id/timeline` | 1.64 | 1.34 | 1.77 | 1.74 |
| `GET /api/projects/:id/incidents` | 0.93 | 1.09 | 0.72 | 1.36 |
| `GET /api/projects/:id/checkpoints` | 0.92 | 0.89 | 0.84 | 1.04 |
| `GET /api/agents` | 1.38 | 1.25 | 1.47 | 1.54 |

M2, 60 s idle

| Item | Before | Stage 2 | Stage 3 | Stage 4 |
| --- | --- | --- | --- | --- |
| Refreshes completed | 63 | 63 | 3 | 3 |
| API calls | 378 | 315 | 15 | 15 |
| git processes | 504 | 315 | 15 | **6** |
| `/api/agents` median / max (ms) | 107.71 / 657.66 | 2.78 / 423.67 | 3.01 / 206.81 | **3.03 / 5.06** |

M3, during one overview request

| Item | Before | Stage 2 | Stage 3 | Stage 4 |
| --- | --- | --- | --- | --- |
| Overview response (ms) | 407.67 | 397.73 | 330.91 | **97.31** |
| Probes completed | 2 | 2 | 2 | 7 |
| Probe median / max (ms) | 192.36 / 381.39 | 194.84 / 386.35 | 157.49 / 312.77 | **1.92 / 2.83** |

M4, git processes per overview: 5 / 5 / 5 / **2**

### S50: 50 changed files

M1, response time median (ms)

| Endpoint | Before | Stage 2 | Stage 3 | Stage 4 |
| --- | --- | --- | --- | --- |
| `POST /api/overview` | 4,351.39 | 4,413.20 | 4,626.46 | **198.64** |
| `POST /api/projects/:id/diagnose` | 241.37 | 260.83 | 255.68 | **99.68** |
| `GET /api/projects/:id/timeline` | 1.80 | 1.99 | 2.60 | 1.80 |
| `GET /api/projects/:id/incidents` | 1.05 | 1.07 | 1.20 | 0.92 |
| `GET /api/projects/:id/checkpoints` | 0.71 | 0.97 | 0.90 | 0.81 |
| `GET /api/agents` | 1.42 | 1.54 | 1.18 | 1.60 |

M2, 60 s idle

| Item | Before | Stage 2 | Stage 3 | Stage 4 |
| --- | --- | --- | --- | --- |
| Refreshes completed | 8 | 13 | 3 | 3 |
| API calls | 106 | 65 | 15 | 15 |
| git processes | 1,104 | 715 | 165 | **9** |
| `/api/agents` median / max (ms) | 10,158.40 / 36,895.19 | 3,582.57 / 3,998.82 | 3.11 / 4,515.39 | **3.09 / 5.58** |

M3, during one overview request

| Item | Before | Stage 2 | Stage 3 | Stage 4 |
| --- | --- | --- | --- | --- |
| Overview response (ms) | 4,386.89 | 4,475.06 | 4,501.86 | **201.53** |
| Probes completed | 2 | 2 | 2 | 12 |
| Probe median / max (ms) | 2,185.14 / 4,364.93 | 2,229.45 / 4,452.38 | 2,243.29 / 4,480.29 | **2.24 / 8.32** |

M4, git processes per overview: 55 / 55 / 55 / **3**

## Limitations

- The front end was imitated by a script. The Electron renderer (React re-rendering) was not measured.
- The sample repositories are small. Large repositories were not measured.
- The git-counting wrapper adds one extra process start per git call, so absolute times are slightly higher than without it. All four commits were measured with the same wrapper.
- Backend CPU time does not include the git child processes, so it is not reported here.
- One laptop, one run of three rounds. Numbers vary with machine load.
