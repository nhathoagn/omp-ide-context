/**
 * Build the `<ide_context>` block that is prepended to the user prompt.
 *
 * The block is deliberately wrapped in XML-like boundaries with explicit
 * sub-tags for the active file and the selected code. The opening tag
 * carries `trust="untrusted"` so downstream consumers (and any future
 * parsers) cannot mistake the block for a system instruction. Every
 * byte that originates outside this module is XML-escaped before
 * interpolation (mục 15 and mục 38 of the v2 spec).
 *
 * The function never throws and always returns a string. It MUST NOT
 * include the workspace root, environment variables, or any field not
 * present in the validated context.
 */

import type { ValidatedContext } from "./schema.ts";

/** Plain-text fence info for syntax highlighting inside the prompt. */
function fenceForLanguage(language: string): string {
	const lang = language.trim().toLowerCase();
	if (lang === "" || lang === "plaintext" || lang === "text") return "";
	return lang;
}

export type BuiltBlock =
	| { ok: true; block: string }
	| { ok: false; reason: string };

/**
 * Build the user-facing context block from a validated context. The
 * function is total: it either returns `{ ok: true, block }` or
 * `{ ok: false, reason }`. The caller decides whether to inject.
 *
 * The opening tag is ALWAYS `<ide_context trust="untrusted">`, even
 * when the context is blocked. This is the prompt-injection hardening
 * mandated by mục 38.
 */
export function buildContextBlock(ctx: ValidatedContext, opts: { includeSelection: boolean; maxSelectionChars: number }): BuiltBlock {
	if (ctx.blocked) {
		// Blocked contexts expose only metadata. The reason is escaped
		// in case the writer produced a non-standard string. We never
		// interpolate selection.text because the writer left it null.
		const reason = ctx.reason ?? "blocked";
		return {
			ok: true,
			block:
				`<ide_context trust="untrusted">\n` +
				`  <note>selection redacted: ${escapeXml(reason)}</note>\n` +
				`</ide_context>\n\n`,
		};
	}

	let body =
		`<ide_context trust="untrusted">\n` +
		`  <active_file>${escapeXml(ctx.file)}</active_file>\n` +
		`  <language>${escapeXml(ctx.language)}</language>\n` +
		`  <cursor line="${ctx.cursor.line}" column="${ctx.cursor.column}" />\n`;

	if (ctx.stale) {
		body += `  <stale>true</stale>\n`;
	}

	if (ctx.selection && opts.includeSelection) {
		const text = truncateForDisplay(ctx.selection.text, opts.maxSelectionChars);
		const truncatedNote = ctx.selection.truncated || text.length < ctx.selection.text.length
			? `\n  <!-- selection truncated to ${opts.maxSelectionChars} chars -->`
			: "";
		const fence = fenceForLanguage(ctx.language);
		body +=
			`  <selected_lines>${ctx.selection.startLine}-${ctx.selection.endLine}</selected_lines>\n` +
			`  <selected_code language="${escapeXml(fenceForLanguageForAttr(ctx.language))}">${fence ? `\n\`\`\`${fence}` : ""}\n` +
			`${escapeXml(text)}\n` +
			`${fence ? "```" : ""}</selected_code>${truncatedNote}\n`;
	} else if (ctx.selection && !opts.includeSelection) {
		body +=
			`  <selected_lines>${ctx.selection.startLine}-${ctx.selection.endLine}</selected_lines>\n` +
			`  <note>selection omitted by configuration</note>\n`;
	}

	body += `</ide_context>\n\n`;
	return { ok: true, block: body };
}

/**
 * Same as `fenceForLanguage` but mapped to a small whitelist of safe
 * attribute values. Used for the `language="..."` attribute on the
 * `<selected_code>` tag; we never let arbitrary text into an attribute
 * position.
 */
function fenceForLanguageForAttr(language: string): string {
	const lang = language.trim().toLowerCase();
	if (lang === "" || lang === "plaintext" || lang === "text") return "text";
	// Accept only [a-z0-9_+-]+ characters in the attribute value. Strip
	// anything else so a malicious language id cannot break out of the
	// attribute.
	return lang.replace(/[^a-z0-9_+\-]/g, "");
}

/**
 * Defensive XML escape. The model is downstream of untrusted data that
 * the writer (VS Code extension) put in the file; the only safe default
 * is to escape every interpolation, even though we control the writer.
 *
 * Drops control characters except TAB, LF, CR. This prevents stray
 * escape sequences from breaking the boundary hint that follows the
 * `<ide_context>` block.
 */
function escapeXml(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (code === 0x26) out += "&amp;";
		else if (code === 0x3c) out += "&lt;";
		else if (code === 0x3e) out += "&gt;";
		else if (code === 0x22) out += "&quot;";
		else if (code === 0x27) out += "&apos;";
		else if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
			// drop other control chars
		} else {
			out += ch;
		}
	}
	return out;
}

/**
 * Truncate a string to `max` characters. We count by UTF-16 code units
 * (matches `String#length`) which is good enough for the selection-text
 * case; if multi-byte characters matter, a code-point counter is better,
 * but the OMP prompt is already UTF-16.
 */
function truncateForDisplay(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, Math.max(0, max));
}
