/**
 * Hand-rolled validator for the IDE context JSON file.
 *
 * No `eval`, no `new Function`, no third-party JSON Schema. Every type
 * is checked at runtime; on the first violation the function returns
 * `{ ok: false, reason: "..." }` and the caller must drop the file.
 *
 * This module is the trust boundary for attacker-controlled input
 * (spec mục 29). All size caps and string-length checks happen here
 * BEFORE the parsed object is exposed to the rest of the system.
 */

import {
	MAX_CONTEXT_FILE_BYTES,
	MAX_CURSOR_COLUMN,
	MAX_CURSOR_LINE,
	MAX_GENERIC_STRING_CHARS,
	MAX_LANGUAGE_ID_CHARS,
	MAX_PATH_CHARS,
	SCHEMA_VERSION,
	VALID_BLOCK_REASONS,
	type BlockReason,
	type ParseResult,
	type RawContextFile,
	type ValidatedContext,
} from "./schema.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && Number.isFinite(v);
}

function isNonNegativeInt(v: unknown): v is number {
	return isInt(v) && v >= 0;
}

function isPositiveInt(v: unknown): v is number {
	return isInt(v) && v > 0;
}

function isBool(v: unknown): v is boolean {
	return typeof v === "boolean";
}

function isString(v: unknown): v is string {
	return typeof v === "string";
}

/**
 * Bounded string check. Returns `true` when the value is a string at
 * or under the cap, `false` otherwise. Strings over the cap are
 * rejected outright (mục 31).
 */
function isBoundedString(v: unknown, maxChars: number): v is string {
	return isString(v) && v.length > 0 && v.length <= maxChars;
}

/**
 * Narrow an unknown value to a valid BlockReason. Returns `null` when
 * the value is not in the closed set. The closed-set check is the
 * "Unknown/invalid type rejection" required by mục 29.
 */
function asBlockReason(v: unknown): BlockReason | null {
	if (typeof v !== "string") return null;
	return VALID_BLOCK_REASONS.has(v as BlockReason) ? (v as BlockReason) : null;
}

/**
 * Validate and normalize a parsed JSON value as a `ValidatedContext`.
 *
 * The function is defensive: every nested field is checked. If anything
 * is missing or has the wrong type, the result is a rejection with a
 * specific reason. The caller is expected to log the reason and skip
 * injection for that turn.
 *
 * Two top-level shapes are accepted:
 *   - A "full" context: version, updatedAt, workspace, file, language,
 *     cursor, optional selection, optional blocked flag.
 *   - A "blocked" context: version, updatedAt, workspace, blocked=true,
 *     reason=one-of-BlockReason. File path and language are NOT
 *     required for blocked contexts; we still require `workspace` for
 *     the boundary check downstream.
 */
