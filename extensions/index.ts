/**
 * pi-kanboard — scoped Kanboard (kanban) tools for pi.
 *
 * Reads the board registry from ~/.pi/agent/kanboard.json and injects
 * project_id (and user_id for comments) INSIDE the extension, so the LLM
 * cannot target a board other than the active one. None of the tools accept
 * a project_id parameter.
 *
 * Active board resolution (first match wins):
 *   1. env KANBOARD_BOARD (a board name from the registry)
 *   2. nearest .pi/kanboard.json walking up from cwd (to the git root, or
 *      the filesystem root when there is no git repo), format {"board":"name"}
 *   3. the registry "default" board
 *
 * Identity resolution (who acts):
 *   active subagent name (<active_agent> tag / session entry) -> its agent
 *   file's top-level `user:` frontmatter key -> credentials from the
 *   registry "users" pool. No tag, no agent file, or no `user:` key -> the
 *   registry default user. An unknown `user` value is a hard error.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface PoolUser {
	username: string;
	token: string;
	user_id: number;
}

interface Registry {
	url: string;
	username: string;
	token: string;
	user_id: number;
	default: string;
	boards: Record<string, { project_id: number }>;
	users?: Record<string, PoolUser>;
}

const REGISTRY_PATH = join(homedir(), ".pi", "agent", "kanboard.json");

function loadRegistry(): Registry {
	let raw: string;
	try {
		raw = readFileSync(REGISTRY_PATH, "utf8");
	} catch (e) {
		throw new Error(`kanboard: cannot read registry at ${REGISTRY_PATH}: ${(e as Error).message}`);
	}
	try {
		return JSON.parse(raw) as Registry;
	} catch (e) {
		throw new Error(`kanboard: registry ${REGISTRY_PATH} is not valid JSON: ${(e as Error).message}`);
	}
}

function boardNames(reg: Registry): string {
	return Object.keys(reg.boards).join(", ");
}

// ---------------------------------------------------------------------------
// Board resolution
// ---------------------------------------------------------------------------

/** Walk up from cwd to the git root (a dir containing .git), else the fs root. */
function findProjectRoot(cwd: string): string {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return dir;
		dir = parent;
	}
}

/** Nearest .pi/kanboard.json walking up from cwd, stopping at the git/fs root. */
function findBoardFile(cwd: string): string | null {
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, ".pi", "kanboard.json");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

interface ResolvedBoard {
	reg: Registry;
	name: string;
	projectId: number;
	source: string;
}

function resolveBoard(cwd: string): ResolvedBoard {
	const reg = loadRegistry();

	// 1. env KANBOARD_BOARD
	const env = process.env.KANBOARD_BOARD;
	if (env) {
		if (!reg.boards[env]) {
			throw new Error(`kanboard: KANBOARD_BOARD="${env}" is not in the registry. Available boards: ${boardNames(reg)}`);
		}
		return { reg, name: env, projectId: reg.boards[env].project_id, source: "env KANBOARD_BOARD" };
	}

	// 2. nearest .pi/kanboard.json
	const file = findBoardFile(cwd);
	if (file) {
		let data: { board?: unknown };
		try {
			data = JSON.parse(readFileSync(file, "utf8"));
		} catch (e) {
			throw new Error(`kanboard: ${file} is not valid JSON: ${(e as Error).message}`);
		}
		if (typeof data.board === "string" && data.board.length > 0) {
			if (!reg.boards[data.board]) {
				throw new Error(`kanboard: board "${data.board}" (from ${file}) is not in the registry. Available boards: ${boardNames(reg)}`);
			}
			return { reg, name: data.board, projectId: reg.boards[data.board].project_id, source: file };
		}
	}

	// 3. registry default
	const def = reg.default;
	if (!reg.boards[def]) {
		throw new Error(`kanboard: default board "${def}" is not in the registry. Available boards: ${boardNames(reg)}`);
	}
	return { reg, name: def, projectId: reg.boards[def].project_id, source: "registry default" };
}

