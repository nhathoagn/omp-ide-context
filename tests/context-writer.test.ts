import { describe, expect, it } from "bun:test";
import { isBridgeStateFile } from "../vscode-extension/src/context-writer.ts";

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
