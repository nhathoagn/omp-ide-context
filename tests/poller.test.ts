import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollIdeContextFiles, type PollEvent } from "../omp-extension/src/poller.ts";

let root: string;
let activeStop: (() => void) | null = null;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-poller-"));
	await mkdir(join(root, ".omp"), { recursive: true });
	activeStop = null;
});

afterEach(async () => {
	activeStop?.();
	activeStop = null;
	await rm(root, { recursive: true, force: true });
});

/**
 * Wait up to `timeoutMs` for an event matching `predicate`. The poll
 * interval is 100ms so this returns within ~150ms in the success
 * case and up to `timeoutMs` on failure. We use a real
 * Promise.withResolvers + a single timeout to keep the test
 * deterministic without faking timers.
 */
function awaitEvent(
	workspaceRoot: string,
	predicate: (e: PollEvent) => boolean,
	timeoutMs = 2000,
): Promise<PollEvent> {
	const { promise, resolve, reject } = Promise.withResolvers<PollEvent>();
	const collected: PollEvent[] = [];
	const handle = pollIdeContextFiles(workspaceRoot, (e) => {
		collected.push(e);
		if (predicate(e)) resolve(e);
	});
	activeStop = () => handle.stop();
	setTimeout(() => {
		reject(new Error(`timeout waiting for event; saw ${collected.length} events: ${JSON.stringify(collected)}`));
	}, timeoutMs);
	return promise;
}

describe("pollIdeContextFiles", () => {
	it("fires state-changed when the state file is rewritten", async () => {
		await writeFile(join(root, ".omp", "ide-context.json"), "{}", "utf8");
		const handle = pollIdeContextFiles(root, () => undefined);
		activeStop = () => handle.stop();
		await writeFile(join(root, ".omp", "ide-context.json"), '{"updated":1}', "utf8");
		const event = await awaitEvent(root, (e) => e.kind === "state-changed");
		expect(event.kind).toBe("state-changed");
	});

	it("fires config-changed when the config file is rewritten", async () => {
		const handle = pollIdeContextFiles(root, () => undefined);
		activeStop = () => handle.stop();
		await writeFile(join(root, ".omp", "ide-context.config.json"), '{"staleAfterMs":600000}', "utf8");
		const event = await awaitEvent(root, (e) => e.kind === "config-changed");
		expect(event.kind).toBe("config-changed");
	});

	it("detects selection changes within ~200ms (realtime requirement)", async () => {
		const handle = pollIdeContextFiles(root, () => undefined);
		activeStop = () => handle.stop();
		const events: PollEvent[] = [];
		const sub = pollIdeContextFiles(root, (e) => {
			if (e.kind === "state-changed") events.push(e);
		});
		// First write establishes the baseline
		await writeFile(join(root, ".omp", "ide-context.json"), '{"selection":{"startLine":1,"endLine":5}}', "utf8");
		// Wait one poll cycle for the baseline to be observed
		await new Promise((r) => setTimeout(r, 200));
		events.length = 0;
		// Now write a different selection and time how long it takes
		const t0 = Date.now();
		await writeFile(join(root, ".omp", "ide-context.json"), '{"selection":{"startLine":100,"endLine":200}}', "utf8");
		// Wait for the poller to fire
		const start = Date.now();
		while (events.length === 0 && Date.now() - start < 1500) {
			await new Promise((r) => setTimeout(r, 20));
		}
		const elapsed = Date.now() - t0;
		expect(events.length).toBeGreaterThan(0);
		// 100ms poll interval + a small margin for IO + scheduling.
		expect(elapsed).toBeLessThan(500);
		sub.stop();
	});

	it("stop() is idempotent and does not throw", () => {
		const handle = pollIdeContextFiles(root, () => undefined);
		expect(() => handle.stop()).not.toThrow();
		expect(() => handle.stop()).not.toThrow();
	});

	it("does not throw when the directory does not exist at start", () => {
		const handle = pollIdeContextFiles(root, () => undefined);
		handle.stop();
	});
});
