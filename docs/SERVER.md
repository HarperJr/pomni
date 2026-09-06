# Pomni Management Server

A local web server for the parts of Pomni that are **not** AI: managing projects, grooming a
backlog, editing specs, running builds and tests, and reading history. It is a surface over the
same application services the CLI and MCP server use — it owns no logic of its own.

```
packages/server   Fastify   JSON + SSE API on 127.0.0.1:7777
packages/web      Vite + React + TanStack Query   SPA served by the same process
```

Start it with `pomni serve`. It is not required for anything else to work.

> **Status:** projects, repos, credentials, runs, gates, doctor, backlog items, the
> directory picker, detection preview and both SSE streams are implemented. Session routes
> arrive with M3.

## 1. What it can and cannot do

| Can | Cannot |
| --- | --- |
| Create, edit, move, delete backlog items | Start a Claude session |
| Edit spec / plan / notes markdown in place | Run `spec`, `plan`, `implement`, `land` |
| Reorder a kanban board, set priority, labels, dependencies | Write code in a managed project |
| Register, configure and doctor projects | Change capability *definitions* it cannot verify (it runs `project doctor` instead) |
| Trigger declared capabilities: test, build, lint, typecheck, e2e | Execute ad-hoc shell commands |
| Run a project's gate, and the doctor report | — |
| Stream live run logs; cancel a run | — |
| Browse past AI sessions, transcripts, touched files (read-only) | — |
| Chat with a model and let it act on Pomni, guarded by confirm-before-write (§4 Chats) | Let a chat write anything outside the typed action catalogue |

The line is mostly deliberate: the server is the surface you use when you know what you want, and
that judgement-free path (grooming, running gates, reading history) needs no model credentials.
Chat is the one exception — it is where the server does invoke AI — but it never gains a second
implementation of a rule: every action it proposes calls the same application service the CLI
would, so a chat-confirmed `backlog.move` is indistinguishable in the log from one typed at a
terminal.

The seam for later is already correct — `SessionService` is in the container the server builds,
so exposing `POST /api/sessions` when headless mode lands (M4) is a route file, not a redesign.
It stays unexposed until then.

## 2. The server is a peer, not a daemon

This is the important architectural choice. The server does **not** own the state and other
processes do not connect to it. All three writers — CLI, Claude session, server — act directly
on `.pomni/` and coordinate through the filesystem:

```
   CLI          Claude session          Server
    │                 │                    │
    └────────┬────────┴──────────┬─────────┘
             ▼                   ▼
        .pomni/ docs        .pomni/pomni.db
        (yaml + md)         (sqlite, WAL)
             │                   │
             └──── .pomni/events.ndjson ────┘   <- cross-process stream
```

Consequences that matter:

- Killing the server loses nothing. Starting it mid-flight picks up current state.
- A run triggered from the browser executes **in the server process**. A run triggered from the
  CLI executes in the CLI process; the server observes it through the event stream and shows it
  live anyway.
- Background capabilities (`dev`) started from the browser die with the server. The UI says so.
- No port conflict story, no daemon lifecycle, no stale-daemon debugging.

## 3. Multi-writer consistency

A Claude session edits `WEB-12.md` with ordinary file tools while you have it open in the web
editor. That is the normal case, not the edge case, so it is designed for:

- **Revisions.** Every item and project read carries `rev` — a hash of the file bytes. Writes
  send `If-Match: <rev>`. A mismatch returns `409 Conflict` with the current server-side content
  so the UI can show a diff and let you merge, rather than silently clobbering an agent's work.
- **Atomic writes.** Write to a temp file in the same directory, then rename. A watcher never
  observes a half-written spec.
- **Cross-process events.** Lifecycle events are appended to `.pomni/events.ndjson` by every
  Pomni process and tailed by the server, which replays them onto its own bus tagged
  `remote` (the tag is what stops the sink from writing them back and looping). A run started
  in a terminal therefore reaches the browser live.
- **Filesystem watching.** *(M2)* `chokidar` on `.pomni/projects/**` will emit
  `item.changed` / `project.changed`, so a spec edited by a Claude session updates the board
  instantly rather than on the next refetch.
