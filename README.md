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
  "boards": { "project": { "project_id": 1 } },
  "users": {
    "architect": { "username": "architect", "user_id": 3, "token": "<api token>" }
  }
}
```

`users` is an optional pool of Kanboard accounts (see *Per-agent identity* below).
The top-level `username`/`token`/`user_id` remain the default acting user.

### Active board resolution (first match wins)

1. Env `KANBOARD_BOARD` — a board name from the registry.
2. Nearest `.pi/kanboard.json` walking up from `cwd` (to the git root, or the
   filesystem root when there is no git repo). Format: `{"board":"project"}`.
3. The registry `default` board.

An unknown board name produces an error listing the available boards.

### Per-agent identity (who acts)

Accounts from the `users` pool can be bound to agents. On every tool call the extension resolves *who* is acting:

1. Active agent name — from the `<active_agent name="...">` tag that [pi-minimal-subagent](https://github.com/urec56/pi-minimal-subagent) injects into subagent system prompts (an `active_agent` custom session entry works too).
2. The top-level **`user:`** key in the agent file's frontmatter, looked up in `~/.pi/agent/agents/<name>.md`, then project `.pi/agents/<name>.md` (project wins):

   ```markdown
   ---
   name: architect
   description: "..."
   user: architect  # key into the registry users pool
   ---
   ```

3. That pool entry's credentials are used for all API calls; `createComment` stamps its `user_id`.

Fallbacks and errors:

- No active agent (parent session) → default registry user (`username`/`token`).
- Agent file missing, or no `user:` key → default registry user.
- `user:` value not in the pool → hard error listing known users (fail loud, never a silent fallback).

`kanban_board` reports the resolved identity as `as: <username> (user_id=<N>)`. Trust model: resolution is declarative and local — any session can declare any agent name. Intended for single-machine dev boards, not multi-tenant security.

## Tools

| Tool | Purpose |
| --- | --- |
| `kanban_board` | Active board (name, project_id, url) + resolved acting user (`as`) + columns + swimlanes |
| `kanban_list_tasks` | List tasks (open/closed) or search by `query` |
| `kanban_my_tasks` | List tasks assigned to the resolved Kanboard user of the current session/agent (open by default) |
| `kanban_get_task` | Get one task by `task_id` |
| `kanban_create_task` | Create a task, returns `task_id` |
| `kanban_update_task` | Update task fields (only provided ones) |
| `kanban_move_task` | Move a task to a column/position (swimlane defaults to current; position 0/omitted = append to end, since the API rejects position 0) |
| `kanban_close_task` | Close a task |
| `kanban_reopen_task` | Reopen a closed task |
| `kanban_add_comment` | Add a comment (posted by the resolved Kanboard user — see *Per-agent identity*) |
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
