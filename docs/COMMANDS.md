# Pomni Command Surface

One capability, several faces. Every row is the same application service reached through a
different surface. The CLI is authoritative for naming.

| Surface | Form | Status |
| --- | --- | --- |
| CLI | `pomni <noun> <verb> [args]` | shipped for project / repo / cred / run / worktree / backlog / serve |
| HTTP | `GET/POST/PATCH/DELETE /api/…` — see [SERVER.md](SERVER.md) | shipped |
| Web UI | `pomni serve` | shipped for projects, repos, credentials, runs, backlog |
| Slash command | `/project`, `/backlog`, `/run` inside a Claude session | shipped |
| MCP tool | `pomni_<noun>_<verb>` over `pomni mcp` | shipped |

Global flags: `--root <path>` (workspace directory; defaults to the nearest `.pomni`,
searching upward like git), `--verbose`.

Legend: **✓** shipped · **·** designed, not yet built.

## Workspace

| Command | | Does |
| --- | --- | --- |
| `pomni init` | ✓ | Create `.pomni/` in the current directory. Idempotent. Warns if git is missing. |
| `pomni serve [--port 7777] [--host] [--token] [--open]` | ✓ | Start the management server and UI. Non-loopback `--host` requires `--token` or the server refuses to start. |
| `pomni doctor [--repair]` | · | Environment, registry and database integrity. |
| `pomni config get/set <key> [value]` | · | Read/write `.pomni/config.yaml`. |

## Projects

A project is a container: a backlog, gates and policy. It holds no code itself.

| Command | | Does |
| --- | --- | --- |
| `pomni project create <name> [--id] [-d <text>]` | ✓ | Create a project. The id and item prefix are derived from the name and never change. |
| `pomni project list` (`ls`) | ✓ | Projects with repo counts. |
| `pomni project show <id>` | ✓ | Config, gate, and a table of repos with stack and status. |
| `pomni project remove <id> [--purge]` | ✓ | Unregister. `--purge` also deletes cloned working copies; linked local folders are never deleted. |
| `pomni project use <id>` | ✓ | Set the default project, so `-p` can be omitted. |

## Repos

A repo is one codebase inside a project, reached either by cloning a remote or by linking a
folder already on this machine.

| Command | | Does |
| --- | --- | --- |
| `pomni repo add <target> -p <project>` | ✓ | Add a repo. `<target>` is a git url (cloned into the workspace) or a local path (linked in place); the shape decides, `--path` / `--url` override. |
| ` ` `[--ref <ref>]` | ✓ | Branch or tag to check out (git only). |
| ` ` `[-c, --credential <id>]` | ✓ | Credential to authenticate with. Omitted, Pomni matches one by host. |
| ` ` `[--id <id>] [-n <name>] [-r <role>]` | ✓ | Explicit id, display name, role (`web api mobile desktop lib infra docs other`). |
| `pomni repo list [-p <project>]` (`ls`) | ✓ | Repos with role, status, stack, source, and which runs currently hold a worktree on it. All projects when `-p` is omitted. |
| `pomni repo show <project/repo>` | ✓ | Full detail: source, working directory, stack, git branch and dirtiness, capabilities. |
| `pomni repo sync <project/repo>` | ✓ | Fetch (if a clone) and re-detect stack and capabilities. Manual capability overrides survive. |
| `pomni repo edit <project/repo> [-n] [-r] [--url] [--ref] [-c] [--provider] [--reclone]` | ✓ | Change a repo's name, role, or — for a clone — its url, branch or credential. |
| ` ` `[--worktrees <auto\|always\|never>]` | ✓ | Whether a pipeline run gets its own checkout of this repo. `auto` (default) isolates a clone but shares a linked repo; `always` isolates a linked repo too; `never` shares this repo's directory across every run. |
| `pomni repo remove <project/repo> [--purge]` (`rm`) | ✓ | Remove from the project. `--purge` deletes the cloned copy; a linked folder is never touched. |
| `pomni repo doctor [-p] [-r]` | ✓ | Check each repo and resolve every declared capability's executable on PATH, plus a worktrees section: an `orphaned` entry names `pomni worktree remove <id> --force` as the fix. |

