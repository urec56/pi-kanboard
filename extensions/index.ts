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
import { keyHint } from "@earendil-works/pi-coding-agent";
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

/** Extract the active-agent name from a system prompt carrying the <active_agent> tag. */
function agentNameFromPrompt(sp: unknown): string | null {
	const m = ACTIVE_AGENT_TAG.exec(typeof sp === "string" ? sp : "");
	return m && m[1] ? m[1].trim() : null;
}

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
	// Live system prompt (final, after all before_agent_start mutations) —
	// independent of extension load order and mid-session agent switches.
	if (!name) {
		try {
			name = agentNameFromPrompt((ctx as { getSystemPrompt?: () => unknown }).getSystemPrompt?.());
		} catch {
			/* ctx without getSystemPrompt (older pi versions) */
		}
	}
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

async function rpcCall(reg: Registry, id: Identity, method: string, params: Record<string, unknown>): Promise<unknown> {
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
		const extra = err.data !== undefined ? ` (${typeof err.data === "string" ? err.data : dumpText(err.data)})` : "";
		throw new Error(`Kanboard error: ${err.message ?? "unknown error"}${extra}`);
	}
	return data.result;
}

// ---------------------------------------------------------------------------
// Retry wrapper
//
// Kanboard on SQLite fails concurrent writes with "database is locked"
// (SQLITE_BUSY) — e.g. when several kanban_move_task calls run in parallel.
// The failed write is rolled back server-side (nothing was applied), so
// retrying is safe. A few attempts with backoff absorb the contention.
// ---------------------------------------------------------------------------

const SQLITE_BUSY_RE = /database is locked|SQLITE_BUSY|General error: 5/i;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(
	reg: Registry,
	id: Identity,
	method: string,
	params: Record<string, unknown>,
	attempts = 5,
): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await rpcCall(reg, id, method, params);
		} catch (e) {
			if (!SQLITE_BUSY_RE.test((e as Error).message ?? "") || attempt >= attempts) throw e;
			await sleep(Math.min(200 * 2 ** (attempt - 1), 2000) + Math.floor(Math.random() * 100));
		}
	}
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/**
 * Build a tool result: `text` is what the model receives (compact plain text,
 * not raw JSON); `raw` is the underlying payload kept in `details` for the TUI
 * renderers (collapsed summary / expanded view).
 */
function toolResult(text: string, raw?: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details: { result: raw },
	};
}

