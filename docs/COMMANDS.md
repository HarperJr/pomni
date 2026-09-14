# Pomni Command Surface

One capability, several faces. Every row is the same application service reached through a
different surface. The CLI is authoritative for naming.

| Surface | Form | Status |
| --- | --- | --- |
| CLI | `pomni <noun> <verb> [args]` | shipped across project / repo / cred / run / worktree / backlog / workflow / task / provider / tool / discover / mcp / editor / serve |
| HTTP | `GET/POST/PATCH/DELETE /api/…` — see [SERVER.md](SERVER.md) | shipped |
| Web UI | `pomni serve` | shipped for projects, repos, credentials, runs, backlog |
| Slash command | `/project`, `/backlog`, `/run` inside a Claude session | shipped |
| MCP tool | `pomni_<noun>_<verb>` over `pomni mcp` | shipped |

Global flags: `--root <path>` (workspace directory; defaults to the nearest `.pomni`,
searching upward like git), `--verbose`.

## Workspace

| Command | | Does |
| --- | --- | --- |
| `pomni init` | ✓ | Create `.pomni/` in the current directory. Idempotent. Warns if git is missing. |
| `pomni serve [--port 7777] [--host] [--token] [--open]` | ✓ | Start the management server and UI. Non-loopback `--host` requires `--token` or the server refuses to start. Running by hand in a terminal is unsupervised — `POST /api/restart` is unavailable and the UI shows no restart button. Set `POMNI_SUPERVISED=1` when running under a supervisor (systemd, pm2, container restart policy) to enable restarts. |
| `pomni mcp` | ✓ | Run the MCP server over stdio (for Claude Code and other MCP clients). |
| `pomni editor [--clear]` | ✓ | What opens a file when Pomni is asked to open one — with no argument, what it would use now. `--clear` forgets the configured editor and goes back to looking on PATH. |

## Projects

A project is a container: a backlog, gates and policy. It holds no code itself.

| Command | | Does |
| --- | --- | --- |
| `pomni project create <name> [--id] [-d <text>]` | ✓ | Create a project. The id and item prefix are derived from the name and never change. |
| `pomni project list` (`ls`) | ✓ | Projects with repo counts. |
| `pomni project show <id>` | ✓ | Config, gate, and a table of repos with stack and status. |
| `pomni project edit <id>` | ✓ | Change the project's name, description, item prefix, or policies (`--auto-commit`, `--auto-push`, `--auto-mr`, `--max-cost`, `--max-turns`, `--max-session-turns`). |
| `pomni project use <id>` | ✓ | Set the default project, so `-p` can be omitted. |
| `pomni project remove <id> [--purge]` | ✓ | Unregister. `--purge` also deletes cloned working copies; linked local folders are never deleted. |

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
| ` ` `[--timeout <capability=duration>]` | ✓ | Ceiling for one capability: `test=15m`, `build=1h`, `lint=90s`, a bare number is seconds, `off` removes it. Repeatable. The capability becomes `manual`, so re-detection keeps the ceiling and stops rewriting its command. Without one the runner's default of 10 minutes applies. |
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
| `pomni cred add <name> --token <token>` | ✓ | Store in `.pomni/credentials.secret.json` (0600). |
| ` ` `[--provider] [--host] [--username] [--id]` | ✓ | `--host` is required for `--provider generic`. |
| `pomni cred list` (`ls`) | ✓ | Id, host, secret source, and whether it currently resolves. |
| `pomni cred edit <id>` | ✓ | Change a credential, or rotate its token. |
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
| `pomni backlog list [-p -s -t --priority -l -r -q]` | ✓ | Filterable list. `-s active` excludes done and cancelled. `--eligible` shows `ready` items that can run now. |
| `pomni backlog board [-p]` | ✓ | Items grouped by column. |
| `pomni backlog show <ID>` | ✓ | Frontmatter, dependency state, acceptance progress, full spec. |
| `pomni backlog edit <ID> [--title -t --priority -e -r -l --branch --touches]` | ✓ | Change fields. `--touches <comma,separated,paths>` overrides the paths parsed from the Plan section. |
| `pomni backlog move <ID> <status> [--reason] [-f] [--no-run]` | ✓ | Run a transition through the state machine. If a workflow is attached to this transition, it fires (unless `--no-run`). |
| `pomni backlog comment <ID> [text...]` | ✓ | Add a note to the item's log. |
| `pomni backlog flow [-p]` | ✓ | Show status transitions and workflows attached to each. |
| `pomni backlog block <ID> <reason>` / `unblock <ID>` | ✓ | Block, and restore the prior status on unblock. |
| `pomni backlog link <ID> --depends-on <IDs>` | ✓ | Add dependency edges (cycles refused). |
| `pomni backlog reopen <ID>` | ✓ | `done` back to `in_progress`. |
| `pomni backlog remove <ID>` (`rm`) | ✓ | Delete; refused while something depends on it. |
| `pomni backlog next [-p]` | ✓ | The highest-priority `ready` item. |
| `pomni backlog waves [-p] [--explain] [--run]` | ✓ | Group `ready` items into waves that may launch concurrently; deterministic, no model call. `--explain` prints the conflict graph and each item's path scope. `--run` launches wave 1, one item per launch, and exits non-zero if any failed. |
| `pomni backlog open <ID>` | ✓ | Open the item file in `$EDITOR`. |

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
| `→ ready` | a non-placeholder `## Plan`, and `## Problem` / `## Acceptance criteria` clear of template placeholders with at least one criterion that isn't just the title restated |
| `→ in_progress` | every `dependsOn` item is `done` |
| `→ in_review` | the project's default gate passed for the repos this item touches |
| `→ blocked` | a reason, recorded and restored from on unblock |

