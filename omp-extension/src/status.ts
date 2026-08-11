/**
 * Render the TUI status line for the IDE context bridge.
 *
 * The shape follows VS Code's status-bar convention: prefix + active
 * file (truncated) + optional selection range + optional state suffix.
 * Empty string clears the slot.
 *
 * Extracted from `index.ts` so it can be unit-tested without a full
 * OMP runtime.
 */

import type { ContextConfig, ValidatedContext } from "./schema.ts";

/** Maximum length of the file portion in the status line. */
export const MAX_FILE_DISPLAY_CHARS = 40;

const STATUS_LABEL = "IDE";

/** Truncate a file path for display (matches VS Code's status-bar convention). */
export function displayFile(path: string): string {
	if (path.length <= MAX_FILE_DISPLAY_CHARS) return path;
	const segments = path.split("/");
	if (segments.length <= 2) {
		return `…/${path.slice(-(MAX_FILE_DISPLAY_CHARS - 2))}`;
	}
	const tail = segments.slice(-2).join("/");
	return `…/${tail}`;
}

/** Render the concise transient notice shown after an IDE selection changes. */
export function selectionUpdateText(selection: ValidatedContext["selection"]): string {
	if (!selection) return "IDE context updated: no selection";
	return `IDE selection updated: lines ${selection.startLine}–${selection.endLine}`;
}

export type StatusInputs = {
	config: ContextConfig;
	lastContext: ValidatedContext | null;
};

/**
 * Render the status line. Pure function — no I/O, no side effects.
 * The shape is intentionally short so it fits in a single TUI segment.
 */
export function statusText({ config, lastContext }: StatusInputs): string {
	if (!config.enabled) return `${STATUS_LABEL}:off`;
	if (!lastContext) return `${STATUS_LABEL}:ready`;
	if (lastContext.blocked) {
		return `${STATUS_LABEL}:${displayFile(lastContext.file || "—")} (blocked:${lastContext.reason ?? "unknown"})`;
	}
	const filePart = displayFile(lastContext.file);
	const sel = lastContext.selection;
	if (sel) {
		const lineCount = sel.endLine - sel.startLine + 1;
		return `${STATUS_LABEL}:${filePart} ${sel.startLine}-${sel.endLine} (${lineCount} ln)`;
	}
	if (lastContext.stale) return `${STATUS_LABEL}:${filePart} (stale)`;
	return `${STATUS_LABEL}:${filePart}`;
}
