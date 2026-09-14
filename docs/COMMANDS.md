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
searching upward like git), `--verbose`, `--json` (JSON output on stdout; errors are `{ error: { code, message, … } }` with documented exit codes).

## Workspace

| Command | | Does |
| --- | --- | --- |
| `pomni init` | ✓ | Create `.pomni/` in the current directory. Idempotent. Warns if git is missing. |
| `pomni serve [--port 7777] [--host] [--token] [--open]` | ✓ | Start the management server and UI. Non-loopback `--host` requires `--token` or the server refuses to start. Running by hand in a terminal is unsupervised — `POST /api/restart` is unavailable and the UI shows no restart button. Set `POMNI_SUPERVISED=1` when running under a supervisor (systemd, pm2, container restart policy) to enable restarts. |
| `pomni mcp` | ✓ | Run the MCP server over stdio (for Claude Code and other MCP clients). |
| `pomni editor [--clear]` | ✓ | What opens a file when Pomni is asked to open one — with no argument, what it would use now. `--clear` forgets the configured editor and goes back to looking on PATH. |
| `pomni notify test [-p]` | ✓ | Send a sample notification to every configured channel. Never deduped; exits 1 if any channel failed. |

Notifications are configured in `.pomni/config.yaml`, both channels off by default:

```yaml
notify:
  desktop: true                 # a toast on the machine running `serve`
  webhook:
    url: https://hooks.example/pomni
    credential: hooks-secret    # a `pomni cred` id; its secret signs the body (X-Pomni-Signature)
  baseUrl: https://pomni.example  # the link in each notification, when it is not server.host:port
```

Three moments notify, each once: a run asks a person a question, a run's gate goes red, and an
item lands in `in_review` with a merge request. The subscriber lives in `serve` — the one
long-lived process — so a run started from the CLI is still noticed, through the shared event
stream. A channel failing is logged and never fails the run. The webhook body is in `SERVER.md` §7.

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
| `pomni backlog move <ID> <status> [--comment\|--reason <text>] [-f] [--no-run]` | ✓ | Run a transition through the state machine. `--comment` is why, recorded in the item's log and history (`--reason` is its alias). `-f` skips the guards and is recorded as forced. If a workflow is attached to this transition it fires, unless `--no-run`. |
| `pomni backlog comment <ID> [text...]` | ✓ | Write a note on an item — with no text, read the notes already there. |
| `pomni backlog flow [-p]` | ✓ | Show status transitions and workflows attached to each. |
| `pomni backlog block <ID> <reason>` / `unblock <ID>` | ✓ | Block, and restore the prior status on unblock. |
| `pomni backlog link <ID> --depends-on <IDs>` | ✓ | Add dependency edges (cycles refused). |
| `pomni backlog reopen <ID>` | ✓ | `done` back to `in_progress`. |
| `pomni backlog remove <ID>` (`rm`) | ✓ | Delete; refused while something depends on it. |
| `pomni backlog next [-p]` | ✓ | The highest-priority `ready` item. |
| `pomni backlog waves [-p] [--explain] [--run] [--all]` | ✓ | Group `ready` items into waves that may launch concurrently; deterministic, no model call. `--explain` prints the conflict graph and each item's path scope. `--run` launches wave 1, one item per launch, and exits non-zero if any failed. `--all` with `--run` drains the ready queue unattended: launches wave 1, waits for all its runs, re-plans from the current backlog, launches the next wave, and continues until no ready item remains or a stop condition is hit. `--all` requires `--run`. |
| ` ` `[--keep-going]` | ✓ | With `--all`, a red gate skips only that item's dependents instead of stopping the drain. |
| ` ` `[--max-items <n>]` | ✓ | With `--all`, stop the drain after it has launched this many items. |
| ` ` `[--max-cost <usd>]` | ✓ | With `--all`, stop the drain once its runs have spent this much. |
| ` ` | | On the shipped default flow, a passing run lands its item in `in_review`, and dependencies are only satisfied at `done`, so a drain typically completes after one wave (or stops early). The summary reports how many items are still blocked on unfinished dependencies; the drain does not merge. |
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

## Tasks — agent pipeline runs

A task is one run of a workflow: an orchestrator and the agents it delegates to, working in a
per-run worktree of each repo, verified by the gate, and — under the project's policy —
committed, pushed and opened as a merge request. Descriptions below are the CLI's own.