`--force` skips the guards and records the move as forced in the item's Log — an override
you can see afterwards rather than one that hides.

### Waves

`pomni backlog waves` groups `ready` items so that everything worth running at once actually
runs at once, instead of one launch at a time. Two items cannot share a wave when:

- one `dependsOn` the other, directly or through a chain;
- they share a repo that cannot give each concurrent run its own worktree (see
  `worktrees` policy, [DATA-MODEL.md](DATA-MODEL.md) §5) — a repo that can isolate runs no
  longer conflicts merely for being shared;
- their `## Plan` sections (or a declared `touches` override) name overlapping paths.

An item whose scope names no paths is read as touching its whole repo, so it never shares a
wave with anything else in that repo. A `ready` item whose dependency is neither `done` nor
itself in the plan is reported as blocked and placed in no wave.

## Tasks — agent-driven work

| Command | Reads | Writes | Does |
| --- | --- | --- | --- |
| `pomni task run [text...]` | backlog, workflow spec, project rules | run record, transcript, branch | start an agent to work on a backlog item or free-form prompt |
| `pomni task resume <id> [note...]` | transcript and run state | transcript | continue a paused or failed task |
| `pomni task rerun <id>` | original run spec | new run record | start a new run with the same backlog item |
| `pomni task spend <turns> <cost>` | current task | budget adjustment | extend the budget of a running task |
| `pomni task questions` | current task | — | list pending questions awaiting answers |
| `pomni task answer <questionId> [text...]` | backlog, current task | transcript | answer a question and resume the task |
| `pomni task comment <id> [text...]` | — | run transcript | add a note to a run |
| `pomni task show <id>` | run record | — | one task: transcript, cost, status, decision log |
| `pomni task cancel <id>` | run state | — | stop a running task |
| `pomni task list [-p]` | run records | — | task history with status, cost and duration |

## Workflows — agent pipelines

Workflows are agent orchestrations: an entry orchestrator plus delegated agents, with per-step
control, budget enforcement, and a structured transcript. A task can run one, or wire one
to a backlog transition.

