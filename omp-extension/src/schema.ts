/**
 * Schema constants and types for the IDE context bridge.
 *
 * The same shape is written by the VS Code extension into
 * `<workspace>/.omp/ide-context.json` and read by the OMP extension.
 *
 * This module intentionally uses ONLY hand-rolled validation (no eval,
 * no new Function, no external JSON-Schema library). It is the trust
 * boundary for untrusted data from the IDE.
 *
 * Size limits (mục 31 of the v2 spec) are conservative: the on-disk
 * file is metadata + one selection, and the OMP extension is the only
 * reader. Every limit has a one-line reason and is enforced at the
 * validator AND at the reader (defense in depth).
 */

export const SCHEMA_VERSION = 1 as const;
export const STATE_FILENAME = "ide-context.json";
export const STATE_TMP_FILENAME = "ide-context.tmp";

/** Strict upper bound on selection text included in the file. */
export const DEFAULT_MAX_SELECTION_CHARS = 20_000;

/** Anything older than this is treated as stale (no selection injected). */
export const DEFAULT_STALE_AFTER_MS = 30_000;

/** Hard cap on the size of `.omp/ide-context.json` itself. 100 KiB. */
export const MAX_CONTEXT_FILE_BYTES = 100_000;

/** Hard cap on a single path string (workspace root or active file). */
export const MAX_PATH_CHARS = 4_096;

/** Hard cap on the language id reported by VS Code. */
export const MAX_LANGUAGE_ID_CHARS = 100;

/** Hard cap on the cursor line (1-indexed, positive). */
export const MAX_CURSOR_LINE = 1_000_000;

/** Hard cap on the cursor column (0-indexed, non-negative). */
export const MAX_CURSOR_COLUMN = 10_000;

/** Hard cap on a single JSON string field (excluding `selection.text`). */
export const MAX_GENERIC_STRING_CHARS = 4_096;

/** Filename / glob patterns that must never carry selection content. */
export const SENSITIVE_PATTERNS: ReadonlyArray<string> = [
	".env",
	".env.*",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"id_rsa",
	"id_ed25519",
	".git/**",
	".ssh/**",
	".aws/**",
	".gnupg/**",
	"node_modules/**",
	"credentials*",
	"secrets*",
];

/**
 * Cursor position inside the active editor.
 */
export type Cursor = { line: number; column: number };

/**
 * Selection inside the active editor.
 *
 * `text` is the selected snippet, already truncated to `maxSelectionChars`
 * by the writer. `truncated` is true when the original selection exceeded
 * the cap and was elided.
 */
export type Selection = {
	startLine: number;
	endLine: number;
	text: string;
	truncated?: boolean;
};

/**
 * Reason the writer redacted the context. `outside-workspace` means the
 * active document is not inside any VS Code workspace folder (spec mục 30).
 * `untrusted-workspace` means the workspace itself is untrusted (mục 34).
 * `sensitive-file` means the file path matches a sensitive pattern (mục 4).
 * `untitled` means the active document is a virtual/untitled buffer.
 */
export type BlockReason = "outside-workspace" | "untrusted-workspace" | "sensitive-file" | "untitled";

/**
 * Closed set of valid block reasons, used by the validator for
 * "Unknown/invalid type rejection" (mục 29). Defined as a Set so the
 * validator can do a single `.has()` lookup at runtime.
 */
export const VALID_BLOCK_REASONS: ReadonlySet<BlockReason> = new Set<BlockReason>([
	"outside-workspace",
	"untrusted-workspace",
	"sensitive-file",
	"untitled",
]);

/**
 * The raw on-disk shape written by the VS Code extension.
 *
 * Every field is optional at the type level because the OMP side must
 * validate strictly and reject anything that does not conform. Only after
 * `parseContextFile()` returns a `ValidatedContext` is the data trusted.
 */
export type RawContextFile = {
	version?: unknown;
	updatedAt?: unknown;
	workspace?: unknown;
	file?: unknown;
	language?: unknown;
	cursor?: unknown;
	selection?: unknown;
	blocked?: unknown;
	truncated?: unknown;
	reason?: unknown;
};

/**
 * The validated, trusted shape after `parseContextFile()` succeeds.
 *
 * `blocked` is true when the writer redacted the file because it matched
 * a sensitive pattern, was outside the workspace, or the workspace was
 * untrusted. `reason` carries which rule triggered the block.
 * `stale` is computed by the reader, not the writer.
 */
export type ValidatedContext = {
	version: typeof SCHEMA_VERSION;
	updatedAt: number;
	workspace: string;
	file: string;
	language: string;
	cursor: Cursor;
	selection: Selection | null;
	blocked: boolean;
	reason: BlockReason | null;
	truncated: boolean;
	stale: boolean;
};

/**
 * Configuration for the OMP-side reader. Mirrors the spec's
 * "minimal configuration" table.
 */
export type ContextConfig = {
	enabled: boolean;
	includeSelection: boolean;
	maxSelectionChars: number;
	staleAfterMs: number;
};

export const DEFAULT_CONFIG: ContextConfig = {
	enabled: true,
	includeSelection: true,
	maxSelectionChars: DEFAULT_MAX_SELECTION_CHARS,
	staleAfterMs: DEFAULT_STALE_AFTER_MS,
};

/**
 * Result of validating a single JSON value. Tagged so the caller can
 * `switch` on the outcome without ambiguity.
 */
export type ParseResult =
	| { ok: true; value: ValidatedContext }
	| { ok: false; reason: string };