function renderersFor(name: string) {
	return {
		renderCall(args: object, theme: Theme) {
			const parts = Object.entries(args)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => `${k}=${v}`);
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
// Rendering: a collapsed row shows a compact summary; expanded (ctrl+o) shows
// the full text — same pattern as built-in read/write tools. The model always
// receives the full content; this only affects what the user sees in the TUI.
// ---------------------------------------------------------------------------

function formatCommentLine(c: Record<string, unknown>): string {
	const id = c.id !== undefined ? String(c.id) : "?";
	const author = typeof c.username === "string" && c.username ? c.username : `user ${c.user_id ?? "?"}`;
	let date = "";
	if (typeof c.date_creation === "number") {
		const d = new Date(c.date_creation * 1000);
		const p = (n: number) => String(n).padStart(2, "0");
		date = ` ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
	}
	const raw = typeof c.comment === "string" ? c.comment.replace(/\s+/g, " ").trim() : "";
	const text = raw.length > 60 ? `${raw.slice(0, 60).trimEnd()}…` : raw || "(empty)";
	return `#${id} ${author}${date}: ${text}`;
}

type RenderResult = { content?: Array<{ type: string; text?: string }>; details?: { result?: unknown } };

type Summarizer = (raw: unknown) => string[] | null;

function resultText(result: RenderResult): string {
	return (result.content ?? [])
		.map((c) => (c.type === "text" ? c.text ?? "" : ""))
		.join("");
}

/** Flatten to a single line and truncate with an ellipsis. */
function oneLine(v: unknown, limit: number): string | null {
	if (typeof v !== "string") return null;
	const s = v.replace(/\s+/g, " ").trim();
	return s.length > limit ? `${s.slice(0, limit).trimEnd()}…` : s || null;
}

function taskLine(t: Record<string, unknown>): string {
	const col = t.column_id != null && Number(t.column_id) > 0 ? ` [col ${t.column_id}]` : "";
	return `#${t.id ?? "?"}${col} ${oneLine(t.title ?? "", 50) ?? "(untitled)"}`;
}

function summarizeTaskList(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return ["(no tasks)"];
	return [`${raw.length} task${raw.length === 1 ? "" : "s"}`, ...(raw as Array<Record<string, unknown>>).map(taskLine)];
}

function summarizeTask(raw: unknown): string[] | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const t = raw as Record<string, unknown>;
	if (t.id === undefined) return null; // not a task object — show full text instead
	const lines = [taskLine(t)];
	const desc = oneLine(String(t.description ?? ""), 80);
	if (desc) lines.push(`desc: ${desc}`);
	return lines;
}

function subtaskLine(s: Record<string, unknown>): string {
	const status = typeof s.status_name === "string" && s.status_name ? s.status_name : ["todo", "started", "done"][Number(s.status)] ?? "?";
	return `#${s.id ?? "?"} ${status}: ${oneLine(s.title ?? "", 50) ?? "(untitled)"}`;
}

function summarizeSubtaskList(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return ["(no subtasks)"];
	return [`${raw.length} subtask${raw.length === 1 ? "" : "s"}`, ...(raw as Array<Record<string, unknown>>).map(subtaskLine)];
}

function summarizeSubtask(raw: unknown): string[] | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const s = raw as Record<string, unknown>;
	if (s.id === undefined) return null;
	return [subtaskLine(s)];
}

function summarizeColumns(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return ["(no columns)"];
	return (raw as Array<Record<string, unknown>>).map((c) => `#${c.id ?? "?"} ${oneLine(c.title ?? c.name ?? "", 40) ?? ""}`.trim());
}

function summarizeSwimlanes(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return ["(no swimlanes)"];
	return (raw as Array<Record<string, unknown>>).map((s) => `#${s.id ?? "?"} ${oneLine(s.name ?? "", 40) ?? ""}`.trim());
}

function summarizeBoard(raw: unknown): string[] | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const b = raw as Record<string, unknown>;
	if (typeof b.board !== "string") return null; // not our board summary — show full text instead
	const fmt = (items: Array<Record<string, unknown>>, field: string) =>
		items.map((i) => `${i.id ?? "?"}:${oneLine(i[field] ?? "", 20) ?? "?"}`).join(", ");
	return [
		`${b.board} (project ${b.project_id}) via ${b.source}`,
		`as ${typeof b.as === "string" ? b.as : "?"}`,
		Array.isArray(b.columns) ? `columns: ${fmt(b.columns as Array<Record<string, unknown>>, "title")}` : "columns: ?",
		Array.isArray(b.swimlanes) ? `swimlanes: ${fmt(b.swimlanes as Array<Record<string, unknown>>, "name")}` : "swimlanes: ?",
	];
}

function summarizeMove(raw: unknown): string[] | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	if (o.task_id === undefined) return null; // unexpected shape — show full text instead
	return [`task #${o.task_id} → col ${o.column_id ?? "?"}${o.position != null ? ` pos ${o.position}` : ""}`];
}

function summarizeIdResult(key: string, verb: string): Summarizer {
	return (raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const o = raw as Record<string, unknown>;
		if (o[key] === undefined) return null;
		return [`${key.replace(/_id$/, "")} #${o[key]} ${verb}`];
	};
}

function summarizeComments(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return ["(no comments)"];
	return [`${raw.length} comment${raw.length === 1 ? "" : "s"}`, ...(raw as Array<Record<string, unknown>>).map(formatCommentLine)];
}

function summarizeComment(raw: unknown): string[] | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const c = raw as Record<string, unknown>;
	if (c.id === undefined) return null;
	return [formatCommentLine(c)];
}

// ---------------------------------------------------------------------------
// Model-facing formatters
//
// Tool results are returned to the model as compact plain text, not raw JSON:
// fewer tokens, easier to parse. The raw payload stays in `details` for the
// TUI renderers; unexpected shapes fall back to a plain-text dump.
// ---------------------------------------------------------------------------

