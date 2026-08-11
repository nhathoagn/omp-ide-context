/**
 * Build, validate, and atomically write the IDE context file.
 *
 * The writer is the producer side of a file-based bridge. It MUST:
 *   1. Validate the workspace root (no symlink escape).
 *   2. Truncate selection text to the configured cap.
 *   3. Stage the new JSON in `<workspace>/.omp/ide-context.tmp`.
 *   4. Rename the tmp file to the final path (atomic on POSIX).
 *
 * The writer never reads source files from disk — it uses VS Code's
 * in-memory editor APIs (`document.getText`, `selection`) so the active
 * document content never flows through Node's filesystem layer.
 *
 * The module is intentionally small. It exports a small surface; the
 * rest lives in `extension.ts`.
 */

import { promises as fs } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import {
	DEFAULT_MAX_SELECTION_CHARS,
	STATE_FILENAME,
	STATE_TMP_FILENAME,
	type BlockReason,
	type BlockedContextFile,
	type ContextFile,
	type Selection,
} from "./schema.ts";

/**
 * Convert a workspace-relative URI path (always forward-slash) to a
 * POSIX-style path string. VS Code's `fsPath` returns native separators.
 */
export function uriToPosixRelative(workspaceRoot: string, fsPath: string): string {
	return relative(workspaceRoot, fsPath).split(sep).join("/");
}

const BRIDGE_STATE_FILES: Record<string, true> = {
	[`.omp/${STATE_FILENAME}`]: true,
	[`.omp/${STATE_TMP_FILENAME}`]: true,
	".omp/ide-context.config.json": true,
};

/** Return whether a workspace-relative file is managed by this bridge. */
export function isBridgeStateFile(file: string): boolean {
	return BRIDGE_STATE_FILES[file] === true;
}

/**
 * Build a fully-typed `ContextFile` from raw inputs. Truncates selection
 * text and sets `truncated` when over the cap.
 */
export function buildContextFile(args: {
	workspace: string;
	file: string;
	language: string;
	cursor: { line: number; column: number };
	selection: Selection | null;
	blocked: false;
	reason: null;
	now: number;
	maxSelectionChars?: number;
}): ContextFile {
	const cap = args.maxSelectionChars ?? DEFAULT_MAX_SELECTION_CHARS;
	let selection = args.selection;
	let truncated = false;
	if (selection && selection.text.length > cap) {
		selection = {
			startLine: selection.startLine,
			endLine: selection.endLine,
			text: selection.text.slice(0, cap),
		};
		truncated = true;
	}
	return {
		version: 1,
		updatedAt: args.now,
		workspace: args.workspace,
		file: args.file,
		language: args.language,
		cursor: args.cursor,
		selection,
		blocked: false,
		reason: null,
		truncated,
	};
}

/**
 * Build a fully-typed `BlockedContextFile`. Use this when the writer
 * cannot safely expose the active file (sensitive, outside workspace,
 * untrusted workspace, or untitled).
 */
export function buildBlockedContextFile(args: {
	workspace: string;
	reason: BlockReason;
	now: number;
}): BlockedContextFile {
	return {
		version: 1,
		updatedAt: args.now,
		workspace: args.workspace,
		blocked: true,
		reason: args.reason,
		truncated: false,
	};
}

/**
 * Compute the absolute path to the state file under a workspace root.
 * The caller is the only place that decides which workspace to write to.
 */
export function stateFilePath(workspaceRoot: string): string {
	return join(workspaceRoot, ".omp", STATE_FILENAME);
}

/**
 * Compute the absolute path to the tmp state file.
 */
export function stateTmpFilePath(workspaceRoot: string): string {
	return join(workspaceRoot, ".omp", STATE_TMP_FILENAME);
}

/**
 * Stage `content` in the tmp file and rename it to the final state file.
 *
 * Steps:
 *   1. Ensure `<workspace>/.omp` exists (mkdir -p).
 *   2. Write to `.omp/ide-context.tmp`.
 *   3. Rename `.omp/ide-context.tmp` to `.omp/ide-context.json`.
 *
 * Renaming across the same filesystem is atomic on POSIX. On Windows
 * `rename` is also atomic when the target does not exist, which is the
 * common case here; we do not attempt cross-volume fallback.
 */
export async function writeContextAtomic(
	workspaceRoot: string,
	content: ContextFile | BlockedContextFile,
): Promise<void> {
	const dir = join(workspaceRoot, ".omp");
	await fs.mkdir(dir, { recursive: true });
	const finalPath = stateFilePath(workspaceRoot);
	const tmpPath = stateTmpFilePath(workspaceRoot);
	const json = JSON.stringify(content, null, 2);
	await fs.writeFile(tmpPath, json, "utf8");
	await fs.rename(tmpPath, finalPath);
}

/**
 * Delete the state file (and its tmp sibling) for a workspace. Used by
 * the `disable` and `uninstall` flows.
 */
export async function deleteContextFiles(workspaceRoot: string): Promise<void> {
	for (const path of [stateTmpFilePath(workspaceRoot), stateFilePath(workspaceRoot)]) {
		try {
			await fs.unlink(path);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw err;
		}
	}
}

/**
 * Re-export `posix.basename` for convenience in callers that need a
 * POSIX basename regardless of host platform.
 */
export const posixBasename = (p: string): string => posix.basename(p);
