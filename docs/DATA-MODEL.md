# Pomni Data Model

> **Status:** projects, repos, credentials, runs and backlog items are all implemented.

## 0. Project is a container; Repo is the codebase

A **project** is a named container with a backlog, gates and policy. A **repo** is one
codebase inside it. A fullstack project normally has several — a web app, an api, maybe a
mobile client — each with its own stack and its own commands. That is why `capabilities`
and `stack` live on the repo, and `gates`, `policy` and `counters` live on the project.

```
Project "acme-saas"
├── Repo "web"   source: git  → cloned into the workspace   next@15, pnpm, vitest
├── Repo "api"   source: git  → cloned into the workspace   fastapi, uv, pytest
└── Repo "infra" source: local → linked in place            make
```

## 1. Where a repo's code comes from

The `source` discriminated union is the reason Pomni is not locked into either model:

```ts
type RepoSource =
  | { kind: 'local'; path: string }
  | { kind: 'git'; url: string; ref?: string; credential?: string; provider: Provider }
```

`WorkspaceService.workingDir(repo)` is the **only** code that branches on `kind`. A local
repo resolves to the path the user linked; a git repo resolves to its slot in the managed
workspace. Everything downstream — detection, capabilities, runs, gates, sessions — receives
a `workingDir` and never asks where it came from, so adding `remote` (execution on another
host) later is a new arm plus a resolver.

Per-run isolation did **not** take this path. A `Worktree` (§9) is a record of its own, not a
third arm of `RepoSource` — a source arm would mean one `Repo` per live worktree, so three
concurrent runs on one repo would make the project report four repos. See §9 for what a
worktree is and where it lives.

## 2. Stores

| Store | Holds | Format | Git |
| --- | --- | --- | --- |
| Doc store | config, projects, repos, credential metadata, backlog items | YAML / Markdown+frontmatter | tracked |
| Secret file | credential tokens, when stored by Pomni at all | JSON, mode 0600 | ignored |
| Workspace | cloned working copies | git checkouts | ignored |
| Worktrees | one run's private checkout per repo | git worktrees | ignored |
| Run store | runs and test results | SQLite (`node:sqlite`, WAL) | ignored |
| Chat store | chats and their messages | SQLite, same `pomni.db` file, own migrations | ignored |
| Worktree records | bookkeeping for live/kept worktrees | SQLite, same `pomni.db` file, own migrations | ignored |
| Run logs | one combined output file per run | plain text | ignored |
| Event stream | live cross-process notifications | append-only NDJSON | ignored |

Rule of thumb: **if a human should review it in a diff, it is a file; if it is high-volume
and you want to query it, it is a row.**

## 3. On-disk layout

**None of this is versioned by the repository Pomni manages.** `.pomni/` is in that
repository's `.gitignore` and no file under it is tracked. A repository is the history of a
codebase; a workspace is what one machine is doing right now — which runs are going, which
worktrees exist, what a counter is up to. Committing the second into the first makes every
branch a fork of the project's own bookkeeping, and a `git checkout` then rewrites the backlog
as file content with no service involved and no event emitted. That happened once, cost three
item specs and re-issued their ids, and is why this paragraph exists.

What a person is expected to do on a branch switch: nothing. Git does not touch `.pomni/`.
What a person is expected to do about losing it: back it up. In this repository `.pomni/` is
itself a git repository, in place, with its own history.

```
.pomni/
├── config.yaml                       # defaults, server port
├── credentials.yaml                  # credential METADATA — never the secret itself
├── credentials.secret.json           # 0600, only for `file` secret refs
├── projects/
│   └── acme-saas/
│       ├── project.yaml
│       ├── repos/
│       │   ├── web.yaml
│       │   └── api.yaml
│       └── backlog/
│           └── ACME-12.md           # frontmatter + prose
├── workspace/                        # cloned working copies
│   └── acme-saas/
│       ├── web/
│       └── api/
├── worktrees/                        # one checkout per repo per run
│   └── acme-saas/
│       └── web/
│           └── 01M1RM25VY.../        # named by runId, branch pomni/run/<runId>
├── runs/
│   └── 01M1RM25VY.../output.log      # one directory per run, named by ULID
├── sessions/                         # (M3)
├── events.ndjson                     # cross-process lifecycle stream
├── .lock/                            # advisory lock directory
└── pomni.db                          # run history
```

