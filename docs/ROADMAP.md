# Pomni Roadmap

Each milestone is shippable on its own and leaves Pomni usable. Nothing later requires
rewriting anything earlier — the ports/adapters split in `ARCHITECTURE.md` is what buys that.

---

## M0a — Projects and repos — **shipped**

**Goal:** create a project and attach the repos it is built from.

- npm workspaces monorepo: `core`, `infra`, `adapters`, `cli`, `server`, `web`
- Domain: `Project`, `Repo`, `RepoSource`, `Capability`, `Credential` with zod schemas
- `FileDocStore` — atomic writes, `rev` hashes, `If-Match`, `mustNotExist`, path-escape guard
- `GitCli` — clone/fetch/info with `GIT_ASKPASS` token auth, inherited credential helpers
  disabled, `GIT_TERMINAL_PROMPT=0`, output redaction, plain-language failure messages
- `DefaultCredentialStore` — env var, `gh auth token`, or a gitignored 0600 file
- Stack detection: Node (package manager, framework, scripts), Python, Go, Rust, Makefile
- CLI: `init`, `project create|list|show|remove`, `repo add|list|show|sync|remove`,
  `cred add|list|test|remove`, `serve`
- HTTP API and React SPA for all of the above, including a directory picker and a
  detection preview
- 43 tests: domain units, service integration against a real doc store with a fake git,
  and API tests through `fastify.inject`

---

## M0b — Runs — **shipped**

**Goal:** run a repo's own tests through Pomni, with the run on record.

- `Run` domain with a `Gate` that fans out across repos; ULID ids
- `ProcessExecutor` — platform shell, streamed output, timeouts, Windows tree-kill
- `SqliteRunStore` on Node's built-in `node:sqlite` (WAL, numbered migrations, no native
  module to compile)
- `pomni run <capability>`, plus `test` / `build` / `lint` / `typecheck` / `e2e` / `install`
  shorthands and `pomni verify` for the whole gate
- `pomni runs list | show | tail | cancel`; per-run log files under `.pomni/runs/<id>/`
- Output summarizers for vitest, jest, pytest, cargo, go, tsc and eslint, so a run reports
  "1 failed, 11 passed" without the repo configuring a reporter; junit ingestion when a
  capability opts in with `parser: junit` and `reportPath`
- `FileEventSink` / `FileEventSource` — the cross-process `.pomni/events.ndjson` stream, so
  a run started in a terminal appears live in the browser
- `pomni repo doctor`: resolves every declared capability's executable on PATH
- Server: `POST /api/runs`, `POST /api/projects/:id/verify`, `GET /api/runs/:id/log` (SSE),
  `GET /api/projects/:id/doctor`; run list, run detail and live log in the UI
- 26 more tests (69 total)

---

## M1 — Backlog — **shipped**

**Goal:** items live in the repo, readable by humans and editable by agents.

- `BacklogItem` domain, status state machine, and per-transition guards
- Markdown frontmatter codec in `FileDocStore`: the body is one opaque string, so the
  round-trip is byte-exact and an agent's formatting survives
- Per-project id counters behind `FileLock` (`.pomni/.lock`), dependency edges with cycle
  detection, sparse `order` ranks
- `pomni backlog add|list|board|show|edit|move|block|unblock|link|reopen|remove|next|open`
- **The gate guard**: an item reaches `in_review` only if the run store says the project's
  gate passed for the repos it touches — this is where M0b and M1 meet
- `packages/mcp`: 11 MCP tools over the same services, `pomni mcp` on stdio, `.mcp.json`
- Slash commands `/project`, `/backlog`, `/run`, and a `SessionStart` hook that injects the
  active project, the live backlog and recent failures
- HTTP item routes and a backlog list plus item detail in the web UI (the kanban board and
  drag-drop reordering are M2)
- 28 more tests (97 total)

---

## M2 — Board and live updates (no AI)

**Goal:** the browser becomes the way to run the shop. The server, API, SPA shell,
problem+json errors, `ETag`/`If-Match` and the SSE transport shipped in M0a; this milestone
adds the backlog surface and closes the multi-writer loop.

- `chokidar` watcher turning external file edits into bus events — the last piece of the
  multi-writer story, so a Claude session's edit lands in the browser without a refetch
- Kanban board with drag-drop transitions; spec editor with a conflict diff on 409
- Backlog and dev-server routes (see `SERVER.md`)
- Project settings: capabilities, gates, policy, doctor report

**Done when:** you can groom a backlog, edit a spec, press *Test*, and watch the log stream —
without a model in the loop — while a Claude session editing the same files shows up live.

---

## M3 — The feature loop (inline)

