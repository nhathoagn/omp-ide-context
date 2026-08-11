import { describe, expect, it } from "bun:test";
import { contextFingerprint } from "../omp-extension/src/fingerprint.ts";
import type { ValidatedContext } from "../omp-extension/src/schema.ts";

const base: ValidatedContext = {
	version: 1,
	updatedAt: 1,
	workspace: "/tmp/work",
	file: "src/a.ts",
	language: "typescript",
	cursor: { line: 1, column: 1 },
	selection: null,
	blocked: false,
	truncated: false,
	stale: false,
};

describe("contextFingerprint", () => {
	it("is deterministic for identical contexts", () => {
		const a = contextFingerprint(base);
		const b = contextFingerprint({ ...base });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{16}$/);
	});

	it("differs when the file changes", () => {
		const a = contextFingerprint(base);
		const b = contextFingerprint({ ...base, file: "src/b.ts" });
		expect(a).not.toBe(b);
	});

	it("differs when the selection changes", () => {
		const a = contextFingerprint(base);
		const b = contextFingerprint({
			...base,
			selection: { startLine: 1, endLine: 1, text: "x" },
		});
		expect(a).not.toBe(b);
	});

	it("differs when the cursor moves", () => {
		const a = contextFingerprint(base);
		const b = contextFingerprint({ ...base, cursor: { line: 2, column: 1 } });
		expect(a).not.toBe(b);
	});

	it("differs between stale and fresh", () => {
		const a = contextFingerprint({ ...base, stale: false });
		const b = contextFingerprint({ ...base, stale: true });
		expect(a).not.toBe(b);
	});

	it("differs between blocked and ok", () => {
		const a = contextFingerprint({ ...base, blocked: false });
		const b = contextFingerprint({ ...base, blocked: true });
		expect(a).not.toBe(b);
	});
});