| Command | | Does |
| --- | --- | --- |
| `pomni task run [text...] [-p] [-w] [-i <ID>] [-r] [-f <path>] [--no-sync]` | ✓ | Run a task, or a backlog item, through a workflow. `-i` makes the item's spec the task; `-f` attaches a file as context (repeat for several); `--no-sync` skips the fast-forward of the repos first. |
| `pomni task resume <id> [note...]` | ✓ | Carry on an interrupted run, keeping what it already did. |
| `pomni task rerun <id>` | ✓ | Run a finished run again, telling the agents why the last one ended. |
| `pomni task spend [-p]` | ✓ | What the pipelines have been costing, run by run. A report; budgets are set with `project edit`. |
| `pomni task questions [-p]` | ✓ | What the running pipelines are waiting to be told. |
| `pomni task answer <questionId> [text...] [-f <path>]` | ✓ | Answer a question a run is waiting on; `-f` attaches a file with the answer. |
| `pomni task comment <id> [text...]` | ✓ | Write a note on a run — with no text, read the notes already there. |
| `pomni task show <id>` | ✓ | One run, broken down by agent — which one was expensive. Or a drain, broken down by wave and why it stopped. |
| `pomni task cancel <id>` | ✓ | Stop a run, or close out one whose process is gone. |
| `pomni task list [-p]` | ✓ | Recent pipeline runs and drains. In `--json` mode, returns `{ runs, drains }` instead of a bare runs array. |

## Workflows — agent pipelines

A workflow is an orchestrator plus the agents it may delegate to, each with a spec, a
struggle level, an optional provider and the tools it is granted. Attached to a project; a
task picks one.

| Command | | Does |
| --- | --- | --- |
| `pomni workflow create <name>` | ✓ | Create a workflow. |
| `pomni workflow list` (`ls`) | ✓ | List workflows. |
| `pomni workflow show <id>` | ✓ | Show a workflow and its agents. |
| `pomni workflow lint <id>` | ✓ | What each agent will carry on every turn, before a run pays for it. |
| `pomni workflow signals [id]` | ✓ | What keeps going wrong in a workflow, from the runs that already happened. |
| `pomni workflow amend <workflow> <agent>` | ✓ | Propose a spec change from what keeps going wrong, and never apply it silently. |
| `pomni workflow generate <id>` | ✓ | Generate the system prompt for every agent that has a spec but no prompt. |
| `pomni workflow export <id> [-o <path>]` | ✓ | Write a workflow to a portable file (default `<id>.pomni.json`). |
| `pomni workflow import <path>` | ✓ | Import a workflow file. |
| `pomni workflow attach <id> [-p]` | ✓ | Attach a workflow to a project. |
| `pomni workflow detach <id> [-p]` | ✓ | Detach a workflow from a project. |
| `pomni workflow remove <id>` (`rm`) | ✓ | Delete a workflow. |

### Agents inside a workflow

| Command | | Does |
| --- | --- | --- |
| `pomni workflow agent add <workflow> <name>` | ✓ | Add an agent. |
| `pomni workflow agent prompt <workflow> <agent>` | ✓ | Generate the agent's system prompt from its spec. |
| `pomni workflow agent edit <workflow> <agent> [-n] [-r] [-s\|--spec-file] [--prompt-file] [-m] [--provider] [-o] [--delegates-to] [--tools] [--files\|--no-files] [--run\|--no-run] [--verify\|--no-verify] [--web\|--no-web]` | ✓ | Change an agent: its name, role (`orchestrator` \| `agent`), spec, prompt, struggle level, provider, outputs, delegates, tool grants, and whether it may touch files, run commands, run the repos' declared checks without a shell, or search the web. |
| `pomni workflow agent show <workflow> <agent>` | ✓ | Show an agent and its prompt. |
| `pomni workflow agent remove <workflow> <agent>` (`rm`) | ✓ | Remove an agent. |

## Providers — where models run

A provider is where an agent's model runs: Claude Code, an API key, or a local
openai-compatible endpoint. Each names a model per struggle level (`low`, `medium`, `high`,
`max`); an agent picks a provider, or inherits the run's.