- **Transition lock.** *(M1)* Status transitions and item-id allocation are read-modify-write
  across two files. They take a short advisory lock (`.pomni/.lock`, pid + timestamp, stale
  after 30s) held for milliseconds. Everything shipped today is a single-file write guarded by
  `rev` alone, plus a one-shot retry for background status updates.
- **SQLite in WAL mode** with `busy_timeout`, so the CLI can write run history while the
  server reads it.
  *(arrives with the run store.)*
- **No server-side cache.** Reads hit the doc store. It is a few hundred small files; correctness
  beats a cache that can be wrong.

## 4. HTTP API

JSON in, JSON out. Errors use RFC 7807 problem shape. Every mutating route validates through the
same zod schemas the CLI uses, so the two cannot drift.

### Projects

```
GET    /api/projects                     list + repo summaries
POST   /api/projects                     { name, id?, description? }        -> 201
GET    /api/projects/:id                 project + resolved repos; ETag
PATCH  /api/projects/:id                 If-Match; name, description, gates, policy
DELETE /api/projects/:id                 ?purge=true  (deletes clones, never linked folders)
```

### Repos

```
GET    /api/projects/:id/repos           repos with resolved workingDir
POST   /api/projects/:id/repos           { source: {kind:'local',path} | {kind:'git',url,ref?,credential?},
                                           id?, name?, role? }
                                         -> 201 for a local link (already resolved)
                                         -> 202 for a git clone, repo.status = 'cloning'
GET    /api/projects/:id/repos/:repoId   one repo
PATCH  /api/projects/:id/repos/:repoId   If-Match; name, role
POST   /api/projects/:id/repos/:repoId/sync    fetch + re-detect
DELETE /api/projects/:id/repos/:repoId   ?purge=true  (deletes the clone only)
```

### Credentials

```
GET    /api/credentials                  metadata + hasSecret — never a token
POST   /api/credentials                  { name, provider?, host?, username?, secretRef, secret? }
POST   /api/credentials/:id/test         { url? } -> { ok, message }
DELETE /api/credentials/:id
```

### Filesystem (for the add-repo dialog)

```
GET    /api/fs/browse?path=              directory listing; no path -> roots + home
GET    /api/fs/detect?path=              preview stack detection and git info before adding
```

### Backlog

```
GET    /api/projects/:id/items?status=&type=&priority=&label=&repo=&q=
POST   /api/projects/:id/items           { title, type?, priority?, repos?, ... } -> 201
GET    /api/projects/:id/items/:itemId   item + derived blockedBy/blocking + sections; ETag
PATCH  /api/projects/:id/items/:itemId   If-Match; fields and/or the whole body
POST   /api/projects/:id/items/:itemId/transition   { to, reason?, force? }
                                         -> 422 when a guard refuses, with the reason
POST   /api/projects/:id/items/:itemId/block | /unblock
DELETE /api/projects/:id/items/:itemId   refused while something depends on it
POST   /api/projects/:id/items/reorder   { status, orderedIds }   board drag-drop
GET    /api/projects/:id/items-next      the highest-priority ready item
```

Transitions are a separate route rather than a `PATCH` of `status`, so a client cannot skate
past the state machine by writing the field directly.

### Runs

```
GET    /api/runs?project=&repo=&capability=&item=&failed=&limit=&before=
POST   /api/runs                         { project, capability, repoId?, itemId?, bail? }
                                         -> 202 { accepted, capability, repos: [...] }
                                         -> 422 if no repo declares the capability
GET    /api/runs/:id                     the run plus its recorded test results
DELETE /api/runs/:id                     cancel (by pid, so it works across processes)
GET    /api/runs/:id/log                 SSE: replays the log from the start, then follows
                                         until the run finishes, ending with a `done` event
POST   /api/projects/:id/verify          { gate?: 'default' | 'land' } -> 202
GET    /api/projects/:id/doctor          per-repo checks, including capability resolution
```

A run takes minutes, so `POST` returns 202 and the work continues detached. The browser
follows `run.started` / `run.finished` on `/api/events` and streams output from the log
endpoint — which reads the log **file**, not the bus, so a run started by the CLI in another
process streams identically.

### Dev servers

```
GET    /api/dev                          background capabilities this process owns
POST   /api/dev                          { project } -> starts dev, waits for readyLog, returns url
DELETE /api/dev/:project                 stop
```

