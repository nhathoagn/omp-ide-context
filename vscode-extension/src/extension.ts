/**
 * omp-safe-ide-context — VS Code extension entry point.
 *
 * Monitors the active editor, the active document, cursor position, and
 * text selection. Whenever any of those change, it stages a fresh
 * `ide-context.json` inside the workspace's `.omp/` directory using an
 * atomic write (tmp + rename).
 *
 * The extension NEVER:
 *   - opens a network connection,
 *   - spawns a child process or runs a shell command,
 *   - reads the active file from disk (it uses `document.getText` only),
 *   - reads files outside the active document,
 *   - reads user home, SSH, AWS, or environment variables.
 *
 * Selection text from sensitive files is redacted (file metadata only,
 * `selection = null`, `blocked = true`). When the active document is
 * untitled (a new unsaved buffer) or outside any workspace folder, a
 * `BlockedContextFile` is written instead of a full context — the
 * active file path never leaves VS Code in those cases (mục 30).
 *
 * The companion OMP extension consumes the file. This extension does
 * not know about OMP beyond the file path it writes to.
 *
 * Workspace Trust (mục 34): when `vscode.workspace.isTrusted` is
 * false, the writer stops producing state files and shows a status
 * message in the IDE. Once the user grants trust, writes resume.
 */

import * as vscode from "vscode";
import {
	buildBlockedContextFile,
	buildContextFile,
	deleteContextFiles,
	stateFilePath,
	uriToPosixRelative,
	writeContextAtomic,
} from "./context-writer.ts";
import { isSensitive } from "./sensitive-patterns.ts";
import {
	DEFAULT_MAX_SELECTION_CHARS,
	type BlockReason,
	type BlockedContextFile,
	type ContextFile,
} from "./schema.ts";

/** Outcome of capturing the active editor. */
type Capture =
	| { kind: "active"; context: ContextFile }
	| { kind: "blocked"; reason: BlockReason; workspace: string }
	| null;

/**
 * Module state. We hold the current "last write" so a no-op selection
 * change (e.g. an arrow key that does not move the cursor) does not
 * rewrite the file. The check is local — no networking, no telemetry.
 */
type State = {
	enabled: boolean;
	lastSerialized: string | null;
};

const state: State = {
	enabled: true,
	lastSerialized: null,
};

/**
 * Compose a `ContextFile` for the currently active editor. Returns
 * `null` when there is no active editor or no workspace folder.
 *
 * Per mục 30, the writer is responsible for emitting a blocked shape
 * when the active document is outside the workspace, sensitive, or
 * untitled. The OMP side re-validates the file path independently.
 */
function captureContext(): Capture {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return null;
	const document = editor.document;
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!workspaceFolder) return null;

	const workspaceRoot = workspaceFolder.uri.fsPath;

	// mục 30 — Untitled documents (new unsaved buffers) must not be
	// treated as workspace files. Their `uri.scheme` is "untitled".
	if (document.isUntitled) {
		return { kind: "blocked", reason: "untitled", workspace: workspaceRoot };
	}

	const file = uriToPosixRelative(workspaceRoot, document.uri.fsPath);
	const language = document.languageId;
	const cursor = {
		// VS Code positions are 0-indexed; the schema and OMP side are 1-indexed.
		line: editor.selection.active.line + 1,
		column: editor.selection.active.character + 1,
	};

	const sensitive = isSensitive(file);
	if (sensitive) {
		// mục 4 — sensitive files: redact selection but keep file
		// metadata so the model knows what file is open.
		return {
			kind: "active",
			context: buildContextFile({
				workspace: workspaceRoot,
				file,
				language,
				cursor,
				selection: null,
				blocked: false,
				reason: null,
				now: Date.now(),
				maxSelectionChars: DEFAULT_MAX_SELECTION_CHARS,
			}),
		};
	}

	// mục 3 — only the selection is captured; the body of the file is
	// never read by the bridge. The selection comes from VS Code's
	// in-memory editor API.
	let selection: ContextFile["selection"] = null;
	if (!editor.selection.isEmpty) {
		const startLine = editor.selection.start.line + 1;
		const endLine = editor.selection.end.line + 1;
		const text = document.getText(editor.selection);
		selection = { startLine, endLine, text };
	}

	return {
		kind: "active",
		context: buildContextFile({
			workspace: workspaceRoot,
			file,
			language,
			cursor,
			selection,
			blocked: false,
			reason: null,
			now: Date.now(),
			maxSelectionChars: DEFAULT_MAX_SELECTION_CHARS,
		}),
	};
}

/**
 * Serialize the content and write it atomically. Skips the write when
 * the serialized payload matches the last write — keeps the file
 * mtime stable and avoids spurious edits.
 */