| Command | | Does |
| --- | --- | --- |
| `pomni provider list` | ✓ | Providers and whether each one works right now. |
| `pomni provider add <label> [-k claude-code\|anthropic\|openai] [--id] [-u <base-url>] [--api-key-env <VAR>] [--low\|--medium\|--high\|--max <model>]` | ✓ | Add a provider. The key is named by env var, never given. |
| `pomni provider use <id>` | ✓ | Make this the default provider. |
| `pomni provider models <id>` | ✓ | Ask an openai-compatible endpoint what models it serves. |
| `pomni provider remove <id>` (`rm`) | ✓ | Remove a provider. |

## Tools — MCP servers and CLI programs

A tool is an MCP server or a CLI program an agent may be granted. Registered once, attached
to projects, and granted per agent with `workflow agent edit --tools`.

| Command | | Does |
| --- | --- | --- |
| `pomni tool list` (`ls`) | ✓ | Every registered tool. |
| `pomni tool show <id>` | ✓ | Everything about one tool. |
| `pomni tool add <name> [--cli --bin] [--mcp --command --arg\|--http\|--sse] [-d] [-u\|--usage-file] [--env] [--env-from] [--credential --credential-env] [--check] [-p]` | ✓ | Register an MCP server or a CLI program. `-u` is how to drive it — the part agents actually need; `--check` is a command that proves it works; `-p` attaches it to a project straight away. |
| `pomni tool edit <id>` | ✓ | Change a registered tool. |
| `pomni tool rm <id>` | ✓ | Remove a tool, and detach it from every project. |
| `pomni tool attach <id> [-p]` | ✓ | Make a tool available to a project. |
| `pomni tool detach <id> [-p]` | ✓ | Take a tool away from a project. |
| `pomni tool check [ids...]` | ✓ | Run each tool's check command. |

## Discovery — agents, skills and rules already in a repo

`pomni discover` scans a project's repos for the agents, skills and rules they already carry
(`.claude/agents`, skills, `CLAUDE.md`-style rules) and can bring an agent into a workflow.

| Command | | Does |
| --- | --- | --- |
| `pomni discover list [-p]` | ✓ | Scan the repos and list what is there. |
| `pomni discover show <assetId>` | ✓ | Print a discovered asset in full. |
| `pomni discover import <assetId> [--into <workflow>] [-p]` | ✓ | Add a discovered agent to a workflow, prompt and all. |

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

## Exit codes

Every command exits 0 on success, or non-zero when the answer is "no", bad usage, or something
does not exist.

| Code | Meaning | Examples |
| --- | --- | --- |
| 0 | Success | command ran, answer is "yes" |
| 1 | Command ran; answer is "no" | `verify` with a red gate, `task run\|resume\|rerun` ending other than `passed`, `backlog waves --all` ending other than completed with all runs passed, `backlog move` refused by guard, `tool check` failed, `worktree prune` with failures, `cred test\|repo doctor` failed |
| 2 | Bad usage | unknown option or argument, invalid flag combination, malformed input |
| 3 | Not found or not initialized | workspace not initialized (`pomni init` needed), item/run/repo/project/credential/workflow/tool/provider does not exist, referenced asset missing |

## `--json`

The global `--json` flag makes every command output structured data instead of formatted text.

**Output:**
- Commands that report a single result (`backlog show`, `run list`, `project list`, etc.)
  emit one JSON object on stdout.
- Streaming commands (`verify`, `runs tail`, `task run|resume|rerun`, `backlog waves --run`)
  emit one JSON object per line, with the final line being the finished object (a `GateReport`
  for `verify`, a `Run` for task commands, etc.). Progress and live updates are on stderr.
- Nothing else touches stdout — no progress bars, no tables, no warnings.
- Progress, warnings, and other human-oriented text go to stderr.

**Errors:**
- In JSON mode, errors are `{ error: { code, message, details?, unmet? } }` on stdout.
- The exit code is the same as it would be in human mode (0-3, per the table above).
- `unmet` is present only for transition guards and gates — it lists what blocked the move
  (dependencies not met, scope conflict, gate failure, etc.).
- `details` may contain structured context for programmatic inspection.

**Compatibility:**
- A document is the object the service returned — the same object the MCP tool for that verb
  hands to an MCP client, since both call the same service. The shapes are the domain types in
  `packages/core/src/domain/` (`BacklogItem`, `Run`, `PipelineRun`, `GateReport`, …).
- Scripts should rely on exit codes for the answer, not on parsing prose.