```bash
pomni repo add https://github.com/acme/storefront.git -p acme-saas -r web
pomni repo add ../infra -p acme-saas -r infra
pomni repo add git@github.com:acme/api.git -p acme-saas -r api   # ssh: uses your agent
```

## Credentials

Metadata is committable; the token is a pointer resolved when git needs it.

| Command | | Does |
| --- | --- | --- |
| `pomni cred add <name> --gh` | ✓ | Delegate to the GitHub CLI (`gh auth token`). Nothing stored. |
| `pomni cred add <name> --env <VAR>` | ✓ | Read from an environment variable. Nothing stored. |
| `pomni cred add <name> --token <token>` | ✓ | Store in `.pomni/credentials.secret.json` (gitignored, 0600). |
| ` ` `[--provider] [--host] [--username] [--id]` | ✓ | `--host` is required for `--provider generic`. |
| `pomni cred list` (`ls`) | ✓ | Id, host, secret source, and whether it currently resolves. |
| `pomni cred test <id> [--url <url>]` | ✓ | Check the secret resolves; with `--url`, that the remote accepts it. |
| `pomni cred remove <id>` (`rm`) | ✓ | Forget the credential and any stored secret. |

A token credential on an `ssh://` or `git@host:` url is rejected at validation time — token
auth only works over HTTPS, and ssh urls should rely on the user's agent instead.

## Execution

Runs target a repo. Omit `--repo` and the capability fans out across every repo in the
project that declares it — a repo without a `lint` script is skipped, not failed.

| Command | | Does |
| --- | --- | --- |
| `pomni run <capability> [-p] [-r] [-q] [--bail]` | ✓ | Execute a declared capability and record a run. Streams output unless `-q`. |
| `pomni test` / `build` / `lint` / `typecheck` / `e2e` / `install` | ✓ | Shorthands for `run <capability>`. |
| `pomni verify [-p] [-r] [--land]` | ✓ | Run the project's gate: each capability in order, stopping at the first failure. |
| `pomni runs list [-p -r -c --failed -n]` | ✓ | Run history with status, summary and duration. |
| `pomni runs show <id> [--full]` | ✓ | One run: command, cwd, exit code, failed tests, log tail. Accepts the short id from `runs list`. |
| `pomni runs tail <id>` | ✓ | Follow a run that is still going. |
| `pomni runs cancel <id>` | ✓ | Stop it — by pid, so it works across processes. |
| `pomni dev [--repo]` / `pomni dev stop` | · | Start/stop a background dev capability. |

Exit code is 1 when any run fails, so `pomni verify` drops straight into a shell script or CI.

`-p` is optional when the workspace holds exactly one project, or after `pomni project use`.

## Worktrees

A pipeline run that isolates a repo (see `worktrees` policy under Repos) works in its own
checkout at `.pomni/worktrees/<project>/<repo>/<runId>`, on branch `pomni/run/<runId>`.

| Command | | Does |
| --- | --- | --- |
| `pomni worktree list [-p] [-r]` (`ls`) | ✓ | Live worktrees, one per pipeline run: id, repo, run, branch, state, path. |
| `pomni worktree prune [-p]` | ✓ | Remove orphaned worktrees (owning run no longer alive). A `kept` worktree — uncommitted changes — is reported and left alone. |
| `pomni worktree remove <id> [--force]` | ✓ | Remove one worktree by id. Refuses a live or kept worktree unless `--force`. |

`git worktree remove` is never called with `--force` internally: a worktree with uncommitted
changes is marked `kept` instead of being removed, so an agent's unfinished work is never lost
to cleanup. There is no HTTP route for pruning or removing — those delete directories and stay
a deliberate CLI act.

## Backlog

Items are Markdown files under `.pomni/projects/<id>/backlog/`. The frontmatter is structure
the engine enforces; the body is prose you and an agent both edit. `pomni b` is an alias.

