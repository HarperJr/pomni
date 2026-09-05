# Pomni Architecture

## 1. What Pomni is

A control plane for AI-assisted development across many projects. It owns *process and
memory*; the projects own the code. Three things make it more than a script collection:

1. **The engine is real software.** Domain logic lives in typed, tested TypeScript — not in
   prompts. Prompts are a surface over it, like the CLI is.
2. **Every surface is thin.** Slash commands, the `pomni` CLI, the MCP server and the web
   management server all call the same application services. A surface parses arguments and
   renders results; it never owns a rule.
3. **Work is gated by reality.** A feature is not "done" because an agent said so; it is done
   because the project's own test/lint/build capabilities ran and passed, and the run is on record.

## 2. Layering

```
┌── Surfaces ─────────────────────────────────────────────────────────┐
│  .claude/commands/*.md   packages/cli   packages/mcp                │
│  packages/server (HTTP + SSE)  ->  packages/web (React SPA)         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │  application API (typed, no I/O assumptions)
┌── Application (use-cases) ────┴─────────────────────────────────────┐
│  ProjectService  RepoService  CredentialService  WorkspaceService   │
│  BacklogService  RunService  DoctorService  ContextPackBuilder      │
└───────────────────────────────┬─────────────────────────────────────┘
┌── Domain ─────────────────────┴─────────────────────────────────────┐
│  Project · Repo · RepoSource · Capability · Credential · Gate       │
│  BacklogItem · Run · Session · zod schemas · pure functions         │
└───────────────────────────────┬─────────────────────────────────────┘
┌── Ports (interfaces only) ────┴─────────────────────────────────────┐
│  DocStore  FsProbe  GitPort  CredentialStore  StackDetection        │
│  RunStore  Executor  Lock  AgentRunner  EventBus  Clock  Logger     │
└───────────────────────────────┬─────────────────────────────────────┘
┌── Adapters (infrastructure) ──┴─────────────────────────────────────┐
│  FileDocStore  NodeFsProbe  GitCli  DefaultCredentialStore          │
│  DetectorRegistry  SqliteRunStore  ProcessExecutor  FileLock        │
└─────────────────────────────────────────────────────────────────────┘
```

Rules that keep this honest:

- Domain imports nothing but `zod` and other domain modules. No `fs`, no `child_process`.
- Application depends on **ports**, never on adapters. Adapters are injected at composition
  time (`packages/cli/src/container.ts`, `packages/mcp/src/container.ts`).
- Surfaces contain argument parsing, formatting and nothing else. If a surface has an `if`
  about domain state, it belongs in the application layer.

## 3. Package layout

```
pomni/
├── package.json                 npm workspaces root
├── packages/
│   ├── core/                    domain + application + port interfaces
│   │   ├── src/domain/          entities, state machines, schemas
│   │   ├── src/app/             services (use-cases)
│   │   └── src/ports/           interfaces
│   ├── infra/                   port implementations (fs, sqlite, git, process)
│   ├── adapters/                stack adapters (node, next, python, go, rust, ...)
│   ├── agent/                   Claude Agent SDK runner + inline runner + context packs
│   ├── cli/                     `pomni` binary (commander) + the composition root
│   ├── mcp/                     MCP server exposing core as tools (`pomni mcp`)
│   ├── server/                  Fastify JSON + SSE API, fs watcher (see SERVER.md)
│   └── web/                     Vite + React SPA, served by packages/server
├── .claude/
│   ├── commands/                slash commands (/project, /backlog, /run)
│   ├── hooks/                   session-start.mjs — injects project, backlog, failures
│   ├── skills/                  multi-step workflow skills (M3)
│   └── settings.json            hook registration
├── .pomni/                      state — see DATA-MODEL.md
└── docs/
```

## 4. Core concepts

### Project
A named **container**, not a codebase: it owns the backlog, the gates and the policy. A
project holds one or more repos.

### Repo
One codebase inside a project, plus the knowledge needed to operate it: detected stack and
**capabilities**. A fullstack project typically has several (web, api, mobile), which is why
capabilities live here rather than on Project.

### RepoSource
Where a repo's code comes from — `local` (link a checkout in place) or `git` (clone into the
managed workspace with token auth). `WorkspaceService.workingDir()` is the only code that
branches on it; every consumer downstream sees a resolved working directory. Adding
`worktree` or `remote` later is a new arm plus a resolver, not a change to any consumer.