/** Format a Kanboard timestamp (unix seconds) or date string for display. */
function fmtDate(v: unknown): string | null {
	if (typeof v === "number" && v > 0) {
		const d = new Date(v * 1000);
		const p = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
	}
	if (typeof v === "string" && v.trim()) return v.trim();
	return null;
}

function taskStatus(t: Record<string, unknown>): string {
	if (typeof t.status_name === "string" && t.status_name) return t.status_name;
	return Number(t.status_id) === 0 ? "closed" : "open";
}

/** One compact line per task: #id [col N] title (status, owner, prio, score, due). */
function taskLineFull(t: Record<string, unknown>): string {
	const col = t.column_id != null && Number(t.column_id) > 0 ? ` [col ${t.column_id}]` : "";
	const bits: string[] = [taskStatus(t)];
	if (t.owner_id) bits.push(`owner ${t.owner_id}`);
	if (t.priority) bits.push(`prio ${t.priority}`);
	if (t.score) bits.push(`score ${t.score}`);
	const due = fmtDate(t.date_due);
	if (due) bits.push(`due ${due}`);
	return `#${t.id ?? "?"}${col} ${oneLine(t.title ?? "", 60) ?? "(untitled)"} (${bits.join(", ")})`;
}

function formatTaskList(raw: unknown): string | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return "(no tasks)";
	const lines = (raw as Array<Record<string, unknown>>).map(taskLineFull);
	return `${raw.length} task${raw.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

/** Full single-task block: header, key fields, description. */
function formatTask(raw: unknown): string | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const t = raw as Record<string, unknown>;
	if (t.id === undefined) return null;
	const lines = [`#${t.id} ${oneLine(t.title ?? "", 80) ?? "(untitled)"}`, `status: ${taskStatus(t)}`];
	const add = (label: string, v: unknown) => {
		if (v !== undefined && v !== null && v !== "") lines.push(`${label}: ${v}`);
	};
	add("column", t.column_id);
	add("swimlane", t.swimlane_id);
	add("owner", t.owner_id);
	add("priority", t.priority);
	add("score", t.score);
	add("due", fmtDate(t.date_due));
	add("start", fmtDate(t.date_start));
	add("created", fmtDate(t.date_creation));
	add("last change", fmtDate(t.date_of_last_change));
	const labels = Array.isArray(t.labels)
		? (t.labels as Array<Record<string, unknown>>).map((l) => (typeof l.name === "string" ? l.name : "")).filter(Boolean)
		: [];
	if (labels.length > 0) lines.push(`labels: ${labels.join(", ")}`);
	const desc = typeof t.description === "string" ? t.description.trim() : "";
	if (desc) lines.push(`description:\n${desc}`);
	return lines.join("\n");
}

function formatColumns(raw: unknown): string | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return "(no columns)";
	const lines = (raw as Array<Record<string, unknown>>).map((c) => `#${c.id ?? "?"} ${oneLine(c.title ?? c.name ?? "", 60) ?? ""}`.trim());
	return `${raw.length} column${raw.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

function formatSwimlanes(raw: unknown): string | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return "(no swimlanes)";
	const lines = (raw as Array<Record<string, unknown>>).map((s) => `#${s.id ?? "?"} ${oneLine(s.name ?? "", 60) ?? ""}`.trim());
	return `${raw.length} swimlane${raw.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

/** One comment block: header line + full comment text (no truncation). */
function commentBlock(c: Record<string, unknown>): string {
	const id = c.id !== undefined ? String(c.id) : "?";
	const author = typeof c.username === "string" && c.username ? c.username : `user ${c.user_id ?? "?"}`;
	const date = fmtDate(c.date_creation);
	const text = typeof c.comment === "string" ? c.comment : "";
	return `#${id} ${author}${date ? ` ${date}` : ""}:\n${text || "(empty)"}`;
}

function formatComments(raw: unknown): string | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return "(no comments)";
	const blocks = (raw as Array<Record<string, unknown>>).map(commentBlock);
	return `${raw.length} comment${raw.length === 1 ? "" : "s"}:\n${blocks.join("\n")}`;
}