### Chats

```
GET    /api/chats?query=&providerId=&limit=      newest first
POST   /api/chats                                { providerId, model, title? } -> 201
GET    /api/chats/:id                             chat + transcript + pending actions
DELETE /api/chats/:id                             -> 204
PATCH  /api/chats/:id/model                       { providerId, model }; affects only the next
                                                   turn, recorded as a `system` message
POST   /api/chats/:id/messages                    { text } -> 201, the assistant's reply
POST   /api/chats/:id/messages/:messageId/actions/:actionId/confirm
POST   /api/chats/:id/messages/:messageId/actions/:actionId/reject
```

A chat is pinned to a provider + model chosen at creation from the enabled providers and the
models each defines. The assistant asks for actions by ending its reply with a fenced
` ```json {"actions": [...]} ``` ` block — there is no native tool-calling in this repo, so this
is the same prompted-JSON convention pipelines already use for delegation. Reads (`project.list`,
`backlog.show`, `run.show`, …) execute immediately; writes (`backlog.create`, `backlog.move`,
`task.start`, `workflow.attach`, `tool.attach`, `question.answer`) come back as a `proposed`
action on the message and only run once confirmed. Every message records the provider and model
that produced it and the actions it took, so a chat is auditable afterwards; token counts are
recorded per chat the way runs already show them, and `costUsd` stays `null` — rendered as
unknown, not `$0.000` — when the provider does not report one.

The LLM port does not stream token-by-token, so a reply arrives as one chunk over the existing
`/api/events` stream rather than its own channel.

Chat is a web-only surface — there is no `pomni chat` CLI verb and none is planned; unlike the
rest of this API, it has no terminal equivalent to fall back on.

### Sessions (read-only) *(M3)*

```
GET    /api/sessions?project=&item=&status=
GET    /api/sessions/:id                 outcome, turns, cost, touched files
GET    /api/sessions/:id/transcript      paginated
```

### Live events

```
GET    /api/events?scope=                SSE: run.started, run.output, run.finished,
                                              item.changed, item.transitioned,
                                              project.changed, session.started, session.finished,
                                              chat.changed, chat.removed, chat.message.chunk,
                                              chat.action.started, chat.action.finished,
                                              chat.turn.finished
```

One SSE connection per browser tab, multiplexed by scope. The server tails
`.pomni/events.ndjson` so events originating in the CLI or a Claude session arrive identically to
its own. `chat.*` events are the exception: a chat only ever runs in the process the browser is
talking to, so they are published on the in-process bus only and never written to
`events.ndjson` — there is no cross-process chat to replay.

### Meta

```
GET    /api/health                       version, stores, watcher status
GET    /api/stats?project=&since=        throughput, gate pass rate, cost per landed item
```

## 5. UI

Shipped:

```
/                          project cards with their repos
/p/:projectId              repos: source, status, branch, detected stack
                           add repo (clone from git | link a local folder + picker)
                           sync / remove per repo
/credentials               credential list, add, test, remove
/p/:projectId/items/:itemId  item detail: spec, dependencies, legal transitions
/chat, /chat/:chatId       chat list (newest first) and the active conversation
```

Planned:

```
/p/:id/board               kanban by status, drag to transition                (M2)
/p/:projectId/runs/:runId  run detail: command, failed tests, live log        (shipped)
/p/:id/settings            capabilities, gates, policy, doctor report          (M2)
/p/:id/sessions            read-only AI transcripts                            (M3)
```

Design rules: the board is the home screen; every list is filterable by the same query params the
API takes, so a URL is shareable state; a red gate is visible from the board without a click.

## 6. Security

Local-first and deliberately boring:

- Binds `127.0.0.1` by default. `--host` beyond loopback **requires** `--token`, and the server
  refuses to start otherwise.
- Auth, when enabled, is a bearer token in the `Authorization` header — never a cookie, so there
  is no CSRF surface.
- The path boundary from `ARCHITECTURE.md` §8 applies unchanged: the server can only read and
  write under registered project paths and `.pomni/`.
- Only capabilities declared in `project.yaml` are executable. There is no route that accepts a
  shell command.
- Run logs may contain secrets printed by the project's own tooling. Logs are served only over
  loopback (or behind the token) and never leave the machine.