// ---------------------------------------------------------------------------
// Identity resolution (per-agent Kanboard user)
// ---------------------------------------------------------------------------

interface Identity {
	username: string;
	token: string;
	user_id: number;
}

const ACTIVE_AGENT_TAG = /<active_agent\s+name=["']([^"']+)["'][^>]*>/i;

/** Last agent name seen via before_agent_start (system-prompt tag). */
let cachedAgentName: string | null = null;

function agentFileCandidates(cwd: string, name: string): string[] {
	// Project scopes first (nearest .pi/agents wins), then global.
	const dirs: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		dirs.push(join(dir, ".pi", "agents"));
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	dirs.push(join(homedir(), ".pi", "agent", "agents"));
	return dirs.map((d) => join(d, `${name}.md`));
}

/** Read a top-level scalar frontmatter key from an agent .md file. */
function frontmatterField(file: string, key: string): string | null {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
	if (!m) return null;
	for (const line of m[1].split(/\r?\n/)) {
		if (/^\s/.test(line)) continue; // top-level keys only
		const kv = new RegExp(`^${key}\\s*:\\s*(.+)$`).exec(line);
		if (kv) return kv[1].trim().replace(/^["']|["']$/g, "");
	}
	return null;
}

function resolveIdentity(reg: Registry, ctx: unknown, cwd: string): Identity {
	const fallback: Identity = { username: reg.username, token: reg.token, user_id: reg.user_id };

	let name: string | null = null;
	try {
		const sm = (ctx as { sessionManager?: { getEntries(): Array<Record<string, unknown>> } }).sessionManager;
		const entries = sm?.getEntries() ?? [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type !== "custom" || e.customType !== "active_agent") continue;
			const n = (e.data as { name?: unknown } | undefined)?.name;
			name = typeof n === "string" && n.trim() ? n.trim() : null;
			break; // last matching entry wins (same semantics as pi-permission-system)
		}
	} catch {
		/* ctx without sessionManager */
	}
	if (!name) name = cachedAgentName;
	if (!name) return fallback;

	const file = agentFileCandidates(cwd, name).find((p) => existsSync(p));
	if (!file) return fallback; // no agent file -> default user
	const userKey = frontmatterField(file, "user");
	if (!userKey) return fallback; // agent does not declare a Kanboard user

	const u = reg.users?.[userKey];
	if (!u) {
		throw new Error(
			`kanboard: agent "${name}" declares user "${userKey}", which is not in the registry users pool. Known: ${Object.keys(reg.users ?? {}).join(", ") || "(pool empty)"}`,
		);
	}
	return { username: u.username, token: u.token, user_id: u.user_id };
}

// ---------------------------------------------------------------------------
// JSON-RPC client
// ---------------------------------------------------------------------------

async function rpc(reg: Registry, id: Identity, method: string, params: Record<string, unknown>): Promise<unknown> {
	const url = reg.url.replace(/\/+$/, "") + "/jsonrpc.php";
	const auth = Buffer.from(`${id.username}:${id.token}`).toString("base64");
	const body = JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: `Basic ${auth}`,
			},
			body,
		});
	} catch (e) {
		throw new Error(`kanboard: cannot reach ${url}: ${(e as Error).message}`);
	}

	const text = await res.text();
	let data: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`kanboard: HTTP ${res.status} from ${url}, non-JSON response: ${text.slice(0, 300)}`);
	}

	if (data.error) {
		const err = data.error;
		const extra = err.data !== undefined ? ` (${typeof err.data === "string" ? err.data : JSON.stringify(err.data)})` : "";
		throw new Error(`Kanboard error: ${err.message ?? "unknown error"}${extra}`);
	}
	return data.result;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function toolResult(result: unknown, details?: unknown) {
	const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
	return {
		content: [{ type: "text" as const, text }],
		details: details ?? { result },
	};
}