function formatComment(raw: unknown): string | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const c = raw as Record<string, unknown>;
	if (c.id === undefined) return null;
	return commentBlock(c);
}

function subtaskLineFull(s: Record<string, unknown>): string {
	const status = typeof s.status_name === "string" && s.status_name ? s.status_name : ["todo", "started", "done"][Number(s.status)] ?? "?";
	const bits: string[] = [];
	if (s.time_estimated) bits.push(`est ${s.time_estimated}s`);
	if (s.time_spent) bits.push(`spent ${s.time_spent}s`);
	const suffix = bits.length > 0 ? ` (${bits.join(", ")})` : "";
	return `#${s.id ?? "?"} ${status}: ${oneLine(s.title ?? "", 60) ?? "(untitled)"}${suffix}`;
}

function formatSubtaskList(raw: unknown): string | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return "(no subtasks)";
	const lines = (raw as Array<Record<string, unknown>>).map(subtaskLineFull);
	return `${raw.length} subtask${raw.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

function formatSubtask(raw: unknown): string | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const s = raw as Record<string, unknown>;
	if (s.id === undefined) return null;
	return subtaskLineFull(s);
}

interface BoardInfo {
	board: string;
	project_id: number;
	url: string;
	source: string;
	as: string;
	columns: Array<{ id: number; title: string }>;
	swimlanes: Array<{ id: number; name: string }>;
}

function formatBoard(b: BoardInfo): string {
	const cols = b.columns.map((c) => `#${c.id} ${c.title}`).join(", ");
	const lanes = b.swimlanes.map((s) => `#${s.id} ${s.name}`).join(", ");
	return [
		`Board: ${b.board} (project ${b.project_id}, ${b.url})`,
		`source: ${b.source}`,
		`as: ${b.as}`,
		`columns: ${cols || "(none)"}`,
		`swimlanes: ${lanes || "(none)"}`,
	].join("\n");
}

/**
 * Render an arbitrary value as compact plain text (never raw JSON). Fallback
 * for result shapes the dedicated formatters don't cover.
 */
function dumpText(v: unknown, depth = 0): string {
	const pad = "  ".repeat(depth);
	if (v === null) return "null";
	if (v === undefined) return "";
	if (Array.isArray(v)) {
		if (v.length === 0) return "(empty)";
		const childPad = "  ".repeat(depth + 1);
		return v
			.map((item) => {
				const s = dumpText(item, depth + 1);
				const lines = s.split("\n");
				const first = lines[0].startsWith(childPad) ? lines[0].slice(childPad.length) : lines[0];
				return lines.length > 1 ? `${pad}- ${first}\n${lines.slice(1).join("\n")}` : `${pad}- ${first}`;
			})
			.join("\n");
	}
	if (typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== undefined);
		if (entries.length === 0) return "(empty)";
		return entries
			.map(([k, val]) => {
				const s = dumpText(val, depth + 1);
				return s.includes("\n") ? `${pad}${k}:\n${s}` : `${pad}${k}: ${s}`;
			})
			.join("\n");
	}
	return String(v);
}

/** Format a raw payload for the model; plain-text dump as fallback for unexpected shapes. */
function formatResult(raw: unknown, format: (raw: unknown) => string | null): string {
	return format(raw) ?? dumpText(raw);
}

/** Collapsed: compact summary + expand hint; expanded (or unrecognized shape): full text. */
function smartRender(result: RenderResult, opts: { expanded?: boolean }, theme: Theme, summarize: Summarizer): Text {
	if (!opts?.expanded) {
		const lines = summarize(result.details?.result);
		if (lines !== null) {
			const noHint = lines.length === 1 && lines[0].startsWith("(no ");
			return new Text(`${theme.fg("muted", lines.join("\n"))}${noHint ? "" : `\n${keyHint("app.tools.expand", "to expand")}`}`, 0, 0);
		}
	}
	const full = resultText(result);
	return new Text(theme.fg("muted", full || "(no output)"), 0, 0);
}