There is deliberately **no registry file**. The project list is derived by scanning
`projects/*/project.yaml`, so there is no index to drift and creating a project is a
single-file write that needs no lock.

## 4. project.yaml

```yaml
id: acme-saas
name: Acme SaaS
description: Customer-facing SaaS
itemPrefix: ACME            # fixed at creation so backlog ids never churn
counters:
  nextItem: 1
gates:
  default: [typecheck, lint, test]
  land: [typecheck, lint, test, build]
policy:
  autoCommit: false
  autoPush: false
  requireGreenGate: true
  maxTurns: 200
  maxCostUsd: 5
createdAt: 2026-09-05T10:45:16.426Z
updatedAt: 2026-09-05T10:45:16.426Z
```

Gates name capabilities, not commands. They fan out across every repo in the project that
declares the capability; a repo without `e2e` simply does not contribute one.

## 5. repos/&lt;id&gt;.yaml

```yaml
id: web
projectId: acme-saas
name: Storefront
role: web                   # web | api | mobile | desktop | lib | infra | docs | other
source:
  kind: git
  url: https://github.com/acme/storefront.git
  ref: main
  credential: github-personal      # a NAME, never a token
  provider: github
status: ready               # linked | cloning | ready | error | missing
worktrees: auto             # auto | always | never — see below
stack:
  adapter: node
  detected: [next@15, pnpm, typescript@5, vitest]
  detectedAt: 2026-09-05T10:45:16.560Z
capabilities:
  install:   { cmd: pnpm install, origin: detected }
  build:     { cmd: pnpm run build, timeoutMs: 600000, origin: detected }
  test:      { cmd: pnpm run test, origin: detected }
  lint:      { cmd: pnpm run lint, origin: detected }
  typecheck: { cmd: pnpm exec tsc --noEmit, origin: detected }
  dev:       { cmd: pnpm run dev, background: true, readyLog: "Ready in", port: 3000, origin: detected }
vcs:
  isRepo: true
  currentBranch: main
  defaultBranch: main
  remote: https://github.com/acme/storefront.git
  head: 9f2c1ab…
  dirty: false
lastError: null
addedAt: 2026-09-05T10:45:16.501Z
updatedAt: 2026-09-05T10:45:18.220Z
```

`workingDir` is **not** stored. It is derived from the source on every read, because a
persisted absolute path rots the moment the workspace moves.

### Worktree policy

`worktrees` decides whether a pipeline run gets its own checkout of this repo (§9 Worktrees)
or shares the repo's own directory with every other run:

| Value | Effect |
| --- | --- |
| `auto` (default) | A cloned repo gets a worktree per run. A linked repo (`source.kind: local`) does not — it is the user's own tree, and linking it was not consent to write into its `.git/`. |
| `always` | Take a worktree even for a linked repo. `git worktree add` still never checks out, moves or cleans the user's tree; it does add one bookkeeping entry under their `.git/worktrees/`, and `always` is the consent for that. |
| `never` | Runs share this repo's directory. Two runs sharing it is a conflict, not a quiet degradation. |

A `repos/*.yaml` written before this field existed has no `worktrees:` key and resolves to
`auto` — no migration, no rewrite.

### Capability origin

Re-detection replaces `origin: detected` entries and never touches `origin: manual` ones,
so `pomni repo sync` cannot silently discard a command a human wrote.

### Status transitions

```
local source ──► linked ──► missing (directory disappeared)
git source   ──► cloning ──► ready
                    └────► error (clone or auth failed; lastError explains)
```

