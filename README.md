# pi-kanboard

Scoped Kanboard (kanban) tools for [pi](https://pi.dev). The extension talks to a
Kanboard JSON-RPC API and injects `project_id` (and `user_id` for comments)
**inside** the extension, so the agent can only act on the *active* board — none
of the tools accept a `project_id` parameter.

## Config

Board registry: `~/.pi/agent/kanboard.json`

```json
{
  "url": "http://localhost:8090",
  "username": "admin",
  "token": "<api token>",
  "user_id": 1,
  "default": "project",
  "boards": { "project": { "project_id": 1 } }
}
```

### Active board resolution (first match wins)

1. Env `KANBOARD_BOARD` — a board name from the registry.
2. Nearest `.pi/kanboard.json` walking up from `cwd` (to the git root, or the
   filesystem root when there is no git repo). Format: `{"board":"project"}`.
3. The registry `default` board.

An unknown board name produces an error listing the available boards.

## Tools

| Tool | Purpose |
| --- | --- |
| `kanban_board` | Active board (name, project_id, url) + columns + swimlanes |
| `kanban_list_tasks` | List tasks (open/closed) or search by `query` |
| `kanban_get_task` | Get one task by `task_id` |
| `kanban_create_task` | Create a task, returns `task_id` |
| `kanban_update_task` | Update task fields (only provided ones) |
| `kanban_move_task` | Move a task to a column/position (swimlane defaults to current; position 0/omitted = append to end, since the API rejects position 0) |
| `kanban_close_task` | Close a task |
| `kanban_reopen_task` | Reopen a closed task |
| `kanban_add_comment` | Add a comment (posted as the registry user) |
| `kanban_list_comments` | List comments of a task |
| `kanban_add_subtask` | Add a subtask (`time_estimate` in seconds) |
| `kanban_list_subtasks` | List subtasks of a task |
| `kanban_update_subtask` | Update a subtask (`status`: todo/started/done) |
| `kanban_list_columns` | List columns of the active board |
| `kanban_list_swimlanes` | List active swimlanes |

There is intentionally **no** delete/remove tool.

## Command

- `/board` — show the resolved active board (like `kanban_board`).
- `/board <name>` — validate the name against the registry and write
  `{"board":"<name>"}` to `.pi/kanboard.json` at the project root (the nearest
  git root, or the filesystem root), creating `.pi/` if needed.

## Install

```bash
pi install git:github.com/urec56/pi-kanboard
```

No npm dependencies; uses Node's built-in `fetch`.

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 urec56.
