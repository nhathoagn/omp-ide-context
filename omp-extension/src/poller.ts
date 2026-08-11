/**
 * Poller for the IDE context bridge state and config files.
 *
 * Polls `<workspace>/.omp/ide-context.json` and
 * `<workspace>/.omp/ide-context.config.json` every `POLL_MS` and
 * fires a callback when either changes (detected by serialized
 * content comparison).
 *
 * Why polling instead of `node:fs.watch`:
 *   - OMP TUI re-renders status line on event-loop ticks. `fs.watch`
 *     fires its callback outside the render loop, so a status update
 *     set from that callback is not always painted.
 *   - Polling from `setInterval` runs on the same event-loop tick as
 *     the TUI renderer, so a `setStatus()` call here is reliably
 *     picked up by the next render pass.
 *   - `fs.watch` on macOS is also fragile: events can be coalesced,
 *     dropped, or delivered after a `close()`. The poll loop is
 *     straightforward and behaves identically across platforms.
 *
 * Security: the poller reads only files inside the workspace's
 * `.omp/` directory. The directory is created by the VSCode
 * extension with the same permissions as the workspace, so a user
 * who controls the workspace also controls what we read. We do not
 * follow symlinks out of the directory.
 */

import { readFile } from "node:fs/promises";

export type PollEvent =
	| { kind: "config-changed" }
	| { kind: "state-changed" };

export type PollHandle = {
	stop(): void;
};

const OMP_DIR = ".omp";
const CONFIG_NAME = "ide-context.config.json";
const STATE_NAME = "ide-context.json";
const POLL_MS = 100;

const joinPath = (root: string, ...parts: string[]): string => {
	const all = [root, ...parts];
	return all.map((p) => (p.endsWith("/") ? p.slice(0, -1) : p)).join("/");
};

const readOrNull = async (path: string): Promise<string | null> => {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		// ENOENT is expected when the file does not exist yet. Any
		// other read error is also swallowed: the next tick will
		// retry, and a single missed observation is not a security
		// issue.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		return null;
	}
};

/**
 * Start polling. Calls `cb` whenever the config or state file
 * content changes. Stops cleanly on `handle.stop()`. Idempotent on
 * stop (multiple calls are safe).
 */
export function pollIdeContextFiles(
	workspaceRoot: string,
	cb: (event: PollEvent) => void,
): PollHandle {
	const configPath = joinPath(workspaceRoot, OMP_DIR, CONFIG_NAME);
	const statePath = joinPath(workspaceRoot, OMP_DIR, STATE_NAME);

	let lastConfigText: string | null = null;
	let lastStateText: string | null = null;
	let stopped = false;

	const tick = async (): Promise<void> => {
		if (stopped) return;
		const [config, state] = await Promise.all([
			readOrNull(configPath),
			readOrNull(statePath),
		]);
		if (stopped) return;

		if (config !== null && config !== lastConfigText) {
			lastConfigText = config;
			cb({ kind: "config-changed" });
		}
		if (state !== null && state !== lastStateText) {
			lastStateText = state;
			cb({ kind: "state-changed" });
		}
		// Note: when a file is deleted we leave the last-seen text
		// in place. A subsequent re-creation will still fire because
		// the new text will differ from the cached value. This avoids
		// a notification storm during transient ENOENT.
	};

	const interval = setInterval(() => {
		void tick();
	}, POLL_MS);

	// Kick off the first tick immediately so the initial config /
	// state is picked up without waiting `POLL_MS`. Do not block the
	// caller's thread on it.
	void tick();

	return {
		stop(): void {
			if (stopped) return;
			stopped = true;
			clearInterval(interval);
		},
	};
}
