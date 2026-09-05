---
description: Run a declared capability, or the whole gate, across a Pomni project
argument-hint: "[test|build|lint|typecheck|verify] [repo]"
allowed-tools: mcp__pomni__pomni_run, mcp__pomni__pomni_verify, mcp__pomni__pomni_runs_list, mcp__pomni__pomni_run_log, mcp__pomni__pomni_repo_list, mcp__pomni__pomni_project_list
---

Run something in a Pomni project. Arguments: `$ARGUMENTS`

- A capability name (`test`, `build`, `lint`, `typecheck`, `e2e`) → `pomni_run`
- `verify` → `pomni_verify`, which runs the project's whole gate in order
- No arguments → `pomni_runs_list` to show what has run recently

These execute only commands the repo already declared; you cannot pass an arbitrary shell
command through them.

If anything fails, call `pomni_run_log` for that run and explain the actual failure — quote
the relevant lines rather than summarising vaguely. Then say what you would change, but do
not change it unless asked.