**Goal:** the core value — spec, plan, implement, verify, land — driven from a live session.

- `ContextPackBuilder` (project conventions, spec, deps, touched files, last failure, git state)
- `SessionService` + `InlineAgentRunner`
- `VerificationService` + `Gate` evaluation; junit/coverage parsers
- `/feature spec|plan|implement|verify|land|status`
- Skills: `feature-spec`, `feature-plan`, `verify-loop`
- Subagents: spec-writer, planner, verifier
- Branch management, `PostToolUse` file tracking, `Stop` reminder hook
- Web UI gains read-only session views and gate status on the board

**Done when:** a backlog line becomes a green, committed branch without leaving the session,
and every stage is recorded.

---

## M4 — Headless

**Goal:** the same loop without a human in the chair.

- `SdkAgentRunner` on `@anthropic-ai/claude-agent-sdk`; streaming to the event bus; transcripts
- Budgets: turns, cost, wall clock; clean `budget_exceeded` termination
- `session start|list|show|resume|abort`
- `feature next` and a simple queue: drain N ready items, stop on first red gate
- `--push` / `--pr` landing via `gh`
- Exit codes and `--json` everywhere, so CI and cron can call Pomni

**Done when:** `pomni feature next --project web` produces a PR unattended, or fails with a
transcript and a failing run explaining why.

---

## M5 — Signal

**Goal:** Pomni gets better at its own job by reading its history.

- `test_results` ingestion; flaky-test detection across runs
- `pomni stats` and a UI analytics view: throughput, gate pass rate, cost per landed item,
  slowest capabilities
- Failure clustering: group runs by failure signature, surface repeats in context packs
- `backlog groom` (agent-assisted dedupe, re-prioritization, staleness flags)
- `doctor --repair` reconciliation between doc store and database
- Coverage deltas attached to items

**Done when:** context packs cite prior failures automatically and `pomni stats` answers
"where is time going" without leaving the terminal.

---

## M6 — Live and scheduled

**Goal:** Pomni acts when you are not looking, and shows you what happened.

- AI actions in the web UI: `POST /api/sessions` over the existing `SessionService`, live
  session streaming, approve/reject a proposed diff — the conversational half of this
  (`POST /api/chats`, a typed action catalogue, confirm/reject per action) landed ahead of
  schedule as Chat; see `SERVER.md` §4 Chats. What is still open here is a session that writes
  code, not a conversation
- Notifications (desktop / webhook) on gate failures and landed items
- Scheduled work: nightly grooming, dependency-update items, scheduled `feature next`
- Remote `Executor` adapter (container or SSH) for heavy builds
- Optional auth + `Identity` port, so the server can be reachable from another machine

**Done when:** an overnight run lands a dependency bump and the morning board shows it,
with the transcript one click away.

---

## M7 — Scale

**Goal:** many projects, real teams.

- `IssueTracker` port with GitHub Issues and Linear adapters (two-way sync)
- Cross-project items and a dependency graph across registered projects
- Monorepo support: sub-projects with inherited capabilities
- Stack adapters as loadable plugins; adapter authoring guide
- Multi-agent execution: parallel items, now that per-run worktree isolation and
  conflict detection on non-isolatable repos have shipped (see ARCHITECTURE.md §8,
  DATA-MODEL.md §9) — what is still open is deciding which ready items to run at once
- Policy profiles per project (autonomy levels from suggest-only to auto-land)

**Done when:** Pomni coordinates work across several repositories without any of them knowing
it exists.

---

## Ordering rationale

M0a and M0b are infrastructure with immediate payoff — a real project registry and a real
test runner before any agent orchestration exists, so M3 can be judged on whether it
*helps*, not on whether it works at all. M0b also settles the question a gate depends on:
"did this actually pass?" is answered by an exit code on record, not by an agent's opinion.

M2 comes before the AI loop on purpose. A **management** UI over M0+M1 data is useful the day
it ships, unlike an analytics dashboard, which needs history to be worth building (hence M5).
Putting it second also forces the multi-writer story — revisions, atomic writes, file watching,
the cross-process event stream — to be settled *before* agents start editing the same files
concurrently, which is much cheaper than retrofitting it in M4.

M3 is inline-first because the interactive loop validates the design cheaply; M4 only swaps the
runner behind an interface that already exists. M6 and M7 are deliberately last: every item in
them is an adapter behind a port defined in M0-M3.

## Explicit non-goals (for now)

- Hosting or executing production deployments
- Replacing the project's own CI
- A general-purpose issue tracker for non-engineering work
- Multi-user collaboration or hosted/shared instances before M6
- Supporting model providers other than Claude before M7
