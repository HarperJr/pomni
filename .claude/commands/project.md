---
description: Inspect Pomni projects and their repos
argument-hint: "[list|show <id>]"
allowed-tools: mcp__pomni__pomni_project_list, mcp__pomni__pomni_repo_list
---

Show Pomni projects. Arguments: `$ARGUMENTS`

- `list` or nothing → `pomni_project_list`
- `show <id>` → `pomni_repo_list` for that project

`pomni_repo_list` reports each repo's **working directory** — that is where the code actually
is. A repo may be a clone Pomni manages under `.pomni/workspace/`, or a folder linked in
place. Always work from the reported path rather than guessing.
