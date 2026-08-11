/**
 * Stable fingerprint of a context for the "skip duplicate injection" rule.
 *
 * Two contexts with the same fingerprint (same file, same selection, same
 * updatedAt) are considered the same IDE state and only injected once.
 * The fingerprint is computed locally from validated data; it does NOT
 * trust any field that the writer may have tampered with beyond what
 * `parseContextFile()` already enforced.
 */

import { createHash } from "node:crypto";
import type { ValidatedContext } from "./schema.ts";

/**
 * Compute a 16-hex-char digest of the parts of the context that the
 * model actually consumes. Cheap to compare, safe to log.
 */
export function contextFingerprint(ctx: ValidatedContext): string {
	const parts: string[] = [
		ctx.file,
		String(ctx.cursor.line),
		String(ctx.cursor.column),
	];
	if (ctx.selection) {
		parts.push(String(ctx.selection.startLine));
		parts.push(String(ctx.selection.endLine));
		parts.push(ctx.selection.text);
	} else {
		parts.push("no-selection");
	}
	parts.push(ctx.blocked ? "blocked" : "ok");
	parts.push(ctx.stale ? "stale" : "fresh");
	return createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 16);
}
