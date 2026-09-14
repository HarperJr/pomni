# Pomni

**AI-driven, project-oriented fullstack runtime.**

Pomni is a *harness*: a control-plane repository you open a Claude session inside of. From
there you register real projects that live elsewhere on disk, keep a backlog per project,
turn backlog items into specs and plans, hand them to agent sessions that do the work in
the project, and gate the result behind real build/test/lint runs.

There is also a plain web UI for the parts that need no AI at all — managing projects, grooming
the backlog, editing specs, pressing *Test* and watching the log.

```
        you                                    your browser
         |                                          |
    +----+--------+------------+                    |
 /slash cmds   pomni CLI   MCP client            web UI
    +----+--------+------------+                    |
         |                                    HTTP + SSE
         |                                          |
         +--------->  Pomni engine (core)  <--------+
                              |
     +-----------+------------+------------+
  projects     repos      backlog       runs
   (yaml)     (yaml)     (md+yaml)    (sqlite)
                              |
              +---------------+---------------+
              |                               |
     cloned into .pomni/workspace/    linked in place
       (git url + token)              (C:/dev/my-app)
```

A **project** is a container — a backlog, gates, policy. A **repo** is one codebase inside it,
either cloned from a git remote into the managed workspace or linked in place from a folder you
already have. Pomni never moves code you linked. The CLI, a Claude session and the web server
are peers — no daemon, no owner; they coordinate through `.pomni/`.

## Quickstart

```bash
npm install && npm run build && npm run build:web

pomni init
pomni project create "Acme SaaS"          # a project is a container

# add the repos it is built from
pomni cred add "GitHub" --gh              # or --env GITHUB_TOKEN, or --token ghp_…
pomni repo add https://github.com/acme/storefront.git -p acme-saas -r web
pomni repo add ../infra -p acme-saas -r infra    # linked in place, not copied

pomni project show acme-saas

# run the repos' own commands; history is recorded either way
pomni test                                # fans out across every repo declaring `test`
pomni verify                              # the whole gate: typecheck -> lint -> test
pomni runs list

# capture work; items are Markdown files you can read in a diff
pomni backlog add "Magic-link authentication" -r web --priority P1
pomni backlog board

pomni serve --open                        # manage it all in a browser
```

Inside a Claude session opened in this repo, the same things are `/project`, `/backlog` and
`/run`, backed by the `pomni` MCP server.

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, ports & adapters, execution modes, context packs, multi-writer consistency, safety model, decision log |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Entities, on-disk formats, schemas, state machines, SQLite tables, concurrency |
| [docs/COMMANDS.md](docs/COMMANDS.md) | Full command surface: CLI verbs, slash commands, MCP tools |
| [docs/SERVER.md](docs/SERVER.md) | Management server: scope, HTTP API, UI routes, security |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones M0-M7 and what each unlocks |

## Status

**Shipped:** projects and repos (git clone with token auth, or link a local folder), stack
detection for Node/Python/Go/Rust/Make, credentials, running a repo's own commands with full
run history, gates, doctor, a Markdown-file backlog with a guarded state machine and a kanban
**board**, **task** runs in per-run git worktrees, **waves** of items grouped to run
concurrently, per-run **budgets** (turns, cost, wall clock), **commit/push and merge-request
landing** through the forge, **signals and prompt amendments** learned from prior runs, and
**Chat** as the way to work — every Pomni verb behind a confirm. 46 test files, 861 tests
passed, 1 skipped.

**In progress:** POMN-47 (context packs: an agent starting from the item's touched files and
what other agents already found) and POMN-72 (this roadmap rewrite).

**Next:** POMN-73 (JSON output and exit codes on every command), POMN-74 (draining the queue
unattended past wave 1), POMN-75 (notifications for questions, red gates and landed work).
See `pomni backlog list` for the rest.
