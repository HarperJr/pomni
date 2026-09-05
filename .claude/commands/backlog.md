---
description: Manage the Pomni backlog — list, show, add, or move items
argument-hint: "[list|show|add|move] [args]"
allowed-tools: mcp__pomni__pomni_backlog_list, mcp__pomni__pomni_backlog_show, mcp__pomni__pomni_backlog_add, mcp__pomni__pomni_backlog_move, mcp__pomni__pomni_backlog_edit, mcp__pomni__pomni_project_list
---

Act on the Pomni backlog using the `pomni` MCP tools. Arguments: `$ARGUMENTS`

Interpret the arguments the way the CLI would:

- `list [status]` → `pomni_backlog_list` (default status `active`)
- `show <ID>` → `pomni_backlog_show`
- `add <title>` → `pomni_backlog_add`
- `move <ID> <status>` → `pomni_backlog_move`

If no project is obvious, call `pomni_project_list` first and use the only project, or ask
which one when there are several. Item ids carry their project prefix (`ACME-12`), so you can
usually infer the project from the id.

After capturing a new item, offer to fill in its Problem and Acceptance criteria sections —
an item cannot move to `specced` without them. Edit the item file directly with your normal
file tools; the body round-trips byte-exactly, so your formatting is preserved.

Report what changed in one or two lines. Do not restate the whole item unless asked.
