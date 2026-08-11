/**
 * Schema constants and types for the VS Code side of the IDE context bridge.
 *
 * The shapes here MUST stay in lock-step with `omp-extension/src/schema.ts`.
 * The two packages are independent (no shared code at runtime), so the
 * reader is the security boundary and the writer is the producer.
 *
 * If you change a field on one side, change it on the other.
 */

export const SCHEMA_VERSION = 1 as const;

/** Filename of the context state file inside the workspace. */
export const STATE_FILENAME = "ide-context.json";
/** Atomic-write sibling; the writer stages here before renaming. */
export const STATE_TMP_FILENAME = "ide-context.tmp";

/** Default cap for selection text. Configurable. */
export const DEFAULT_MAX_SELECTION_CHARS = 20_000;

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

export type Cursor = { line: number; column: number };
export type Selection = {
	startLine: number;
	endLine: number;
	text: string;
	truncated?: boolean;
};

/**
 * Blocked contexts are emitted when the writer cannot safely expose the
 * active file. The `reason` is a closed set so the OMP side can validate
 * with a simple `Set.has()`.
 */
export type BlockReason = "outside-workspace" | "untrusted-workspace" | "sensitive-file" | "untitled";

/**
 * Full on-disk shape (with an active file).
 */
export type ContextFile = {
	version: typeof SCHEMA_VERSION;
	updatedAt: number;
	workspace: string;
	file: string;
	language: string;
	cursor: Cursor;
	selection: Selection | null;
	blocked: false;
	reason: null;
	truncated: boolean;
};

/**
 * Blocked on-disk shape. The `file`, `language`, `cursor`, and
 * `selection` fields are intentionally absent; only metadata that
 * never includes source content is allowed.
 */
export type BlockedContextFile = {
	version: typeof SCHEMA_VERSION;
	updatedAt: number;
	workspace: string;
	blocked: true;
	reason: BlockReason;
	truncated: false;
};
