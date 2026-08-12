import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIdeContext, stateFilePath } from "../omp-extension/src/reader.ts";
import { DEFAULT_CONFIG, MAX_CONTEXT_FILE_BYTES, SCHEMA_VERSION } from "../omp-extension/src/schema.ts";

let root: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-ctx-read-"));
	await mkdir(join(root, ".omp"), { recursive: true });
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), "x");
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

const now = 1_700_000_000_000;

const validJson = (overrides: Record<string, unknown> = {}) => ({
	version: SCHEMA_VERSION,
	updatedAt: now,
	workspace: root,
	file: "src/a.ts",
	language: "typescript",
	cursor: { line: 1, column: 1 },
	selection: null,
	blocked: false,
	truncated: false,
	...overrides,
});

const blockedJson = (reason: string, overrides: Record<string, unknown> = {}) => ({
	version: SCHEMA_VERSION,
	updatedAt: now,
	workspace: root,
	blocked: true,
	reason,
	truncated: false,
	...overrides,
});

describe("readIdeContext", () => {
	it("returns a benign failure when no file is present", async () => {
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toMatch(/no IDE context|path does not exist/);
	});

	it("returns a benign failure when disabled in config", async () => {
		await writeFile(stateFilePath(root), JSON.stringify(validJson()), "utf8");
		const out = await readIdeContext(root, { ...DEFAULT_CONFIG, enabled: false }, now);
		expect(out.ok).toBe(false);
	});

	it("accepts a fresh valid context", async () => {
		await writeFile(stateFilePath(root), JSON.stringify(validJson()), "utf8");
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.context.file).toBe("src/a.ts");
			expect(out.context.stale).toBe(false);
			expect(out.context.blocked).toBe(false);
		}
	});

	it("rejects malformed JSON", async () => {
		await writeFile(stateFilePath(root), "{ this is not json", "utf8");
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toMatch(/parse failed/);
	});

	it("rejects JSON that does not match the schema", async () => {
		await writeFile(stateFilePath(root), JSON.stringify({ ...validJson(), version: 2 }), "utf8");
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toMatch(/schema rejected/);
	});

	it("rejects when the writer's workspace differs from the current one", async () => {
		await writeFile(stateFilePath(root), JSON.stringify(validJson({ workspace: "/somewhere/else" })), "utf8");
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toMatch(/does not match/);
	});

	it("accepts a Windows workspace path whose drive letter differs only by case", async () => {
		if (process.platform !== "win32") return;
		const writerWorkspace = root.replace(/^([a-z]):/i, (drive) =>
			drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase(),
		);
		expect(writerWorkspace).not.toBe(root);
		await writeFile(stateFilePath(root), JSON.stringify(validJson({ workspace: writerWorkspace })), "utf8");
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(true);
	});

	// mục 30 — OOW is a soft block, not a hard rejection.
	it("soft-blocks an active file path that escapes the workspace", async () => {
		await writeFile(stateFilePath(root), JSON.stringify(validJson({ file: "../escape.ts" })), "utf8");
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.context.blocked).toBe(true);
			expect(out.context.reason).toBe("outside-workspace");
			expect(out.context.selection).toBeNull();
		}
	});

	// mục 30 — blocked shapes pass through with reason preserved.
	it("passes through a blocked context with reason=untitled", async () => {
		await writeFile(stateFilePath(root), JSON.stringify(blockedJson("untitled")), "utf8");
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.context.blocked).toBe(true);
			expect(out.context.reason).toBe("untitled");
			expect(out.context.selection).toBeNull();
		}
	});

	it("passes through a blocked context with reason=untrusted-workspace", async () => {
		await writeFile(stateFilePath(root), JSON.stringify(blockedJson("untrusted-workspace")), "utf8");
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.context.blocked).toBe(true);
			expect(out.context.reason).toBe("untrusted-workspace");
		}
	});

	it("marks the context stale and drops selection when updatedAt is older than staleAfterMs", async () => {
		const staleAt = now - 60_000;
		await writeFile(
			stateFilePath(root),
			JSON.stringify(validJson({
				updatedAt: staleAt,
				selection: { startLine: 1, endLine: 1, text: "abc" },
			})),
			"utf8",
		);
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.context.stale).toBe(true);
			expect(out.context.selection).toBeNull();
		}
	});

	// mục 31 — bound on the raw state-file size.
	it("rejects a state file larger than MAX_CONTEXT_FILE_BYTES", async () => {
		const huge = "x".repeat(MAX_CONTEXT_FILE_BYTES + 1);
		await writeFile(stateFilePath(root), huge, "utf8");
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toMatch(/exceeds/);
	});

	// mục 28 — canonical-path check defends against /project vs /project-other.
	it("rejects a workspace field that is a string-prefix sibling of the real workspace", async () => {
		const sibling = `${root}-other`;
		await writeFile(stateFilePath(root), JSON.stringify(validJson({ workspace: sibling })), "utf8");
		const out = await readIdeContext(root, DEFAULT_CONFIG, now);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toMatch(/does not match/);
	});
});