A repo removed while its clone is still running is treated as cancelled, not as an error —
the background task checks whether the record still exists before writing anything.

## 6. credentials.yaml (tracked) and credentials.secret.json (ignored)

Metadata is committable; the token is a pointer resolved at use time.

```yaml
# credentials.yaml — metadata only; the secret is never here
version: 1
credentials:
  - id: github-personal
    name: GitHub personal
    provider: github
    host: github.com
    username: pomni
    secretRef: { kind: env, var: GITHUB_TOKEN }
    createdAt: 2026-09-05T10:40:00.000Z
```

`secretRef` has three arms, in ascending order of how much Pomni must be trusted with:

| kind | Where the token lives | Pomni stores |
| --- | --- | --- |
| `env` | an environment variable | nothing |
| `gh-cli` | the GitHub CLI (`gh auth token`) | nothing |
| `file` | `.pomni/credentials.secret.json`, mode 0600 | the token |

Three rules hold everywhere:

1. A repo references a credential **by id**. A token never appears in `repos/*.yaml`.
2. The token never enters the clone URL or `.git/config`. Auth goes through `GIT_ASKPASS`
   with the secret in the child process environment, inherited credential helpers disabled
   (`-c credential.helper=`) so nothing is cached to the OS keychain behind the user's back.
3. No API route returns a secret. Responses carry `hasSecret: boolean` and nothing more, and
   git output is redacted before it reaches a log or an event.

## 7. Identity

- **Project id** — slug derived from the name, unique across the workspace, user-overridable.
- **Repo id** — slug derived from the path or url, unique **within the project**; collisions
  get `-2`, `-3`.
- **Item id** — `<itemPrefix>-<n>` from `counters.nextItem` (M1).
- **Run / session id** — ULID (M0-runs).

Ids never change. Renaming a project or repo changes `name`, never `id`.

## 8. Consistency

### Between concurrent writers

The CLI, a Claude session and the web server all write `.pomni/` at the same time. `rev` is
the mechanism (see `ARCHITECTURE.md` §7):

```ts
type DocRef<T> = { data: T; rev: string }        // rev = sha256 of the file bytes, 16 hex chars

docStore.read(path, schema)                      // -> DocRef<T> | null
docStore.write(path, next, { ifMatch: rev })     // -> StaleRevisionError on mismatch
docStore.write(path, next, { mustNotExist: true })
```

`rev` is derived, never stored in the document — writing it would change it. It is surfaced
as an `ETag` header and accepted back as `If-Match`. A `StaleRevisionError` carries the
current content so a caller can merge instead of clobbering; the HTTP layer returns it as
`409` with a `current` field.

Writes are atomic: a temp file in the same directory, then rename. A watcher or a concurrent
reader never observes a partial document.

Background status updates use read-modify-write with the current rev, retried once — that
resolves the ordinary race between a clone finishing and a user renaming the repo, without
taking a lock.

### Multi-file operations

These take `.pomni/.lock` (pid + timestamp, stale after 30s) for their duration:

| Operation | Files touched |
| --- | --- |
| Create item (M1) | `backlog/<ID>.md` + `project.yaml` counter |
| Status transition (M1) | the item, plus dependents when unblocking |
| Board reorder (M2) | every item whose `order` changed |

Everything in the shipped feature is a single-file write, guarded by `rev` alone.

### Between the doc store and SQLite (M0-runs)

Docs are the source of truth for *intent*, SQLite for *history*. Docs win.
`pomni doctor --repair` drops rows whose project or repo no longer exists.

## 9. SQLite schema

Backed by Node's built-in `node:sqlite`, so there is no native module to compile — which
matters for a tool people install on Windows. WAL mode lets the CLI write while the server
reads. Migrations live in `packages/infra/src/run-store.ts`, are applied in order on open,
and `user_version` records the last applied; append new statements, never edit an old one.