| Command | | Does |
| --- | --- | --- |
| `pomni workflow create <name>` | ✓ | Create a workflow. Starts with no agents. |
| `pomni workflow list` (`ls`) | ✓ | Workflows with agent counts and validation status. |
| `pomni workflow show <id>` | ✓ | Full detail: agents, role, struggle, provider, prompt. |
| `pomni workflow lint <id>` | ✓ | Validate: all agents have prompts, entry is an orchestrator, graph is acyclic. |
| `pomni workflow signals [id]` | ✓ | Amendments to prompts based on prior failures; edit per agent. |
| `pomni workflow amend <workflow> <agent>` | ✓ | Modify an agent's prompt. |
| `pomni workflow generate <id>` | ✓ | Auto-generate an orchestrator and agents from a spec. |
| `pomni workflow export <id>` | ✓ | Write the workflow as a YAML file. |
| `pomni workflow import <path>` | ✓ | Load a workflow from YAML. |
| `pomni workflow attach <id>` | ✓ | Wire a workflow to a backlog transition (fires on → that status). |
| `pomni workflow detach <id>` | ✓ | Unwire a workflow from a transition. |
| `pomni workflow remove <id>` (`rm`) | ✓ | Delete a workflow. |

## Workflow agents

| Command | | Does |
| --- | --- | --- |
| `pomni workflow agent add <workflow> <name>` | ✓ | Add an agent to a workflow. Starts as a delegated agent. |
| `pomni workflow agent prompt <workflow> <agent>` | ✓ | Show the agent's current prompt. |
| `pomni workflow agent edit <workflow> <agent>` | ✓ | Write or modify an agent's prompt. |
| `pomni workflow agent show <workflow> <agent>` | ✓ | Agent detail: role, struggle, provider, model, tools. |
| `pomni workflow agent remove <workflow> <agent>` (`rm`) | ✓ | Remove an agent. |

## Providers — LLM accounts

Providers are credential pairs: an LLM type and a model, with a billing account. A workflow
agent picks one; several can coexist.

| Command | | Does |
| --- | --- | --- |
| `pomni provider list` | ✓ | Available providers with type, model and default status. |
| `pomni provider add <label>` | ✓ | Add a provider: set its type (anthropic, openai, …), model, and billing account. |
| `pomni provider use <id>` | ✓ | Set the default provider for new workflows. |
| `pomni provider models <id>` | ✓ | List models available for a provider. |
| `pomni provider remove <id>` (`rm`) | ✓ | Forget a provider and its billing account. |

## Tools and assets — MCP servers and CLI programs

Agents can use MCP servers and CLI programs registered with Pomni. `pomni tool` manages
both. An asset is one MCP server's export; a tool is a registration that binds it to an account
or path.

| Command | | Does |
| --- | --- | --- |
| `pomni tool list` | ✓ | Registered MCP servers and CLI programs. |
| `pomni tool show <id>` | ✓ | One tool: description, tools it exports, attached assets. |
| `pomni tool add <name>` | ✓ | Register a new MCP server or CLI program. |
| `pomni tool edit <id>` | ✓ | Change a tool's config (path, env vars, description). |
| `pomni tool rm <id>` | ✓ | Unregister a tool. |
| `pomni tool attach <id>` | ✓ | Bind an asset (account, API key, …) to a tool. |
| `pomni tool detach <id>` | ✓ | Unbind an asset. |
| `pomni tool check [ids...]` | ✓ | Validate that each tool's MCP server or program is on PATH and working. |

## Discovery — assets in remote MCP registries

Assets are published bindings between MCP servers and external accounts (GitHub, Linear,
Figma, …). `pomni discover` finds them; `pomni tool import` adds one locally.

| Command | | Does |
| --- | --- | --- |
| `pomni discover list` | ✓ | Assets available to import. |
| `pomni discover show <assetId>` | ✓ | One asset: server type, docs, what account it needs. |
| `pomni discover import <assetId>` | ✓ | Add an asset to the local tool registry. |

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

The M3 feature loop (spec, plan, implement, verify, land) shipped as `pomni task run` and
`pomni backlog waves --run`, not as the originally planned `/feature spec|plan|implement|
verify|land`. POMN-47 (context packs: an agent starting from an item's touched files and what
other agents already found) is still open.