### Capability
A named, runnable operation on a **repo**: `install`, `build`, `test`, `lint`, `typecheck`,
`e2e`, `dev`, or anything custom — `{ cmd, cwd?, env?, timeoutMs?, background?, readyLog?, parser? }`.
This is the abstraction that lets Pomni support new stacks without touching core. Stack
detectors *propose* capabilities; entries marked `origin: manual` always survive re-detection.

### BacklogItem
A unit of work with a lifecycle, stored as Markdown with YAML frontmatter. The body is
carried as one opaque string, so an agent editing it with ordinary file tools never has its
prose rewritten, and a spec change appears in `git diff` as the edit it actually was.

Transition guards live in `BacklogService`, which is why `/backlog move` from a session and
`pomni backlog move` from a terminal cannot disagree about what is legal. The guard that
matters most: an item reaches `in_review` only if the **run store** says the gate passed for
the repos it touches — "done because an agent said so" is precisely what that prevents.

### Run
One execution of a capability. Always recorded: command, cwd, exit code, duration, log path,
parsed artifacts (junit, coverage). Runs are the evidence a gate consults.

### Session
One agent conversation bound to `(project, item, intent)`. Recorded with model, turns, cost,
transcript path, touched files and outcome.

### Gate
An ordered list of capabilities that must pass before a status transition is allowed
(default: `typecheck` then `lint` then `test`). Configured per project and fanned out across
every repo that declares the capability; a repo without `e2e` contributes none.

### Context Pack
The thing Pomni is actually *for*. Before any session starts, `ContextPackBuilder` assembles:

- project conventions, capability list, policy
- the item's spec, acceptance criteria and plan
- the dependency chain (`depends_on` items and their outcomes)
- files touched by prior sessions on this item
- the tail of the last failing run, if any
- git state: branch, diff stat, uncommitted files

A pack is deterministic, serializable and testable. Both execution modes consume the same pack,
which is why headless and interactive runs behave alike.

## 5. Execution modes

Pomni is invoked from inside a Claude session *and* from a terminal. It must not spawn a nested
agent in the first case, and must spawn one in the second. Both go through `SessionService`;
only the `AgentRunner` port differs.

| Mode | Runner | When | Behaviour |
| --- | --- | --- | --- |
| `inline` | `InlineAgentRunner` | Slash command / MCP tool inside a live session | Returns the context pack + instructions; **the calling session does the work**. Pomni records the session and watches the project dir for changes. |
| `spawn` | `SdkAgentRunner` | `pomni` CLI, cron, CI | Starts a headless session via `@anthropic-ai/claude-agent-sdk` with `cwd` set to the project path, streams events to the EventBus, writes a transcript. |
| `dry` | `DryRunner` | `--dry-run` | Renders the pack and the plan, executes nothing. |

Detection: surfaces set the mode explicitly. The MCP server and slash commands default to
`inline`; the CLI defaults to `spawn` unless `POMNI_MODE=inline`.

## 6. Event bus and streaming

Everything long-running emits typed events (`run.started`, `run.output`, `run.finished`,
`session.turn`, `session.tool_use`, `item.changed`, `item.transitioned`). Subscribers: the run
logger, the SQLite recorder, the CLI terminal renderer, and the server's SSE bridge. Later: a
notifier, a metrics exporter.

Events are written twice — per-run NDJSON under `.pomni/runs/<runId>/events.ndjson` for replay,
and appended to a single rotating `.pomni/events.ndjson` that **any process can tail**. That
second sink is what makes the management server work without a daemon: a run started by the CLI
or by a Claude session streams into the browser identically to one the server started itself.

## 7. Multi-writer consistency

Once a web server exists, three processes write `.pomni/` at once: the CLI, a Claude session
editing spec files with ordinary file tools, and the server. None of them is the owner. That is a
core concern, not a server concern, so it lives in the `DocStore` port:

- **Revisions.** Every read returns `rev`, a hash of the file bytes. Writes pass the `rev` they
  were based on; a mismatch raises `StaleRevisionError` carrying the current content. Surfaces
  decide how to present it — the CLI re-reads and retries, the web UI shows a diff.
- **Atomic writes.** Temp file in the same directory, then rename. Watchers never see a partial file.
- **Watch, don't cache.** The doc store is a few hundred small files; reads hit disk. `chokidar`
  turns external edits into `item.changed` / `project.changed` events on the bus.
- **Short advisory lock** (`.pomni/.lock`, pid + timestamp, stale after 30s) around the only
  genuinely multi-file operations: status transitions and item-id allocation.
- **SQLite in WAL mode** with a busy timeout, so concurrent readers and one writer coexist.