async function publishContext(content: ContextFile | BlockedContextFile): Promise<void> {
	const json = JSON.stringify(content);
	// Always write on each call. The previous de-duplication skipped
	// writes when the JSON was identical, but a transient collapse
	// (selection → null) followed by a re-highlight must still produce
	// a fresh file so the OMP bridge sees the latest selection. The
	// atomic write is cheap (~200 B) and the event is naturally
	// debounced by the editor event itself.
	state.lastSerialized = json;
	await writeContextAtomic(content.workspace, content);
}

/**
 * Force a re-capture and write. Triggered by manual commands and
 * event listeners. Returns silently when nothing is active.
 */
async function refreshContext(): Promise<void> {
	// mục 34 — workspace trust gate. When the workspace is untrusted,
	// the writer must not export selected source code. We clear the
	// state file so the OMP side sees a missing file rather than
	// stale data, and we do not capture a new context.
	if (!vscode.workspace.isTrusted) {
		const active = vscode.window.activeTextEditor;
		if (active) {
			const folder = vscode.workspace.getWorkspaceFolder(active.document.uri);
			if (folder) {
				try {
					await deleteContextFiles(folder.uri.fsPath);
				} catch {
					// Best effort: a missing file is fine.
				}
			}
		}
		state.lastSerialized = null;
		return;
	}

	const captured = captureContext();
	if (!captured) return;
	if (captured.kind === "active") {
		await publishContext(captured.context);
	} else {
		await publishContext(buildBlockedContextFile({
			workspace: captured.workspace,
			reason: captured.reason,
			now: Date.now(),
		}));
	}
}

/**
 * Register the three user-visible commands and the event listeners.
 * Exported so the test harness can drive them; the actual entry point
 * for VS Code is the default `activate` below.
 */
export function registerExtension(context: vscode.ExtensionContext): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	disposables.push(
		vscode.window.onDidChangeActiveTextEditor(async () => {
			if (state.enabled) await refreshContext();
		}),
	);

	disposables.push(
		vscode.workspace.onDidChangeTextDocument(async (event) => {
			if (!state.enabled) return;
			const active = vscode.window.activeTextEditor;
			if (!active || active.document !== event.document) return;
			await refreshContext();
		}),
	);

	disposables.push(
		vscode.window.onDidChangeTextEditorSelection(async (event) => {
			if (!state.enabled) return;
			const editor = event.textEditor;
			if (!vscode.window.activeTextEditor || vscode.window.activeTextEditor !== editor) return;
			await refreshContext();
		}),
	);

	// mục 34 — when the user grants workspace trust, re-capture so the
	// file is produced immediately.
	disposables.push(
		vscode.workspace.onDidGrantWorkspaceTrust(async () => {
			if (state.enabled) await refreshContext();
		}),
	);

	// ── Commands ────────────────────────────────────────────────────────
	disposables.push(
		vscode.commands.registerCommand("ompIdeContext.showCurrent", async () => {
			const captured = captureContext();
			if (!captured) {
				void vscode.window.showInformationMessage("OMP IDE Context: no active editor.");
				return;
			}
			if (captured.kind === "blocked") {
				void vscode.window.showInformationMessage(
					`OMP IDE Context: blocked (${captured.reason}). No source code is exported.`,
				);
				return;
			}
			const path = stateFilePath(captured.context.workspace);
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
			await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
		}),
	);

	disposables.push(
		vscode.commands.registerCommand("ompIdeContext.enable", () => {
			state.enabled = true;
			void refreshContext();
			if (!vscode.workspace.isTrusted) {
				void vscode.window.showWarningMessage(
					"OMP IDE Context: enabled, but the workspace is untrusted. No source code will be exported until you trust the workspace.",
				);
			} else {
				void vscode.window.showInformationMessage("OMP IDE Context: enabled.");
			}
		}),
	);

	disposables.push(
		vscode.commands.registerCommand("ompIdeContext.disable", async () => {
			state.enabled = false;
			// Best-effort cleanup so a future OMP session does not see a
			// stale context. We only delete for the current workspace.
			const active = vscode.window.activeTextEditor;
			if (active) {
				const folder = vscode.workspace.getWorkspaceFolder(active.document.uri);
				if (folder) await deleteContextFiles(folder.uri.fsPath);
			}
			state.lastSerialized = null;
			void vscode.window.showInformationMessage("OMP IDE Context: disabled.");
		}),
	);

	for (const d of disposables) context.subscriptions.push(d);
	return disposables;
}

/**
 * VS Code extension entry point.
 */
export function activate(context: vscode.ExtensionContext): void {
	registerExtension(context);
	// Eager first capture so the file exists before the user does anything.
	void refreshContext();
}

/**
 * VS Code extension teardown. Best-effort: the next session will simply
 * see no context file and skip injection.
 */
export function deactivate(): void {
	state.enabled = false;
	state.lastSerialized = null;
}
