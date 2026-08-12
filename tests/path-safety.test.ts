import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInsideWorkspace } from "../omp-extension/src/path-safety.ts";

let root: string;
let outsideRoot: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-ctx-"));
	outsideRoot = await mkdtemp(join(tmpdir(), "omp-ctx-outside-"));
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), "x");
	await writeFile(join(root, "src", "b.ts"), "y");
	await writeFile(join(outsideRoot, "outside.txt"), "z");
});

afterAll(async () => {
	await Promise.all([
		rm(root, { recursive: true, force: true }),
		rm(outsideRoot, { recursive: true, force: true }),
	]);
});

describe("assertInsideWorkspace", () => {
	it("accepts a workspace-relative path", () => {
		const r = assertInsideWorkspace("src/a.ts", root);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.relative).toBe("src/a.ts");
	});

	it("accepts an absolute path inside the workspace", () => {
		const r = assertInsideWorkspace(join(root, "src/b.ts"), root);
		expect(r.ok).toBe(true);
	});

	it("rejects a `..` traversal", () => {
		const r = assertInsideWorkspace("../outside.txt", root);
		expect(r.ok).toBe(false);
	});

	it("rejects an absolute path outside the workspace", () => {
		const r = assertInsideWorkspace("/etc/passwd", root);
		expect(r.ok).toBe(false);
	});

	it("rejects an empty or non-string path", () => {
		expect(assertInsideWorkspace("", root).ok).toBe(false);
	});

	it("rejects a path that contains a NUL byte", () => {
		expect(assertInsideWorkspace("src/a.ts\0evil", root).ok).toBe(false);
	});

	it("rejects a symlink that escapes the workspace", async () => {
		const escape = join(root, "src", "escape-link");
		try {
			await symlink(join(outsideRoot, "outside.txt"), escape);
		} catch {
			return; // Skip on platforms that disallow symlink creation.
		}

		const result = assertInsideWorkspace("src/escape-link", root);
		expect(result.ok).toBe(false);
	});

	it("rejects a path that exceeds the length cap", () => {
		const tooLong = "a".repeat(5000);
		const r = assertInsideWorkspace(tooLong, root);
		expect(r.ok).toBe(false);
	});
});