function renderersFor(name: string) {
	return {
		renderCall(args: Record<string, unknown>, theme: Theme) {
			const parts = Object.entries(args)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => (typeof v === "string" ? `${k}=${JSON.stringify(v)}` : `${k}=${v}`));
			const suffix = parts.length > 0 ? " " + theme.fg("muted", parts.join(" ")) : "";
			return new Text(theme.fg("toolTitle", theme.bold(name)) + suffix, 0, 0);
		},
		renderResult(result: { content?: Array<{ type: string; text?: string }> }, _opts: unknown, theme: Theme) {
			const text = (result.content ?? [])
				.map((c) => (c.type === "text" ? c.text ?? "" : ""))
				.join("");
			return new Text(theme.fg("muted", text || "(no output)"), 0, 0);
		},
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Per-agent identity: remember who is active from the system-prompt tag so
	// tool executions can resolve their Kanboard user even when no session
	// entry is available. Fires per agent start; null tag -> parent session.
	pi.on("before_agent_start", (event) => {
		const sp = (event as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
		const m = ACTIVE_AGENT_TAG.exec(sp);
		cachedAgentName = m && m[1] ? m[1].trim() : null;
	});

	const boardNote =
		"The active board and its project_id are injected automatically by the extension; you cannot target other boards. Use kanban_board to see the active board, columns and swimlanes.";

	// 1. kanban_board
	pi.registerTool({
		name: "kanban_board",
		label: "Kanban Board",
		description: `Show the active Kanboard board: name, project_id, url, columns {id,title} and swimlanes {id,name}. ${boardNote}`,
		promptSnippet: "Show the active Kanboard board with its columns and swimlanes",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const [columns, swimlanes] = await Promise.all([
				rpc(bc.reg, id, "getColumns", { project_id: bc.projectId }),
				rpc(bc.reg, id, "getActiveSwimlanes", { project_id: bc.projectId }),
			]);
			const cols = (columns as Array<Record<string, unknown>>).map((c) => ({ id: Number(c.id), title: String(c.title) }));
			const lanes = (swimlanes as Array<Record<string, unknown>>).map((s) => ({ id: Number(s.id), name: String(s.name) }));
			return toolResult({
				board: bc.name,
				project_id: bc.projectId,
				url: bc.reg.url,
				source: bc.source,
				as: `${id.username} (user_id=${id.user_id})`,
				columns: cols,
				swimlanes: lanes,
			});
		},
		...renderersFor("kanban_board"),
	});

	// 2. kanban_list_tasks
	pi.registerTool({
		name: "kanban_list_tasks",
		label: "Kanban List Tasks",
		description: `List tasks on the active board. With "query" it searches (searchTasks); otherwise it lists all tasks, open by default. ${boardNote}`,
		promptSnippet: "List or search Kanboard tasks on the active board",
		parameters: Type.Object({
			status: Type.Optional(StringEnum(["open", "closed"] as const)),
			query: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const result = params.query
				? await rpc(bc.reg, id, "searchTasks", { project_id: bc.projectId, query: params.query })
				: await rpc(bc.reg, id, "getAllTasks", { project_id: bc.projectId, status_id: params.status === "closed" ? 0 : 1 });
			return toolResult(result);
		},
		...renderersFor("kanban_list_tasks"),
	});

	// 3. kanban_my_tasks
	pi.registerTool({
		name: "kanban_my_tasks",
		label: "Kanban My Tasks",
		description: `List tasks on the active board assigned to the resolved Kanboard user of the current session/agent (see "as" in kanban_board; default is the registry user). ${boardNote}`,
		promptSnippet: "List my own Kanboard tasks on the active board",
		parameters: Type.Object({
			status: Type.Optional(StringEnum(["open", "closed"] as const)),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const all = (await rpc(bc.reg, id, "getAllTasks", { project_id: bc.projectId, status_id: params.status === "closed" ? 0 : 1 })) as Array<Record<string, unknown>>;
			return toolResult(all.filter((t) => Number(t.owner_id) === id.user_id));
		},
		...renderersFor("kanban_my_tasks"),
	});

	// 4. kanban_get_task
	pi.registerTool({
		name: "kanban_get_task",
		label: "Kanban Get Task",
		description: `Get one task by id from the active board. ${boardNote}`,
		promptSnippet: "Get a single Kanboard task by id",
		parameters: Type.Object({ task_id: Type.Number() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			return toolResult(await rpc(bc.reg, id, "getTask", { task_id: params.task_id }));
		},
		...renderersFor("kanban_get_task"),
	});

	// 5. kanban_create_task
	pi.registerTool({
		name: "kanban_create_task",
		label: "Kanban Create Task",
		description: `Create a task on the active board. Returns the new task_id. ${boardNote}`,
		promptSnippet: "Create a Kanboard task on the active board",
		parameters: Type.Object({
			title: Type.String(),
			description: Type.Optional(Type.String()),
			column_id: Type.Optional(Type.Number()),
			swimlane_id: Type.Optional(Type.Number()),
			priority: Type.Optional(Type.Number()),
			date_due: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const taskId = await rpc(bc.reg, id, "createTask", {
				title: params.title,
				project_id: bc.projectId,
				column_id: params.column_id ?? 0,
				description: params.description ?? "",
				swimlane_id: params.swimlane_id ?? null,
				priority: params.priority ?? 0,
				date_due: params.date_due ?? "",
				owner_id: 0,
				score: 0,
			});
			return toolResult({ task_id: taskId });
		},
		...renderersFor("kanban_create_task"),
	});

	// 6. kanban_update_task
	pi.registerTool({
		name: "kanban_update_task",
		label: "Kanban Update Task",
		description: `Update fields of a task on the active board (only the provided fields are sent). ${boardNote}`,
		promptSnippet: "Update a Kanboard task",
		parameters: Type.Object({
			task_id: Type.Number(),
			title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			priority: Type.Optional(Type.Number()),
			date_due: Type.Optional(Type.String()),
			score: Type.Optional(Type.Number()),
			owner_id: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const p: Record<string, unknown> = { id: params.task_id };
			if (params.title !== undefined) p.title = params.title;
			if (params.description !== undefined) p.description = params.description;
			if (params.priority !== undefined) p.priority = params.priority;
			if (params.date_due !== undefined) p.date_due = params.date_due;
			if (params.score !== undefined) p.score = params.score;
			if (params.owner_id !== undefined) p.owner_id = params.owner_id;
			return toolResult(await rpc(bc.reg, id, "updateTask", p));
		},
		...renderersFor("kanban_update_task"),
	});

	// 7. kanban_move_task
	pi.registerTool({
		name: "kanban_move_task",
		label: "Kanban Move Task",
		description: `Move a task to a column/position on the active board. swimlane_id defaults to the task's current swimlane; position defaults to appending to the end of the column (the API rejects position 0). ${boardNote}`,
		promptSnippet: "Move a Kanboard task to a column",
		parameters: Type.Object({
			task_id: Type.Number(),
			column_id: Type.Number(),
			position: Type.Optional(Type.Number()),
			swimlane_id: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const task = (await rpc(bc.reg, id, "getTask", { task_id: params.task_id })) as Record<string, unknown>;
			const swimlaneId = params.swimlane_id ?? Number(task.swimlane_id);
			// Kanboard rejects position < 1 (returns false). Treat 0/omitted as "append to the end".
			let position = params.position;
			if (position === undefined || position < 1) {
				const all = (await rpc(bc.reg, id, "getAllTasks", { project_id: bc.projectId, status_id: 1 })) as Array<Record<string, unknown>>;
				const maxPos = all
					.filter((t) => Number(t.column_id) === Number(params.column_id) && Number(t.swimlane_id) === swimlaneId)
					.reduce((m, t) => Math.max(m, Number(t.position)), 0);
				position = maxPos + 1;
			}
			return toolResult(
				await rpc(bc.reg, id, "moveTaskPosition", {
					project_id: bc.projectId,
					task_id: params.task_id,
					column_id: params.column_id,
					position,
					swimlane_id: swimlaneId,
				}),
			);
		},
		...renderersFor("kanban_move_task"),
	});

	// 8. kanban_close_task
	pi.registerTool({
		name: "kanban_close_task",
		label: "Kanban Close Task",
		description: `Close (complete) a task on the active board. ${boardNote}`,
		promptSnippet: "Close a Kanboard task",
		parameters: Type.Object({ task_id: Type.Number() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			return toolResult(await rpc(bc.reg, id, "closeTask", { task_id: params.task_id }));
		},
		...renderersFor("kanban_close_task"),
	});

	// 9. kanban_reopen_task
	pi.registerTool({
		name: "kanban_reopen_task",
		label: "Kanban Reopen Task",
		description: `Reopen a closed task on the active board. ${boardNote}`,
		promptSnippet: "Reopen a closed Kanboard task",
		parameters: Type.Object({ task_id: Type.Number() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			return toolResult(await rpc(bc.reg, id, "openTask", { task_id: params.task_id }));
		},
		...renderersFor("kanban_reopen_task"),
	});

	// 10. kanban_add_comment
	pi.registerTool({
		name: "kanban_add_comment",
		label: "Kanban Add Comment",
		description: `Add a comment to a task on the active board, posted by the resolved Kanboard user of the current session/agent (see "as" in kanban_board; default is the registry user). Returns the comment_id. ${boardNote}`,
		promptSnippet: "Add a comment to a Kanboard task",
		parameters: Type.Object({ task_id: Type.Number(), content: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const commentId = await rpc(bc.reg, id, "createComment", {
				task_id: params.task_id,
				user_id: id.user_id,
				content: params.content,
			});
			return toolResult({ comment_id: commentId });
		},
		...renderersFor("kanban_add_comment"),
	});

	// 11. kanban_list_comments
	pi.registerTool({
		name: "kanban_list_comments",
		label: "Kanban List Comments",
		description: `List all comments of a task on the active board. ${boardNote}`,
		promptSnippet: "List comments on a Kanboard task",
		parameters: Type.Object({ task_id: Type.Number() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			return toolResult(await rpc(bc.reg, id, "getAllComments", { task_id: params.task_id }));
		},
		...renderersFor("kanban_list_comments"),
	});

	// 12. kanban_add_subtask
	pi.registerTool({
		name: "kanban_add_subtask",
		label: "Kanban Add Subtask",
		description: `Add a subtask to a task on the active board. time_estimate is in seconds. Returns the subtask_id. ${boardNote}`,
		promptSnippet: "Add a subtask to a Kanboard task",
		parameters: Type.Object({
			task_id: Type.Number(),
			title: Type.String(),
			time_estimate: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const subtaskId = await rpc(bc.reg, id, "createSubtask", {
				task_id: params.task_id,
				title: params.title,
				user_id: 0,
				time_estimated: params.time_estimate ?? 0,
				time_spent: 0,
				status: 0,
			});
			return toolResult({ subtask_id: subtaskId });
		},
		...renderersFor("kanban_add_subtask"),
	});

	// 13. kanban_list_subtasks
	pi.registerTool({
		name: "kanban_list_subtasks",
		label: "Kanban List Subtasks",
		description: `List all subtasks of a task on the active board. ${boardNote}`,
		promptSnippet: "List subtasks of a Kanboard task",
		parameters: Type.Object({ task_id: Type.Number() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			return toolResult(await rpc(bc.reg, id, "getAllSubtasks", { task_id: params.task_id }));
		},
		...renderersFor("kanban_list_subtasks"),
	});

	// 14. kanban_update_subtask
	pi.registerTool({
		name: "kanban_update_subtask",
		label: "Kanban Update Subtask",
		description: `Update a subtask on the active board. status: "todo" | "started" | "done". time_estimate is in seconds. ${boardNote}`,
		promptSnippet: "Update a Kanboard subtask",
		parameters: Type.Object({
			subtask_id: Type.Number(),
			title: Type.Optional(Type.String()),
			time_estimate: Type.Optional(Type.Number()),
			status: Type.Optional(StringEnum(["todo", "started", "done"] as const)),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const sub = (await rpc(bc.reg, id, "getSubtask", { subtask_id: params.subtask_id })) as Record<string, unknown>;
			const p: Record<string, unknown> = { id: params.subtask_id, task_id: Number(sub.task_id) };
			if (params.title !== undefined) p.title = params.title;
			if (params.time_estimate !== undefined) p.time_estimated = params.time_estimate;
			if (params.status !== undefined) {
				const statusMap = { todo: 0, started: 1, done: 2 } as const;
				p.status = statusMap[params.status];
			}
			return toolResult(await rpc(bc.reg, id, "updateSubtask", p));
		},
		...renderersFor("kanban_update_subtask"),
	});

	// 15. kanban_list_columns
	pi.registerTool({
		name: "kanban_list_columns",
		label: "Kanban List Columns",
		description: `List the columns of the active board. ${boardNote}`,
		promptSnippet: "List columns of the active Kanboard board",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			return toolResult(await rpc(bc.reg, id, "getColumns", { project_id: bc.projectId }));
		},
		...renderersFor("kanban_list_columns"),
	});

	// 16. kanban_list_swimlanes
	pi.registerTool({
		name: "kanban_list_swimlanes",
		label: "Kanban List Swimlanes",
		description: `List the active swimlanes of the active board. ${boardNote}`,
		promptSnippet: "List swimlanes of the active Kanboard board",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			return toolResult(await rpc(bc.reg, id, "getActiveSwimlanes", { project_id: bc.projectId }));
		},
		...renderersFor("kanban_list_swimlanes"),
	});

	// /board command
	pi.registerCommand("board", {
		description: "Show the active Kanboard board, or switch boards: /board <name>",
		getArgumentCompletions: (prefix: string) => {
			try {
				const reg = loadRegistry();
				const items = Object.keys(reg.boards).map((name) => ({ value: name, label: name }));
				const filtered = items.filter((i) => i.value.startsWith(prefix));
				return filtered.length > 0 ? filtered : null;
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			const show = (msg: string, kind: "info" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, kind);
				else console.log(msg);
			};
			try {
				const reg = loadRegistry();
				const arg = args.trim();

				if (arg.length === 0) {
					const bc = resolveBoard(ctx.cwd);
					const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
					const [columns, swimlanes] = await Promise.all([
						rpc(bc.reg, id, "getColumns", { project_id: bc.projectId }),
						rpc(bc.reg, id, "getActiveSwimlanes", { project_id: bc.projectId }),
					]);
					const cols = (columns as Array<Record<string, unknown>>).map((c) => `${c.id}:${c.title}`).join(", ");
					const lanes = (swimlanes as Array<Record<string, unknown>>).map((s) => `${s.id}:${s.name}`).join(", ");
					show(
						[
							`Board: ${bc.name} (project_id=${bc.projectId}, ${bc.reg.url})`,
							`Resolved from: ${bc.source}`,
							`Columns: ${cols || "(none)"}`,
							`Swimlanes: ${lanes || "(none)"}`,
						].join("\n"),
					);
					return;
				}

				if (!reg.boards[arg]) {
					show(`Board "${arg}" not found in registry. Available boards: ${boardNames(reg)}`, "error");
					return;
				}

				const root = findProjectRoot(ctx.cwd);
				const piDir = join(root, ".pi");
				mkdirSync(piDir, { recursive: true });
				const file = join(piDir, "kanboard.json");
				writeFileSync(file, JSON.stringify({ board: arg }, null, 2) + "\n");
				show(`Active board set to "${arg}" (written to ${file})`);
			} catch (e) {
				show((e as Error).message, "error");
			}
		},
	});
}
