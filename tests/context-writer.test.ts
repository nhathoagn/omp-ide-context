import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildContextFile,
	isBridgeStateFile,
	stateFilePath,
	writeContextAtomic,
} from "../vscode-extension/src/context-writer.ts";

describe("isBridgeStateFile", () => {
	it("excludes bridge-owned files to prevent self-triggered writes", () => {
		expect(isBridgeStateFile(".omp/ide-context.json")).toBe(true);
		expect(isBridgeStateFile(".omp/ide-context.tmp")).toBe(true);
		expect(isBridgeStateFile(".omp/ide-context.config.json")).toBe(true);
	});

	it("allows ordinary workspace files to be captured", () => {
		expect(isBridgeStateFile("src/App.vue")).toBe(false);
		expect(isBridgeStateFile(".omp/other.json")).toBe(false);
	});
});

describe("writeContextAtomic", () => {
	it("serializes concurrent writes that share the temporary state file", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "omp-ctx-write-"));
		const writes = Array.from({ length: 16 }, (_, index) =>
			writeContextAtomic(
				workspace,
				buildContextFile({
					workspace,
					file: "src/active.ts",
					language: "typescript",
					cursor: { line: 1, column: 1 },
					selection: { startLine: 1, endLine: 1, text: `event ${index}` },
					blocked: false,
					reason: null,
					now: index,
				}),
			),
		);

		try {
			await Promise.all(writes);
			const serialized = await readFile(stateFilePath(workspace), "utf8");
			expect(serialized).toContain('"updatedAt": 15');
			expect(serialized).toContain('"text": "event 15"');
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