The management server is a **peer, not a daemon**: it holds no authoritative state, nothing
connects *through* it, and killing it loses only the background `dev` processes it started.
See [SERVER.md](SERVER.md) for the API and the UI surface.

## 8. Safety model

Pomni edits real repositories and executes real shell commands. Non-negotiables:

- **Path boundary.** Writes are permitted only under registered project paths and `.pomni/`.
  Every path is resolved and checked against the registered repo working directories first.
- **Command allowlist.** Only capabilities declared in `project.yaml` are executed by
  `run` and gates. Ad-hoc commands require an explicit flag and are recorded as such.
- **Git guard.** Sessions refuse to start on a dirty tree unless `--allow-dirty`. Work happens
  on a branch derived from the item id. Nothing is pushed without `--push`.
- **No auto-commit by default.** `policy.autoCommit: false` is the shipped default.
- **Budgets.** Per-session turn/cost ceilings and per-run timeouts; exceeding one fails the
  session cleanly with the transcript intact.
- **Idempotent transitions.** Status changes go through the domain state machine; illegal
  transitions are rejected, not coerced.

## 9. Extension points (how future features land without a rewrite)

| You want to add | You implement | You do **not** touch |
| --- | --- | --- |
| A new stack (Rust, Elixir, Deno) | a `StackAdapter` | core, CLI, commands |
| GitHub Issues / Linear sync | an `IssueTracker` port adapter | backlog domain |
| AI actions in the web UI | route files over `SessionService` | application, domain |
| Any other client (mobile, TUI, script) | HTTP calls to the existing API | server, core |
| Remote/CI execution | an `Executor` adapter (ssh, container) | RunService |
| A different model provider | an `AgentRunner` adapter | SessionService |
| Scheduled grooming | a cron surface calling `BacklogService` | anything else |
| Multi-user access | auth middleware + an `Identity` port | every route handler |

## 10. Decision log

| # | Decision | Rationale | Cost accepted |
| --- | --- | --- | --- |
| 1 | Engine + CLI + Claude Code plugin, not prompts-only | Logic is testable; usable headless and interactively; one source of truth | More upfront code than a folder of `.md` commands |
| 2 | Projects registered by external path, never relocated | Works with existing checkouts on day one; no migration ceremony | Must handle moved/missing paths (`project doctor`) |
| 3 | Hybrid persistence: Markdown+YAML for specs, SQLite for runs | Specs stay diffable and agent-editable; run history stays queryable and out of git | Two stores to keep consistent (item/run linkage by id) |
| 4 | TypeScript / Node 22 | First-class Agent SDK and MCP SDK; matches the fullstack projects being managed | Node runtime dependency |
| 5 | Capability abstraction over hardcoded `npm test` | New stacks are data, not code | Requires detection plus `doctor` to stay honest |
| 6 | Ports and adapters throughout | The daemon/web/remote-exec futures cost a package each, not a rewrite | Indirection in a young codebase |
| 7 | Inline vs spawn execution modes share one context pack | Interactive and headless behave identically; no duplicated prompt logic | Two runner implementations |
| 8 | Management server is a peer process, not a daemon | Nothing to babysit; state survives it; CLI, session and server stay symmetric | Background `dev` processes die with the server |
| 9 | Optimistic concurrency (`If-Match` on a content hash) plus fs watching | Agents and humans edit the same spec files concurrently *by design*; conflicts surface instead of clobbering | Every write path carries a rev |
| 10 | Web UI manages and executes, but never invokes AI | Separates the fast deterministic path from the judgement path; the server needs no model credentials | Two entry points for starting work |
| 11 | Fastify API + separate React SPA, not a fullstack framework | The API is the contract; any future client reuses it, and the UI can be replaced without touching it | Two packages instead of one |
| 12 | Project contains many repos, rather than project = one codebase | A fullstack project *is* several repos; gates and backlog belong to the product, commands belong to each codebase | Two levels of identity to resolve |
| 13 | `RepoSource` union with both `local` and `git`, git primary | Clone-only cannot add a greenfield repo with no remote; local-only makes PRs, isolation and remote execution a rewrite | One resolver to maintain |
| 14 | Credentials referenced by name; token resolved at use time via `GIT_ASKPASS` | `.pomni/` stays committable, `.git/config` stays clean, and the token never reaches a process argument list | A `CredentialStore` port with three adapters |
| 15 | No registry index file; the project list is a directory scan | Nothing to drift, and creating a project needs no lock | A scan per list call (hundreds of small files, not thousands) |
