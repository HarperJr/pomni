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

**Since then**

- POMN-14 → a run orphaned by a dead process can be cancelled
- POMN-37 → agent runs listed as running first, latest five, the rest behind *Show all*
- POMN-66 → a run id is enough to find the run; no `-p` needed
- POMN-71 → a run the executor killed reports `timed out after …`, not the tests it interrupted;
  `repo edit --timeout <capability=duration>`

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

**Since then**

- POMN-27 → `backlog list` orders by priority and agrees with `backlog next`
- POMN-55 → a resumed run that succeeds no longer leaves its item stuck in `blocked`

---

## M2 — Board and live updates (no AI)

**Goal:** the browser becomes the way to run the shop. The server, API, SPA shell,
problem+json errors, `ETag`/`If-Match` and the SSE transport shipped in M0a; this milestone
adds the backlog surface and closes the multi-writer loop.

**Shipped**

- POMN-28 → `pomni backlog board`, `pomni backlog flow`, gated `pomni backlog move`, and the
  Tracker tab: kanban board with drag-drop, guarded moves
- POMN-1 → Tracker tab: projects on the left, task cards on the right
- POMN-3 → running pipelines shown on project cards and tracker task cards
- POMN-15 → Unblock button, and Move-to restricted to legal transitions, in the web UI
- POMN-16 → Project page sidebar: one block at a time instead of six stacked
- POMN-22 → task workflow per project, with gates and checklists on each transition
- POMN-29 → `backlog move` refuses a still-placeholder item
- POMN-33 → transitions can be automatic or manual; `backlog move --comment`
- POMN-34 → `backlog comment`, `task comment`
- POMN-31 → back navigation from a run returns to the block you came from
- POMN-18 → long task lines no longer overflow the Agents block
- POMN-32 → language selector: Russian and English across the web UI
- POMN-42 → agent output rendered as markdown, not a wall of text
- POMN-45 → reload picks up a new build, not just a repaint of the tab
- POMN-69 → a button and a page for reading logs

**Still open**

- POMN-80 — a file watcher feeding external `.pomni` edits into the event bus

---

## M3 — The feature loop (inline)

**Goal:** the core value — spec, plan, implement, verify, land — driven from a live session.

**Shipped** as `pomni task run|resume|rerun|show|list|cancel` and `pomni workflow` (agents are
configurable per workflow, not fixed spec-writer/planner/verifier roles)

- POMN-7 → `human` delegate target: an orchestrator can wait on a person
- POMN-9 → agents can escalate; a critical one asks a person
- POMN-8 → attach files when answering a question
- POMN-4 → attach context files to a task run
- POMN-13 → `task rerun`, carrying forward why the last run ended
- POMN-39 → `task resume`
- POMN-40 → an agent can verify without being given a shell
- POMN-23 → `pomni provider`, chosen per agent
- POMN-5 / POMN-6 → `pomni tool`, tool grants in the agent editor
- POMN-63 → the orchestrator sizes the team to the change; authors verify their own work
- POMN-11 → Write and Edit permitted to agents
- POMN-12 → agents see every repo in the project, not just the first
- POMN-10 → a run's status reflects what its agents actually reported
- POMN-67 → a run no longer ends after the orchestrator's first delegation
- POMN-30 → artifacts: scrollable, with diffs, and files you can open
- POMN-35 → an agent can search the web, as an option alongside files and run

**Still open**

- POMN-47 (in_review) — context packs: an agent starts from the item's touched files and what
  the other agents just found
- POMN-82 — inside a run, Pomni's own MCP server is dead: the worktree's `.mcp.json` points at
  a `dist/` nobody built, so agents cannot read the workspace they work for

---

## M4 — Headless

**Goal:** the same loop without a human in the chair.

**Shipped**

- POMN-54, POMN-65, POMN-62, POMN-2 → budgets enforced mid-run: `project edit
  --max-cost/--max-turns/--max-session-turns`, `workflow lint`
- POMN-24, POMN-46, POMN-64 → `task spend`, `task show`: cost and turns accounted per step
- POMN-48, POMN-51, POMN-49, POMN-53, POMN-50, POMN-70, POMN-56 → landing: commit and push,
  a merge request opened through the forge (`project edit
  --auto-commit/--auto-push/--auto-mr`), `verify --land`
- POMN-25 → `feature next` → `backlog waves --run`
- POMN-73 → `--json` global flag on every command; exit codes mean something (0 success,
  1 answer is no, 2 bad usage, 3 not found); errors in JSON mode are `{ error }` on stdout

**Still open**

- POMN-74 — drain the queue: run wave after wave unattended, stop at the first red gate

---

## M5 — Signal

**Goal:** Pomni gets better at its own job by reading its history.

**Shipped**

- POMN-41 → `workflow signals`, `workflow amend`
- POMN-17 → the commands, skills and MCP calls an agent actually ran, on record
- POMN-60 → `repo doctor` reports branches a run left behind
- POMN-59 → the schema counter reports divergence, not just depth

**Still open**

- POMN-76 — `doctor --repair` reconciling the doc store and the database
- POMN-77 — flaky-test detection across runs
- POMN-78 — `pomni stats`: where the time and the money are going
- POMN-79 — warn a run it is about to fail the way a prior run did
- `backlog groom` — no item filed

---

## M6 — Live and scheduled

**Goal:** Pomni acts when you are not looking, and shows you what happened.

**Shipped**

- POMN-21, POMN-38, POMN-68 → Chat: every Pomni verb, behind a confirm
  (`POST /api/chats`, a typed action catalogue, confirm/reject per action; see `SERVER.md`
  §4 Chats)

**Still open**

- POMN-75 — notifications for questions, red gates and landed work
- POMN-81 — scheduled work: a nightly drain of the ready queue, dependency-update items that
  file themselves
- a remote `Executor` adapter, and optional auth for a server reachable from another machine —
  no item filed

---

## M7 — Scale

**Goal:** many projects, real teams.

**Shipped**

- POMN-26 → `pomni worktree list|prune|remove`, `repo edit --worktrees`
- POMN-25 → `pomni backlog waves`, conflict detection
- POMN-44 → resume lands in the run's own worktree, not the shared repo on master
- POMN-52 → sync no longer dirties a tracked file
- POMN-57 → Pomni's own state moved out of the repo it manages
- POMN-58 → the workspace search no longer escapes a run's checkout
- POMN-43 → Windows: multi-word permissions no longer shredded before the CLI sees them
- POMN-19 → Windows: atomic write no longer fails when the server holds the file open

**Still open**

- POMN-74 — running more than wave 1 unattended (also filed under M4)
- an `IssueTracker` port, cross-project items, stack adapters as loadable plugins, policy
  profiles per project — no item filed

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
- Supporting model providers other than Claude as the *default* — `pomni provider` (POMN-23) can
  point an agent at an OpenAI-compatible endpoint, but the harness is developed and tested
  against Claude Code, and only that provider gets the tool grants and permission model