export function parseContextFile(raw: unknown): ParseResult {
	if (!isPlainObject(raw)) {
		return { ok: false, reason: "root is not an object" };
	}
	const obj = raw as RawContextFile;

	if (obj.version !== SCHEMA_VERSION) {
		return { ok: false, reason: `unsupported version ${String(obj.version)}` };
	}
	if (!isPositiveInt(obj.updatedAt) || obj.updatedAt > Number.MAX_SAFE_INTEGER) {
		return { ok: false, reason: "updatedAt must be a positive integer" };
	}
	if (!isBoundedString(obj.workspace, MAX_PATH_CHARS)) {
		return { ok: false, reason: `workspace must be a non-empty string up to ${MAX_PATH_CHARS} chars` };
	}

	const blocked = obj.blocked == null ? false : isBool(obj.blocked) ? obj.blocked : false;

	// ── Blocked context: minimal shape, no file/cursor required ────────
	if (blocked) {
		const reason = asBlockReason(obj.reason);
		if (reason === null) {
			return { ok: false, reason: "blocked context must have a valid reason" };
		}
		const value: ValidatedContext = {
			version: SCHEMA_VERSION,
			updatedAt: obj.updatedAt,
			workspace: obj.workspace,
			file: "",
			language: "",
			cursor: { line: 1, column: 0 },
			selection: null,
			blocked: true,
			reason,
			truncated: false,
			stale: false,
		};
		return { ok: true, value };
	}

	// ── Full context ────────────────────────────────────────────────────
	if (!isBoundedString(obj.file, MAX_PATH_CHARS)) {
		return { ok: false, reason: `file must be a non-empty string up to ${MAX_PATH_CHARS} chars` };
	}
	if (!isBoundedString(obj.language, MAX_LANGUAGE_ID_CHARS)) {
		return { ok: false, reason: `language must be a non-empty string up to ${MAX_LANGUAGE_ID_CHARS} chars` };
	}

	let cursor = { line: 1, column: 0 };
	if (obj.cursor != null) {
		if (!isPlainObject(obj.cursor)) {
			return { ok: false, reason: "cursor must be an object" };
		}
		const c = obj.cursor as { line?: unknown; column?: unknown };
		if (!isPositiveInt(c.line) || c.line > MAX_CURSOR_LINE) {
			return { ok: false, reason: `cursor.line must be 1..${MAX_CURSOR_LINE}` };
		}
		if (!isNonNegativeInt(c.column) || c.column > MAX_CURSOR_COLUMN) {
			return { ok: false, reason: `cursor.column must be 0..${MAX_CURSOR_COLUMN}` };
		}
		cursor = { line: c.line, column: c.column };
	}

	let selection: ValidatedContext["selection"] = null;
	if (obj.selection != null) {
		if (!isPlainObject(obj.selection)) {
			return { ok: false, reason: "selection must be an object" };
		}
		const s = obj.selection as { startLine?: unknown; endLine?: unknown; text?: unknown; truncated?: unknown };
		if (!isPositiveInt(s.startLine) || s.startLine > MAX_CURSOR_LINE) {
			return { ok: false, reason: `selection.startLine must be 1..${MAX_CURSOR_LINE}` };
		}
		if (!isPositiveInt(s.endLine) || s.endLine > MAX_CURSOR_LINE) {
			return { ok: false, reason: `selection.endLine must be 1..${MAX_CURSOR_LINE}` };
		}
		if (s.endLine < s.startLine) {
			return { ok: false, reason: "selection.endLine < selection.startLine" };
		}
		if (!isString(s.text)) {
			return { ok: false, reason: "selection.text must be a string" };
		}
		// Selection text has its own hard cap; the trust boundary must
		// never accept unbounded input from an attacker even when the
		// reader config asks for more.
		if (s.text.length > MAX_CONTEXT_FILE_BYTES) {
			return { ok: false, reason: `selection.text exceeds ${MAX_CONTEXT_FILE_BYTES} chars` };
		}
		const truncated = s.truncated == null ? false : isBool(s.truncated) ? s.truncated : false;
		selection = { startLine: s.startLine, endLine: s.endLine, text: s.text, truncated };
	}

	const truncated = obj.truncated == null ? false : isBool(obj.truncated) ? obj.truncated : false;

	// Generic string length check for fields we have not bounded above.
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value !== "string") continue;
		// Allow `selection.text` to exceed the generic cap; selection
		// has its own cap above.
		if (key === "text" && obj.selection && isPlainObject(obj.selection) && "text" in obj.selection && obj.selection.text === value) {
			continue;
		}
		if (value.length > MAX_GENERIC_STRING_CHARS) {
			return { ok: false, reason: `field "${key}" exceeds ${MAX_GENERIC_STRING_CHARS} chars` };
		}
	}

	return {
		ok: true,
		value: {
			version: SCHEMA_VERSION,
			updatedAt: obj.updatedAt,
			workspace: obj.workspace,
			file: obj.file,
			language: obj.language,
			cursor,
			selection,
			blocked: false,
			reason: null,
			truncated,
			stale: false, // computed by the reader, not from the file
		},
	};
}
