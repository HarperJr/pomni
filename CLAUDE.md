# Working inside Pomni

You are in the Pomni harness repo. Pomni manages *other* projects: their repos, their
backlog, the commands that build and test them, and the agent workflows that do work on them.

## Use the CLI to change state, not the files

`.pomni/` holds the state — projects, repos, backlog items, workflows. **Read those files
freely; change them through the CLI.**

```bash
node packages/cli/bin/pomni.mjs <command>     # or `pomni` if it is on your PATH
```

Editing `.pomni/**.yaml` by hand skips three things that matter:

- **Transition guards.** An item only reaches `in_review` when the gate actually passed for
  the repos it touches. Writing `status: in_review` into the file asserts something untrue.
- **The item log.** Every transition appends a dated line saying what moved and why. A
  hand-edit leaves no trace of itself.
- **Live updates.** Writes emit events to `.pomni/events.ndjson`; a browser watching the
  project updates from them. A silent file edit is invisible until the next refetch.

The one exception is a backlog item's **prose body** — the Problem, Acceptance criteria and
Plan sections. Those are yours to edit with ordinary file tools; the body round-trips
byte-exactly, so your formatting survives. Frontmatter still goes through the CLI.

## `.pomni/` is not in the repository's history

It is gitignored, and nothing under it is tracked. A branch switch does not touch it, a `pull`
does not rewind it, and an agent run cannot sweep it into a code commit — all three of which
used to happen, and one of them cost three item specs and re-issued their ids.

So: never `git add .pomni`, and never assume the backlog travels with a clone. It is backed up
as its own git repository, in place; that is where a lost item comes back from.

## The shape of things

**Project** — a container: a backlog, gates, policy. Holds no code itself.
**Repo** — one codebase inside a project. Either cloned into `.pomni/workspace/` from a git
remote, or a folder linked in place. `pomni repo list` reports the **working directory** each
one resolves to; work from that path rather than guessing.
**Capability** — a command a repo declares (`test`, `build`, `lint`, `typecheck`). Running one
records a run.
**Gate** — an ordered list of capabilities that must pass before an item can move on.
**Workflow** — an agent pipeline: one orchestrator plus the agents it delegates to. Attached
to a project; a task picks one.

## Commands you will actually use

```bash
pomni project list                       # what exists
pomni repo list -p <project>             # where the code is
pomni backlog list -s active             # what is open
pomni backlog show <ID>                  # the full spec
pomni backlog move <ID> <status>         # runs the state machine and its guards
pomni test -p <project>                  # fans out across repos declaring `test`
pomni verify -p <project>                # the whole gate, in order
pomni runs list --failed                 # what is broken
pomni runs show <id>                     # the failing output
pomni workflow list                      # agent pipelines
```

`-p` can be omitted when there is one project, or after `pomni project use <id>`.
Item ids carry their project prefix (`ACME-12`), so the project is usually inferred.

## Rules

1. **Move an item when the work is actually there.** `--force` exists and is recorded as
   forced in the item's log; use it deliberately, and say why with `--reason`.
2. **Verify before claiming done.** `pomni verify` is the evidence. "The tests should pass"
   is not the same claim as "the tests passed", and the run store knows the difference.
3. **Never put a token in a tracked file.** Credentials are referenced by id; the secret
   lives in an env var, the `gh` CLI, or the gitignored secret file. `pomni cred` manages them.
4. **A linked repo is the user's own working tree.** Pomni never deletes it. Neither should you.
5. **Report what happened.** If a run failed, say so and quote the failure. `pomni runs show`
   gives you the output to quote.

## Slash commands

`/project`, `/backlog` and `/run` wrap the same services through the `pomni` MCP server.
They are thin — the CLI is the fuller surface, and both enforce identical rules.
