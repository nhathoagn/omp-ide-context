import { describe, expect, it } from "bun:test";
import { parseContextFile } from "../omp-extension/src/validator.ts";
import {
	MAX_CONTEXT_FILE_BYTES,
	MAX_CURSOR_COLUMN,
	MAX_CURSOR_LINE,
	MAX_LANGUAGE_ID_CHARS,
	MAX_PATH_CHARS,
	SCHEMA_VERSION,
	VALID_BLOCK_REASONS,
} from "../omp-extension/src/schema.ts";

const baseContext = {
	version: SCHEMA_VERSION,
	updatedAt: 1_700_000_000_000,
	workspace: "/tmp/work",
	file: "src/index.ts",
	language: "typescript",
	cursor: { line: 1, column: 1 },
	selection: null,
	blocked: false,
	truncated: false,
};

describe("parseContextFile", () => {
	it("accepts a minimal valid context", () => {
		const result = parseContextFile(baseContext);
		expect(result.ok).toBe(true);
	});

	it("rejects a non-object root", () => {
		expect(parseContextFile(null).ok).toBe(false);
		expect(parseContextFile("string").ok).toBe(false);
		expect(parseContextFile(42).ok).toBe(false);
		expect(parseContextFile([1, 2, 3]).ok).toBe(false);
	});

	it("rejects the wrong version", () => {
		expect(parseContextFile({ ...baseContext, version: 2 }).ok).toBe(false);
		expect(parseContextFile({ ...baseContext, version: "1" }).ok).toBe(false);
	});

	it("rejects non-positive updatedAt", () => {
		expect(parseContextFile({ ...baseContext, updatedAt: 0 }).ok).toBe(false);
		expect(parseContextFile({ ...baseContext, updatedAt: -1 }).ok).toBe(false);
		expect(parseContextFile({ ...baseContext, updatedAt: "now" }).ok).toBe(false);
	});

	it("rejects missing or empty workspace/file", () => {
		expect(parseContextFile({ ...baseContext, workspace: "" }).ok).toBe(false);
		expect(parseContextFile({ ...baseContext, file: "" }).ok).toBe(false);
	});

	it("rejects workspace and file paths over MAX_PATH_CHARS", () => {
		const long = "a".repeat(MAX_PATH_CHARS + 1);
		expect(parseContextFile({ ...baseContext, workspace: long }).ok).toBe(false);
		expect(parseContextFile({ ...baseContext, file: long }).ok).toBe(false);
	});

	it("rejects language ids over MAX_LANGUAGE_ID_CHARS", () => {
		const long = "x".repeat(MAX_LANGUAGE_ID_CHARS + 1);
		expect(parseContextFile({ ...baseContext, language: long }).ok).toBe(false);
	});

	it("accepts cursor and selection when well-formed", () => {
		const result = parseContextFile({
			...baseContext,
			cursor: { line: 5, column: 3 },
			selection: { startLine: 1, endLine: 3, text: "abc" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.cursor).toEqual({ line: 5, column: 3 });
			expect(result.value.selection?.text).toBe("abc");
		}
	});

	it("rejects cursor.line and cursor.column above the upper bounds", () => {
		expect(parseContextFile({ ...baseContext, cursor: { line: MAX_CURSOR_LINE + 1, column: 1 } }).ok).toBe(false);
		expect(parseContextFile({ ...baseContext, cursor: { line: 1, column: MAX_CURSOR_COLUMN + 1 } }).ok).toBe(false);
	});

	it("rejects selection with endLine < startLine", () => {
		const bad = { ...baseContext, selection: { startLine: 10, endLine: 5, text: "x" } };
		expect(parseContextFile(bad).ok).toBe(false);
	});

	it("rejects selection with non-string text", () => {
		const bad = { ...baseContext, selection: { startLine: 1, endLine: 1, text: 42 } };
		expect(parseContextFile(bad).ok).toBe(false);
	});

	it("rejects selection.text that exceeds the trust-boundary cap", () => {
		const huge = "x".repeat(MAX_CONTEXT_FILE_BYTES + 1);
		const bad = { ...baseContext, selection: { startLine: 1, endLine: 1, text: huge } };
		expect(parseContextFile(bad).ok).toBe(false);
	});

	it("rejects cursor with non-positive line", () => {
		expect(parseContextFile({ ...baseContext, cursor: { line: 0, column: 1 } }).ok).toBe(false);
		expect(parseContextFile({ ...baseContext, cursor: { line: -1, column: 1 } }).ok).toBe(false);
	});

	it("rejects cursor with negative column", () => {
		expect(parseContextFile({ ...baseContext, cursor: { line: 1, column: -1 } }).ok).toBe(false);
	});

	// ── Blocked context shape (mục 30) ──────────────────────────────────
	for (const reason of VALID_BLOCK_REASONS) {
		it(`accepts blocked=true with reason=${reason}`, () => {
			const result = parseContextFile({ ...baseContext, blocked: true, reason });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.blocked).toBe(true);
				expect(result.value.reason).toBe(reason);
				expect(result.value.selection).toBeNull();
			}
		});
	}

	it("rejects blocked=true without a valid reason", () => {
		expect(parseContextFile({ ...baseContext, blocked: true, reason: "made-up" }).ok).toBe(false);
		expect(parseContextFile({ ...baseContext, blocked: true }).ok).toBe(false);
	});

	it("rejects blocked=true when required metadata is missing", () => {
		// blocked shapes still need version, updatedAt, workspace.
		const noWorkspace = parseContextFile({ version: SCHEMA_VERSION, updatedAt: 1, blocked: true, reason: "untitled" });
		expect(noWorkspace.ok).toBe(false);
	});

	it("rejects extra unknown fields? No — extra fields are silently ignored to be lenient on upgrades", () => {
		const result = parseContextFile({ ...baseContext, extra: "ignored" });
		expect(result.ok).toBe(true);
	});

	it("handles missing selection/blocked/truncated gracefully", () => {
		const minimal = {
			version: SCHEMA_VERSION,
			updatedAt: 1_700_000_000_000,
			workspace: "/tmp/work",
			file: "src/index.ts",
			language: "typescript",
			cursor: { line: 1, column: 1 },
		};
		const result = parseContextFile(minimal);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.selection).toBeNull();
			expect(result.value.blocked).toBe(false);
			expect(result.value.reason).toBeNull();
			expect(result.value.truncated).toBe(false);
		}
	});
});