The event stream and the log files are the other half of the picture: `runs.log_path` points
at `.pomni/runs/<id>/output.log`, which is what both `pomni runs tail` and the server's SSE
log endpoint read — that is why a run started in a terminal can be followed in the browser.

```sql
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,       -- ULID
  project_id  TEXT NOT NULL,
  repo_id     TEXT NOT NULL,          -- runs happen against a repo, not a project
  item_id     TEXT,
  session_id  TEXT,
  capability  TEXT NOT NULL,
  cmd         TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  status      TEXT NOT NULL,          -- running | passed | failed | timeout | cancelled
  exit_code   INTEGER,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  duration_ms INTEGER,
  log_path    TEXT NOT NULL,
  summary     TEXT
);

CREATE TABLE run_artifacts (
  id     TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind   TEXT NOT NULL,               -- junit | coverage | screenshot
  path   TEXT NOT NULL,
  data   TEXT
);

CREATE TABLE test_results (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  suite       TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL,
  duration_ms INTEGER,
  message     TEXT
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  repo_id         TEXT,
  item_id         TEXT,
  intent          TEXT NOT NULL,      -- spec | plan | implement | verify | land | freeform
  mode            TEXT NOT NULL,      -- inline | spawn | dry
  model           TEXT,
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  turns           INTEGER,
  cost_usd        REAL,
  transcript_path TEXT,
  outcome         TEXT
);

CREATE INDEX idx_runs_project_started ON runs(project_id, started_at DESC);
CREATE INDEX idx_runs_repo            ON runs(repo_id);
CREATE INDEX idx_sessions_item        ON sessions(item_id);
```

Migrations live in `packages/infra/src/sqlite/migrations/NNN-name.sql`, applied on open,
with `user_version` tracking the applied revision.

`SqliteChatStore` (`packages/infra/src/chat-store.ts`) shares this same `pomni.db` file but
tracks its own migrations (inline in that file, not under `sqlite/migrations/`) against a
`chat_schema` version table rather than `user_version`, so the run store and the chat store
can each evolve their schema without racing over one counter:

```sql
CREATE TABLE chats (
  id           TEXT PRIMARY KEY,       -- ULID
  title        TEXT NOT NULL,          -- derived from the first user message
  providerId   TEXT NOT NULL,
  model        TEXT NOT NULL,
  createdAt    TEXT NOT NULL,
  updatedAt    TEXT NOT NULL,          -- bumped on every message; chat lists sort by this
  inputTokens  INTEGER NOT NULL DEFAULT 0,
  outputTokens INTEGER NOT NULL DEFAULT 0,
  costUsd      REAL                    -- null when the provider reports none, never 0
);
CREATE INDEX idx_chats_updated ON chats(updatedAt DESC);

CREATE TABLE chat_messages (
  id           TEXT PRIMARY KEY,       -- ULID
  chatId       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,          -- user | assistant | system
  text         TEXT NOT NULL,
  providerId   TEXT,
  model        TEXT,
  actions      TEXT NOT NULL DEFAULT '[]',  -- JSON array of ProposedAction
  createdAt    TEXT NOT NULL,
  inputTokens  INTEGER NOT NULL DEFAULT 0,
  outputTokens INTEGER NOT NULL DEFAULT 0,
  costUsd      REAL
);
CREATE INDEX idx_chat_messages_chat ON chat_messages(chatId, createdAt);
```

A proposed action lives on the message that produced it, not in its own table — it has no
meaning apart from the turn that proposed it. `providerId`/`model` are recorded per message,
not only on the chat, because the chat's pinned model can change mid-conversation (recorded
as a `system` message) and a transcript should not claim the current model wrote every
earlier turn.