function toolRenderers(name: string, summarize?: Summarizer) {
	const base = renderersFor(name);
	if (!summarize) return base;
	return { ...base, renderResult: (result: RenderResult, opts: { expanded?: boolean }, theme: Theme) => smartRender(result, opts, theme, summarize) };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Per-agent identity is resolved lazily at tool-execution time from the
	// live system prompt (ctx.getSystemPrompt()), so it does not depend on
	// extension load order or on caching during before_agent_start.

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
			const board: BoardInfo = {
				board: bc.name,
				project_id: bc.projectId,
				url: bc.reg.url,
				source: bc.source,
				as: `${id.username} (user_id=${id.user_id})`,
				columns: (columns as Array<Record<string, unknown>>).map((c) => ({ id: Number(c.id), title: String(c.title) })),
				swimlanes: (swimlanes as Array<Record<string, unknown>>).map((s) => ({ id: Number(s.id), name: String(s.name) })),
			};
			return toolResult(formatBoard(board), board);
		},
		...toolRenderers("kanban_board", summarizeBoard),
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
			return toolResult(formatResult(result, formatTaskList), result);
		},
		...toolRenderers("kanban_list_tasks", summarizeTaskList),
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
			const mine = all.filter((t) => Number(t.owner_id) === id.user_id);
			return toolResult(formatResult(mine, formatTaskList), mine);
		},
		...toolRenderers("kanban_my_tasks", summarizeTaskList),
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
			const task = await rpc(bc.reg, id, "getTask", { task_id: params.task_id });
			return toolResult(formatResult(task, formatTask), task);
		},
		...toolRenderers("kanban_get_task", summarizeTask),
	});

	// 5. kanban_create_task
	pi.registerTool({
		name: "kanban_create_task",
		label: "Kanban Create Task",
		description: `Create a task on the active board, optionally assigning an owner (owner_id). Returns the new task_id. ${boardNote}`,
		promptSnippet: "Create a Kanboard task on the active board",
		parameters: Type.Object({
			title: Type.String(),
			description: Type.Optional(Type.String()),
			column_id: Type.Optional(Type.Number()),
			swimlane_id: Type.Optional(Type.Number()),
			priority: Type.Optional(Type.Number()),
			date_due: Type.Optional(Type.String()),
			owner_id: Type.Optional(Type.Number()),
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
				owner_id: params.owner_id ?? 0,
				score: 0,
			});
			return toolResult(`task #${taskId} created`, { task_id: taskId });
		},
		...toolRenderers("kanban_create_task", summarizeIdResult("task_id", "created")),
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
			const task = await rpc(bc.reg, id, "updateTask", p);
			return toolResult(formatResult(task, formatTask), task);
		},
		...toolRenderers("kanban_update_task", summarizeTask),
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
			await rpc(bc.reg, id, "moveTaskPosition", {
				project_id: bc.projectId,
				task_id: params.task_id,
				column_id: params.column_id,
				position,
				swimlane_id: swimlaneId,
			});
			return toolResult(`task #${params.task_id} moved to col ${params.column_id} (position ${position}, swimlane ${swimlaneId})`, {
				task_id: params.task_id,
				column_id: params.column_id,
				position,
				swimlane_id: swimlaneId,
			});
		},
		...toolRenderers("kanban_move_task", summarizeMove),
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
			const task = await rpc(bc.reg, id, "closeTask", { task_id: params.task_id });
			return toolResult(`task #${params.task_id} closed`, task);
		},
		...toolRenderers("kanban_close_task", summarizeTask),
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
			const task = await rpc(bc.reg, id, "openTask", { task_id: params.task_id });
			return toolResult(`task #${params.task_id} reopened`, task);
		},
		...toolRenderers("kanban_reopen_task", summarizeTask),
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
			return toolResult(`comment #${commentId} added to task #${params.task_id}`, { comment_id: commentId });
		},
		...toolRenderers("kanban_add_comment", summarizeIdResult("comment_id", "added")),
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
			const comments = await rpc(bc.reg, id, "getAllComments", { task_id: params.task_id });
			return toolResult(formatResult(comments, formatComments), comments);
		},
		...toolRenderers("kanban_list_comments", summarizeComments),
	});

	// 12. kanban_get_comment
	pi.registerTool({
		name: "kanban_get_comment",
		label: "Kanban Get Comment",
		description: `Get one comment by id from a task on the active board. ${boardNote}`,
		promptSnippet: "Get a single Kanboard comment by id",
		parameters: Type.Object({ comment_id: Type.Number() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const comment = await rpc(bc.reg, id, "getComment", { comment_id: params.comment_id });
			return toolResult(formatResult(comment, formatComment), comment);
		},
		...toolRenderers("kanban_get_comment", summarizeComment),
	});

	// 13. kanban_add_subtask
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
			return toolResult(`subtask #${subtaskId} added to task #${params.task_id}`, { subtask_id: subtaskId });
		},
		...toolRenderers("kanban_add_subtask", summarizeIdResult("subtask_id", "added")),
	});

	// 14. kanban_list_subtasks
	pi.registerTool({
		name: "kanban_list_subtasks",
		label: "Kanban List Subtasks",
		description: `List all subtasks of a task on the active board. ${boardNote}`,
		promptSnippet: "List subtasks of a Kanboard task",
		parameters: Type.Object({ task_id: Type.Number() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const subs = await rpc(bc.reg, id, "getAllSubtasks", { task_id: params.task_id });
			return toolResult(formatResult(subs, formatSubtaskList), subs);
		},
		...toolRenderers("kanban_list_subtasks", summarizeSubtaskList),
	});

	// 15. kanban_update_subtask
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
			const cur = (await rpc(bc.reg, id, "getSubtask", { subtask_id: params.subtask_id })) as Record<string, unknown>;
			const p: Record<string, unknown> = { id: params.subtask_id, task_id: Number(cur.task_id) };
			if (params.title !== undefined) p.title = params.title;
			if (params.time_estimate !== undefined) p.time_estimated = params.time_estimate;
			if (params.status !== undefined) {
				const statusMap = { todo: 0, started: 1, done: 2 } as const;
				p.status = statusMap[params.status];
			}
			const updated = await rpc(bc.reg, id, "updateSubtask", p);
			return toolResult(formatResult(updated, formatSubtask), updated);
		},
		...toolRenderers("kanban_update_subtask", summarizeSubtask),
	});

	// 16. kanban_list_columns
	pi.registerTool({
		name: "kanban_list_columns",
		label: "Kanban List Columns",
		description: `List the columns of the active board. ${boardNote}`,
		promptSnippet: "List columns of the active Kanboard board",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const columns = await rpc(bc.reg, id, "getColumns", { project_id: bc.projectId });
			return toolResult(formatResult(columns, formatColumns), columns);
		},
		...toolRenderers("kanban_list_columns", summarizeColumns),
	});

	// 17. kanban_list_swimlanes
	pi.registerTool({
		name: "kanban_list_swimlanes",
		label: "Kanban List Swimlanes",
		description: `List the active swimlanes of the active board. ${boardNote}`,
		promptSnippet: "List swimlanes of the active Kanboard board",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const bc = resolveBoard(ctx.cwd);
			const id = resolveIdentity(bc.reg, ctx, ctx.cwd);
			const swimlanes = await rpc(bc.reg, id, "getActiveSwimlanes", { project_id: bc.projectId });
			return toolResult(formatResult(swimlanes, formatSwimlanes), swimlanes);
		},
		...toolRenderers("kanban_list_swimlanes", summarizeSwimlanes),
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

				// No git repo above cwd -> target the session's cwd itself so the
				// file stays next to where the session runs; findBoardFile() picks it up.
				const root = findProjectRoot(ctx.cwd);
				const target = existsSync(join(root, ".git")) ? root : resolve(ctx.cwd);
				const piDir = join(target, ".pi");
				let file: string;
				try {
					mkdirSync(piDir, { recursive: true });
					file = join(piDir, "kanboard.json");
					writeFileSync(file, JSON.stringify({ board: arg }, null, 2) + "\n");
				} catch (e) {
					show(`Cannot write ${join(target, ".pi", "kanboard.json")}: ${(e as Error).message}. Create the file manually or use KANBOARD_BOARD.`, "error");
					return;
				}
				show(`Active board set to "${arg}" (written to ${file})`);
			} catch (e) {
				show((e as Error).message, "error");
			}
		},
	});
}