| Command | | Does |
| --- | --- | --- |
| `pomni backlog add <title> [-p -t --priority -e -r -l --depends-on]` | ✓ | Capture an item. Starts in `backlog` with a spec template. |
| `pomni backlog list [-p -s -t --priority -l -r -q]` | ✓ | Filterable list. `-s active` excludes done and cancelled. |
| `pomni backlog board [-p]` | ✓ | Items grouped by column. |
| `pomni backlog show <ID>` | ✓ | Frontmatter, dependency state, acceptance progress, full spec. |
| `pomni backlog edit <ID> [--title -t --priority -e -r -l --branch]` | ✓ | Change fields. |
| `pomni backlog move <ID> <status> [--reason] [-f]` | ✓ | Run a transition through the state machine. |
| `pomni backlog block <ID> <reason>` / `unblock <ID>` | ✓ | Block, and restore the prior status on unblock. |
| `pomni backlog link <ID> --depends-on <IDs>` | ✓ | Add dependency edges (cycles refused). |
| `pomni backlog reopen <ID>` | ✓ | `done` back to `in_progress`. |
| `pomni backlog remove <ID>` (`rm`) | ✓ | Delete; refused while something depends on it. |
| `pomni backlog next [-p]` | ✓ | The highest-priority `ready` item. |
| `pomni backlog open <ID>` | ✓ | Open the item file in `$EDITOR`. |
| `pomni backlog groom [-p]` | · | Agent-assisted dedupe and re-prioritisation (M5). |

The project is usually inferred from the item id (`ACME-12` → project with prefix `ACME`),
so `-p` is rarely needed.

### Transitions and their guards

```
backlog ─► specced ─► ready ─► in_progress ─► in_review ─► done
                                    │              │
                                 blocked ◄─────────┘      (reopen ─► in_progress)
```

| Transition | Guard |
| --- | --- |
| `→ specced` | a non-placeholder `## Problem`, and at least one `- [ ]` acceptance criterion |
| `→ ready` | a non-placeholder `## Plan` |
| `→ in_progress` | every `dependsOn` item is `done` |
| `→ in_review` | the project's default gate passed for the repos this item touches |
| `→ blocked` | a reason, recorded and restored from on unblock |

`--force` skips the guards and records the move as forced in the item's Log — an override
you can see afterwards rather than one that hides.

## Feature loop — M3

| Command | Reads | Writes | Transition |
| --- | --- | --- | --- |
| `pomni feature spec <id>` | title, conventions, codebase survey | problem, acceptance criteria | `backlog → specced` |
| `pomni feature plan <id>` | spec, file map, dependencies | file-level plan | `specced → ready` |
| `pomni feature implement <id>` | context pack | code, on a branch | `ready → in_progress` |
| `pomni verify <id>` | project gate | run records, failure summary | `in_progress → in_review` |
| `pomni feature land <id> [--pr]` | land gate | commit, optional PR | `in_review → done` |
| `pomni feature next [-p]` | backlog | picks the top `ready` item and implements it | — |

## Slash commands and MCP tools

Shipped slash commands in `.claude/commands/`, thin by construction — they parse arguments,
call an MCP tool, and render the result for the session to act on:

```
/project   list | show <id>
/backlog   list | show <ID> | add <title> | move <ID> <status>
/run       test | build | lint | typecheck | verify
```

`.mcp.json` registers the server, which `pomni mcp` runs over stdio. Eleven tools:

```
Read:   pomni_project_list, pomni_repo_list, pomni_backlog_list, pomni_backlog_show,
        pomni_runs_list, pomni_run_log
Write:  pomni_backlog_add, pomni_backlog_move, pomni_backlog_edit
Exec:   pomni_run, pomni_verify
```

`pomni_repo_list` is the one a session reaches for first: it reports the **working
directory** each repo resolves to, which is where the code actually is — a managed clone
under `.pomni/workspace/`, or a folder linked in place.

There is deliberately no tool that runs an arbitrary shell command. `pomni_run` executes
only capabilities a repo already declared.

A `SessionStart` hook injects the project list, the active backlog and recent run failures,
so a session begins knowing what exists.

Planned: `/feature spec|plan|implement|verify|land` and `pomni_context_pack` (M3), which
given an item id returns everything needed to start work — conventions, spec, dependency
outcomes, touched files, the tail of the last failing run, and each repo's working directory.