`SqliteWorktreeStore` (`packages/infra/src/worktree-store.ts`) shares the same `pomni.db` file
too, versioned against its own `worktree_schema` counter for the same reason the chat store
keeps `chat_schema` separate from `user_version`. A worktree record is not a YAML doc under
`.pomni/projects/`, even though that directory is where every other repo-adjacent fact lives:
this record holds an absolute path and a pid, both true on exactly one machine, and that
directory is tracked in git.

```sql
CREATE TABLE worktrees (
  id           TEXT PRIMARY KEY,       -- ULID
  project_id   TEXT NOT NULL,
  repo_id      TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  path         TEXT NOT NULL UNIQUE,   -- the database refuses two runs in one directory
  branch       TEXT NOT NULL,          -- pomni/run/<runId>
  base_branch  TEXT,
  base_commit  TEXT,
  owner_pid    INTEGER,
  status       TEXT NOT NULL,          -- active | kept
  kept_reason  TEXT,
  created_at   TEXT NOT NULL,
  ended_at     TEXT
);
```

There is deliberately no `released` status: a cleanly removed worktree has its row deleted in
the same step, so a record exists if and only if a directory exists. A `kept` row survives
because `git worktree remove` refuses on uncommitted changes and is never forced — losing an
agent's work to tidiness would be worse than leaving the directory behind.

Orphan detection (`pomni doctor`, `pomni worktree prune`) cannot trust a run's own `status`
alone: a process that dies without calling `cancel()` leaves its row at `running` forever. It
is why `pipeline_runs` gained a `pid` column (nullable — rows written before it existed read
`NULL`) — a live pid is the second opinion that tells a dead run's leftovers apart from one
still working, with a 60-second grace window for a worktree created before its pid was
recorded.

## 10. Backlog item

`.pomni/projects/acme-saas/backlog/ACME-12.md`

```markdown
---
id: ACME-12
project: acme-saas
repos: [web, api]        # which repos this item touches
title: Magic-link authentication
type: feature            # feature | bug | chore | spike | refactor | docs
status: ready
priority: P2
estimate: M
order: 30                # sparse rank within the board column
labels: [auth]
depends_on: [ACME-9]
touches: []             # paths this item edits; empty means "parse ## Plan instead"
branch: feat/acme-12-magic-link
created: 2026-09-05
updated: 2026-09-05
---

## Problem
## Acceptance criteria
## Plan
## Log
```

Status machine:

```
backlog ─► specced ─► ready ─► in_progress ─► in_review ─► done
                                    │             │
                                 blocked ◄────────┘        (reopen -> in_progress)
```

Guards, enforced in `BacklogService` so every surface agrees:

| Transition | Guard |
| --- | --- |
| `→ specced` | a non-placeholder `## Problem` and at least one `- [ ]` criterion |
| `→ ready` | a non-placeholder `## Plan`, plus `## Problem` and `## Acceptance criteria` clear of template placeholders, with at least one criterion that isn't just the title echoed back |
| `→ in_progress` | every `dependsOn` item is `done` |
| `→ in_review` | the default gate passed for this item's repos, per the run store |

Illegal transitions raise `InvalidTransitionError`; nothing is coerced. `--force` skips the
guards and writes `(forced)` into the item's Log, so an override stays visible.

**Reverse edges are derived.** Only `dependsOn` is stored; `blockedBy` and `blocking` are
computed on read. Storing both directions means two places to keep in sync, and one of them
will eventually be wrong.

**The body is opaque.** `deserializeMarkdown` returns `{ ...frontmatter, body }` with the
body as one string, and the serializer writes it back untouched. That is what makes a spec
edit show up in `git diff` as the prose change it was, rather than as a re-serialised blob.

**`touches` overrides the Plan.** `pomni backlog waves` needs to know what an item edits, and
prose is not always a reliable source. A non-empty `touches` list wins outright; an item that
leaves it empty (the default, and what every item file predating the field parses to) has its
paths read out of `## Plan` instead. See [COMMANDS.md](COMMANDS.md) §Waves for how paths are
parsed and how conflicts are decided from them.
