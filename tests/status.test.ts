import { describe, expect, it } from "bun:test";
import { displayFile, MAX_FILE_DISPLAY_CHARS, selectionUpdateText, statusText } from "../omp-extension/src/status.ts";
import { DEFAULT_CONFIG, type ValidatedContext } from "../omp-extension/src/schema.ts";

const baseCtx: ValidatedContext = {
	version: 1,
	updatedAt: 1,
	workspace: "/tmp/work",
	file: "App.vue",
	language: "vue",
	cursor: { line: 1, column: 1 },
	selection: null,
	blocked: false,
	reason: null,
	truncated: false,
	stale: false,
};

describe("displayFile", () => {
	it("returns the path unchanged when short enough", () => {
		expect(displayFile("App.vue")).toBe("App.vue");
		expect(displayFile("src/components/UserForm.vue")).toBe("src/components/UserForm.vue");
	});

	it("returns the path unchanged at the cap boundary", () => {
		// A path of exactly the cap is not truncated.
		const exact = "a".repeat(MAX_FILE_DISPLAY_CHARS);
		expect(displayFile(exact)).toBe(exact);
	});

	it("truncates with leading ellipsis when path is too long", () => {
		const long = "a".repeat(MAX_FILE_DISPLAY_CHARS + 20);
		const out = displayFile(`foo/${long}.ts`);
		expect(out.startsWith("…/")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(MAX_FILE_DISPLAY_CHARS);
	});

	it("collapses a long path to the last two segments with leading ellipsis", () => {
		// 46 chars > 40 → truncated. Last two segments are
		// `nested/UserForm.vue`, the full output is `…/nested/UserForm.vue`.
		const long = "src/components/very/deeply/nested/UserForm.vue";
		expect(long.length).toBeGreaterThan(MAX_FILE_DISPLAY_CHARS);
		expect(displayFile(long)).toBe("…/nested/UserForm.vue");
	});
});

describe("selectionUpdateText", () => {
	it("keeps the transient selection notice concise because the status line owns the file path", () => {
		expect(selectionUpdateText({ startLine: 150, endLine: 153, text: "selected" })).toBe("IDE selection updated: lines 150–153");
	});

	it("confirms when the active editor has no selection", () => {
		expect(selectionUpdateText(null)).toBe("IDE context updated: no selection");
	});
});

describe("statusText", () => {
	it("returns 'off' when the bridge is disabled", () => {
		expect(statusText({ config: { ...DEFAULT_CONFIG, enabled: false }, lastContext: null })).toBe("IDE:off");
	});

	it("returns 'ready' when no context has been observed", () => {
		expect(statusText({ config: DEFAULT_CONFIG, lastContext: null })).toBe("IDE:ready");
	});

	it("shows file metadata when context is observed with no selection", () => {
		expect(statusText({ config: DEFAULT_CONFIG, lastContext: { ...baseCtx } })).toBe("IDE:App.vue");
	});

	it("shows selection range and line count", () => {
		const ctx: ValidatedContext = {
			...baseCtx,
			selection: { startLine: 50, endLine: 72, text: "x" },
		};
		expect(statusText({ config: DEFAULT_CONFIG, lastContext: ctx })).toBe("IDE:App.vue 50-72 (23 ln)");
	});

	it("marks stale contexts with a suffix", () => {
		const ctx: ValidatedContext = { ...baseCtx, stale: true };
		expect(statusText({ config: DEFAULT_CONFIG, lastContext: ctx })).toBe("IDE:App.vue (stale)");
	});

	it("renders the blocked reason in parentheses", () => {
		const ctx: ValidatedContext = { ...baseCtx, blocked: true, reason: "outside-workspace" };
		expect(statusText({ config: DEFAULT_CONFIG, lastContext: ctx })).toBe("IDE:App.vue (blocked:outside-workspace)");
	});

	it("truncates long paths in the status line", () => {
		const ctx: ValidatedContext = {
			...baseCtx,
			file: "src/components/very/deeply/nested/UserForm.vue",
		};
		const out = statusText({ config: DEFAULT_CONFIG, lastContext: ctx });
		expect(out.startsWith("IDE:…/")).toBe(true);
	});

	it("shows selection even on a long path", () => {
		const ctx: ValidatedContext = {
			...baseCtx,
			file: "src/components/very/deeply/nested/UserForm.vue",
			selection: { startLine: 5, endLine: 7, text: "x" },
		};
		const out = statusText({ config: DEFAULT_CONFIG, lastContext: ctx });
		expect(out).toContain("5-7");
		expect(out).toContain("(3 ln)");
		expect(out.startsWith("IDE:…/")).toBe(true);
	});
});
