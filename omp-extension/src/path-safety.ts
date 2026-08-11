/**
 * Path-safety utilities.
 *
 * The IDE context file is treated as untrusted input from another process.
 * Even though we control the writer (the VS Code extension in the same
 * monorepo), the file may be hand-edited, symlinked, or replaced by a
 * malicious actor. Every file path that comes out of `ide-context.json`
 * MUST pass through `assertInsideWorkspace()` before the OMP extension
 * reads it or embeds its content in a prompt.
 *
 * Hard rules:
 *   - Resolve the path with `realpath` (follows symlinks, no traversal).
 *   - Reject if the resolved path is not a child of the workspace root.
 *   - Reject if the path is a non-file (directory, socket, device).
 *   - Reject paths that exceed a length cap to avoid TOCTOU oddities.
 *
 * On macOS the system temp directory lives at `/var/folders/...` which is
 * a symlink to `/private/var/folders/...`. We follow the workspace root's
 * symlinks so the boundary check matches the realpath form used by `fs`.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_PATH_LENGTH = 4096;

export type PathCheck =
	| { ok: true; absolute: string; relative: string }
	| { ok: false; reason: string };

/**
 * `realpathSync` that swallows ENOENT (and other transient errors) and
 * returns the input unchanged. Used for the candidate path before the
 * `statSync` check below; a missing path is treated as a clean reject.
 */
function realpathSafe(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Normalize a workspace root: absolute, symlinks followed. This is the
 * canonical form the boundary check uses to compare relative paths.
 */
export function normalizeWorkspace(workspace: string): string {
	return realpathSafe(resolve(workspace));
}

/**
 * Validate that `candidate` (a path that came out of untrusted JSON)
 * resolves to a regular file inside `workspaceRoot`.
 *
 * The candidate may be:
 *   - absolute (e.g. "/Users/me/proj/src/foo.ts"), or
 *   - workspace-relative (e.g. "src/foo.ts"), or
 *   - a `..` traversal attempt that we must reject.
 */
export function assertInsideWorkspace(candidate: string, workspaceRoot: string): PathCheck {
	if (typeof candidate !== "string" || candidate.length === 0) {
		return { ok: false, reason: "path is empty or not a string" };
	}
	if (candidate.length > MAX_PATH_LENGTH) {
		return { ok: false, reason: `path exceeds ${MAX_PATH_LENGTH} chars` };
	}
	if (candidate.includes("\0")) {
		return { ok: false, reason: "path contains NUL byte" };
	}

	const workspaceReal = normalizeWorkspace(workspaceRoot);
	const absoluteRaw = isAbsolute(candidate) ? candidate : resolve(workspaceReal, candidate);
	const absolute = realpathSafe(absoluteRaw);

	// Block `..` traversal by checking the relative form would escape.
	// Comparing realpath-vs-realpath defeats the /var vs /private mismatch
	// on macOS, where `/var/folders/...` is a symlink to
	// `/private/var/folders/...`.
	const rel = relative(workspaceReal, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		return { ok: false, reason: "path escapes workspace" };
	}

	// Must be a regular file. The reader uses `readFile` which already
	// enforces this for non-symlink targets, but a symlink-to-directory
	// would still pass `readFileSync` checks. Belt and suspenders.
	let st;
	try {
		st = statSync(absolute);
	} catch {
		return { ok: false, reason: "path does not exist" };
	}
	if (!st.isFile()) {
		return { ok: false, reason: "not a regular file" };
	}

	// Use platform separator for the relative form. On Windows `relative`
	// already returns "\\"-separated; on POSIX it returns "/". Forward
	// slashes are accepted by all consumers, so normalize.
	const normalizedRel = rel.split(sep).join("/");
	return { ok: true, absolute, relative: normalizedRel };
}

/**
 * Compute a stable identifier for a path that does NOT leak the full
 * absolute path. Used for cache keys and fingerprints.
 */
export function shortPathKey(absolutePath: string, workspaceRoot: string): string {
	const rel = relative(normalizeWorkspace(workspaceRoot), absolutePath);
	return rel.split(sep).join("/");
}
