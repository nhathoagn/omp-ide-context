/**
 * Read and validate the IDE context file.
 *
 * Pipeline:
 *   1. Read `<workspace>/.omp/ide-context.json` with a small read budget
 *      (the file must always be tiny — a single context blob).
 *   2. Parse JSON. Any parse error is reported, never thrown.
 *   3. Validate the parsed object against the schema.
 *   4. Re-validate the file path against the workspace boundary.
 *   5. Compute `stale = (now - updatedAt) > staleAfterMs`.
 *   6. Return the validated context or a tagged failure.
 *
 * The reader NEVER reads the contents of the active file (mục 27 of the
 * v2 spec). It only touches `.omp/ide-context.json` and its `.tmp`
 * sibling. The model's `read` tool is the only path that may fetch
 * the active file body, and that path is gated by OMP's normal
 * permission system — entirely outside this bridge.
 */

import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseContextFile } from "./validator.ts";
import { assertInsideWorkspace, normalizeWorkspace } from "./path-safety.ts";
import {
	MAX_CONTEXT_FILE_BYTES,
	STATE_FILENAME,
	STATE_TMP_FILENAME,
	type ContextConfig,
	type ValidatedContext,
} from "./schema.ts";

export type ReadOutcome =
	| { ok: true; context: ValidatedContext; reason?: undefined }
	| { ok: false; reason: string; context?: undefined };

/**
 * Build the absolute path to the state file under a workspace root.
 * Splitting this from the reader keeps the path constant testable.
 * The workspace root is realpath'd so callers may pass either the
 * canonical form (`/private/var/folders/...`) or the symlink form
 * (`/var/folders/...`).
 */
export function stateFilePath(workspaceRoot: string): string {
	return join(normalizeWorkspace(workspaceRoot), ".omp", STATE_FILENAME);
}

/**
 * Build the absolute path to the temp file used for atomic writes.
 * Exposed for tests and for the writer (VS Code extension).
 */
export function stateTmpFilePath(workspaceRoot: string): string {
	return join(normalizeWorkspace(workspaceRoot), ".omp", STATE_TMP_FILENAME);
}

/**
 * Read, parse, validate, and age-check the IDE context file.
 *
 * `workspaceRoot` is the project root (already validated by the caller).
 * The function does not throw; it returns a tagged outcome.
 *
 * Path validation order is intentional (mục 28): the state file path
 * is checked first (cheap), then its bytes are read, then the writer's
 * `workspace` field is matched against the current OMP cwd via realpath,
 * then the active file path is re-checked. Any failure fails closed.
 */
export async function readIdeContext(workspaceRoot: string, config: ContextConfig, now: number): Promise<ReadOutcome> {
	if (!config.enabled) {
		return { ok: false, reason: "context injection disabled" };
	}

	const path = stateFilePath(workspaceRoot);
	const pathCheck = assertInsideWorkspace(path, workspaceRoot);
	if (!pathCheck.ok) {
		return { ok: false, reason: `state file path rejected: ${pathCheck.reason}` };
	}

	let raw: string;
	try {
		const st = await stat(pathCheck.absolute);
		if (!st.isFile()) {
			return { ok: false, reason: "state path is not a regular file" };
		}
		if (st.size > MAX_CONTEXT_FILE_BYTES) {
			return { ok: false, reason: `state file exceeds ${MAX_CONTEXT_FILE_BYTES} bytes` };
		}
		raw = await readFile(pathCheck.absolute, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: false, reason: "no IDE context yet" };
		return { ok: false, reason: `read failed: ${(err as Error).message}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, reason: `JSON parse failed: ${(err as Error).message}` };
	}

	const validated = parseContextFile(parsed);
	if (!validated.ok) {
		return { ok: false, reason: `schema rejected: ${validated.reason}` };
	}

	// The writer's `workspace` field must match the current workspace.
	// Comparing the resolved realpath forms stops `..` and symlink games
	// (mục 28). The current OMP cwd is the source of truth, not the
	// writer's claim.
	const writerRoot = normalizeWorkspace(validated.value.workspace);
	const ourRoot = normalizeWorkspace(workspaceRoot);
	if (writerRoot !== ourRoot) {
		return {
			ok: false,
			reason: `writer workspace "${writerRoot}" does not match current "${ourRoot}"`,
		};
	}

	// Blocked contexts only carry the workspace root; the file path is
	// intentionally empty and the boundary check is skipped because the
	// writer is explicitly telling us there is no active file to trust.
	// We still apply the staleness check so a stale block does not pin
	// the user's "no active file" status forever.
	if (validated.value.blocked) {
		const ageMs = now - validated.value.updatedAt;
		if (ageMs > config.staleAfterMs) {
			validated.value.stale = true;
		}
		return { ok: true, context: validated.value };
	}

	// Full context: validate the active file path. Per mục 28, we use
	// canonical paths and `relative()` containment, never `startsWith`.
	const fileCheck = assertInsideWorkspace(validated.value.file, workspaceRoot);
	if (!fileCheck.ok) {
		// Treat the OOW as a soft block: emit a blocked context instead
		// of dropping the whole turn (mục 30). The model still sees the
		// file path is unavailable; the user keeps their context slot.
		return {
			ok: true,
			context: {
				...validated.value,
				blocked: true,
				reason: "outside-workspace",
				file: "",
				selection: null,
			},
		};
	}
	validated.value.file = fileCheck.relative;

	// Compute staleness from the validated `updatedAt`.
	const ageMs = now - validated.value.updatedAt;
	if (ageMs > config.staleAfterMs) {
		validated.value.stale = true;
		// Per spec: when stale, do not inject selection. We keep file
		// metadata so the model still knows what file is open.
		validated.value.selection = null;
	}

	return { ok: true, context: validated.value };
}

/**
 * Convenience: list every state-file name (including the tmp sibling)
 * the bridge writes. Useful for security review and `.gitignore` docs.
 */
export function allStateFilenames(): string[] {
	return [STATE_FILENAME, STATE_TMP_FILENAME];
}

/**
 * Forward-slash relative form of a path, for logging and error messages.
 * Not used for security checks.
 */
export function displayRelative(absolute: string, workspaceRoot: string): string {
	const rel = relative(resolve(workspaceRoot), absolute);
	return rel.split(sep).join("/");
}
