/**
 * Sensitive-file pattern matching for the writer side.
 *
 * The OMP side is the trust boundary, but defense in depth means the
 * VS Code extension MUST also redact selections from files matching the
 * sensitive list. The match is case-insensitive and is applied to the
 * path components of the active file.
 *
 * Pattern syntax (deliberately small — no third-party glob lib):
 *   `*`         matches any sequence of characters except `/`
 *   `**`        matches any sequence of characters including `/`
 *   `?`         matches a single character
 *   `*.ext`     matches a basename ending in `.ext`
 *   `.git/**`   matches anything under a `.git` directory
 *   `name*`     matches a basename starting with `name`
 *
 * The implementation walks the basename and the directory components of
 * the path separately so that `.git/**` and `node_modules/**` match the
 * corresponding folders anywhere in the tree.
 */

import { posix as path } from "node:path";
import { SENSITIVE_PATTERNS } from "./schema.ts";

/** Convert a single SENSITIVE_PATTERNS glob to a RegExp. */
function patternToRegExp(pattern: string): RegExp {
	let re = "^";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				re += ".*";
				i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (/[.+^$(){}|\\[\]]/.test(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	re += "$";
	return new RegExp(re, "i");
}

const COMPILED = SENSITIVE_PATTERNS.map(patternToRegExp);

/**
 * Check whether a workspace-relative file path matches any sensitive
 * pattern. `posixPath` MUST use forward slashes (the writer always
 * stores paths that way).
 */
export function isSensitive(posixPath: string): boolean {
	if (!posixPath || typeof posixPath !== "string") return true;
	const normalized = posixPath.replace(/^\.\//, "");
	const basename = path.posix.basename(normalized);
	for (const re of COMPILED) {
		if (re.test(basename)) return true;
		// Allow patterns like ".git/**" to match against the full path.
		if (re.test(normalized)) return true;
	}
	return false;
}
