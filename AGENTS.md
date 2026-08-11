# Repository Guidelines

A security-focused file-based bridge that lets the OMP agent see the active VS Code editor (file + selection) before every user turn, with no `@file` and no copy/paste. The bridge is local-only; the OMP agent may still transmit the resulting context to the model provider you have configured.

## Architecture & Data Flow

```text
VS Code (in-memory editor state)
  │  (atomic write: tmp + rename, in-memory editor APIs only)
  ▼
<workspace>/.omp/ide-context.json
  │  (schema-validated, canonical-path checked, size-bounded, fail-closed)
  ▼
OMP extension (ompextension) reads the file
  │  (XML-escaped, trust="untrusted" marker, language attribute sanitized)
  ▼
Prompt augmented with <ide_context trust="untrusted">…</ide_context>
```

The OMP side is a pure read path: it never reads the active file's body from disk. Source text comes from VS Code's `document.getText(selection)` only. The OMP extension is the trust boundary; the VS Code extension is the producer.

### Runtime pipeline (when `input` event fires)

1. `index.ts` checks `runtime.config.enabled` and that `event.text` is non-empty.
2. `reader.ts:readIdeContext()` → `assertInsideWorkspace` on the state-file path (mục 28) → `stat` + size cap (≤ 100 KiB).
3. JSON parse → `validator.ts:parseContextFile()` (closed `BlockReason` set, per-field caps).
4. Realpath-compare `workspace` field to OMP cwd; reject on mismatch.
5. If `blocked=true`, pass through (untitled / untrusted / sensitive / outside-workspace) and apply staleness.
6. Otherwise, `assertInsideWorkspace` on the active file path; soft-block to `outside-workspace` on failure (mục 30).
7. Stale check: if `now - updatedAt > staleAfterMs`, drop selection but keep file metadata.
8. `fingerprint.ts:contextFingerprint()` — if it matches the last injected fingerprint, skip (mục 39).
9. `block-builder.ts:buildContextBlock()` — XML-escape every byte, sanitize `language` attribute to `[a-z0-9_+\-]+`, emit `<ide_context trust="untrusted">…</ide_context>`.
10. Prepend to `event.text` in place; update status line and last-fingerprint.

## Key Directories

| Path | Purpose |
|---|---|
| `omp-extension/src/` | OMP-side modules: `index.ts` (event wiring + slash commands), `schema.ts` (constants + types), `validator.ts` (hand-rolled JSON validator), `path-safety.ts` (canonical-path boundary check), `reader.ts` (state-file reader + staleness), `block-builder.ts` (prompt block builder), `fingerprint.ts` (duplicate-injection gate). |
| `vscode-extension/src/` | VS Code-side modules: `extension.ts` (event listeners + commands), `schema.ts` (writer mirror), `sensitive-patterns.ts` (redaction patterns), `context-writer.ts` (atomic write). |
| `tests/` | `bun:test` suites that drive the OMP-side pure modules directly. |
| `plugin/omp-safe-ide-context-prompt-v2.md` | v2 spec (the brief the shipped bridge was built against). |

Both `omp-extension/` and `vscode-extension/` are independent TypeScript projects with their own `package.json` and `tsconfig.json`; the root `package.json` declares them as Bun workspaces.

## Development Commands

```bash
# Tests (65 across 6 files)
bun test tests/

# Typecheck (both packages, independent)
cd omp-extension && bun x tsc --noEmit
cd vscode-extension && bun x tsc --noEmit

# Install OMP plugin locally
cd omp-extension && omp plugin link "$(pwd)"

# Build VS Code extension
cd vscode-extension && bun x tsc -p .      # produces ./out/extension.js
```

There is no top-level `build` script and no monorepo orchestrator. Each subproject is self-contained.

## Code Conventions & Common Patterns

### File layout
- One module per file; default export is the extension factory.
- Subpath imports use the `.ts` extension (`import { x } from "./schema.ts"`). Required by `allowImportingTsExtensions: true` in both tsconfigs.
- No `index.ts` barrel inside `omp-extension/src/` — the entry imports siblings directly.

### Type narrowing
- Hand-rolled type guards over inline `as` casts. Examples:
  - `validator.ts:isPlainObject`, `isString`, `isPositiveInt`, `asBlockReason` — narrow `unknown` to typed values.
  - `schema.ts:VALID_BLOCK_REASONS: ReadonlySet<BlockReason>` — closed-set check via `.has()` for runtime validation.
  - Tagged-union returns (`{ ok: true; value } | { ok: false; reason }`) on every public function that can fail. Never `throw` in normal flow.
- Two type-narrowing helpers in `validator.ts` are worth knowing: `isBoundedString(v, max)` and `asBlockReason(v)`. Reuse them rather than open-coding.

### Error handling
- All public functions return tagged unions; nothing throws on the happy path.
- `try/catch` is reserved for: `readFile`/`stat` (returns `{ ok: false, reason: "ENOENT" | "..." }`), `JSON.parse` (returns `{ ok: false, reason: "JSON parse failed: ..." }`), config-file read in `index.ts:loadConfig` (returns defaults).
- `tool_result`-style override pattern in `index.ts:input` handler: mutate `event.text` in place rather than returning a new value.
- The `input` handler never notifies the user on benign misses ("no IDE context yet", "stale") — only logs the rejection reason implicitly through status line.

### Async
- All public APIs are `async` and return `Promise<T>`. No `.then()` chains.
- `ctx.setInterval` / `ctx.setTimeout` are used instead of raw timers (per OMP extension API rules; see `omp://extensions.md`).

### State
- Module-scoped `runtime` object in `index.ts` holds per-session state (`config`, `lastInjectedFingerprint`, `lastStatusReason`). Reset on `session_start` / `session_switch` / `session_branch`.
- Persistent state lives in `.omp/ide-context.json` (custom entry stream via `pi.appendEntry` is not used here; the state file is the persistence boundary).
- Blocked/untrusted decisions do not delete the state file; they set runtime flags only.

### Naming
- Files: `kebab-case.ts` (one per concept). `block-builder.ts` is the longest filename; `index.ts` is reserved for the entry.
- Constants: `SCREAMING_SNAKE_CASE`. Module-private helpers: `camelCase` (e.g. `fenceForLanguage`, `fenceForLanguageForAttr`).
- Types: `PascalCase`. `ValidatedContext`, `RawContextFile`, `ParseResult`, `ReadOutcome`, `BuiltBlock`, `BlockReason`.
- Branded constants live next to types: `MAX_PATH_CHARS`, `MAX_LANGUAGE_ID_CHARS`, `MAX_CURSOR_LINE/COLUMN`, `MAX_CONTEXT_FILE_BYTES`, `MAX_GENERIC_STRING_CHARS`, `VALID_BLOCK_REASONS`.

## Important Files

| File | Role |
|---|---|
| `omp-extension/src/index.ts` | OMP entry. Wires `session_start` / `session_switch` / `session_branch` / `input` events; registers `/ide-context-status`, `/ide-context-show`, `/ide-context-clear` slash commands; mutates `event.text` to inject the block. |
| `omp-extension/src/schema.ts` | All size caps, the `BlockReason` closed set, `ValidatedContext` shape. Single source of truth for both `omp-extension` and `vscode-extension` (kept in sync by hand; no shared code). |
| `omp-extension/src/validator.ts` | Hand-rolled JSON validator. The trust boundary. No `eval`, no `new Function`, no third-party JSON Schema. |
| `omp-extension/src/path-safety.ts` | `assertInsideWorkspace` with `realpath`-based canonical-path comparison. The macOS `/var` ↔ `/private/var` symlink case is handled. |
| `omp-extension/src/reader.ts` | Reads, parses, validates, age-checks, soft-blocks the state file. |
| `omp-extension/src/block-builder.ts` | Builds the `<ide_context trust="untrusted">…</ide_context>` block; XML-escapes; sanitizes the `language` attribute to `[a-z0-9_+\-]+`. |
| `vscode-extension/src/extension.ts` | VS Code entry. Monitors editor / document / selection; gates on `vscode.workspace.isTrusted`; listens to `onDidGrantWorkspaceTrust`; emits `BlockedContextFile` for untitled / outside-workspace / untrusted / sensitive cases. |
| `vscode-extension/src/context-writer.ts` | `writeContextAtomic` (tmp + rename). Only filesystem writer in the whole project. |
| `vscode-extension/src/sensitive-patterns.ts` | Compiled `*` / `**` glob matcher for `.env`, `*.pem`, `id_rsa`, `.git/**`, etc. |
| `tests/validator.test.ts` | Largest test file; 22 assertions including a generated loop over `VALID_BLOCK_REASONS`. |
| `README.md` | User-facing install / usage / config / Workspace Trust / uninstall. |
| `SECURITY.md` | Threat model, worst capability, final verdict `SAFE TO TEST LOCALLY`, six grep-based verification commands. |

## Runtime/Tooling Preferences

- **Runtime**: Bun. Both subprojects depend on `@oh-my-pi/pi-coding-agent` (resolved to v17.2.12 in this workspace); OMP loads `omp-extension/src/index.ts` directly through Bun — no transpile, no bundle.
- **Test runner**: `bun:test`. Import as `import { describe, expect, it } from "bun:test"`.
- **TypeScript**: strict mode on. Per-field unused-vars is a typecheck error (`noUnusedLocals`, `noUnusedParameters`). `allowImportingTsExtensions: true` is required because every import ends in `.ts`.
- **Types**: `@types/bun` is required; `omp-extension` also has `@oh-my-pi/pi-coding-agent` (in `devDependencies`, not `dependencies`).
- **No bundler / no transpiler / no formatter config** in this project. The OMP side runs raw TS; the VS Code side compiles with `tsc -p .` into `out/`.
- **Package manager**: Bun. The root `package.json` declares `"workspaces": ["omp-extension", "vscode-extension"]` and there is a `bun.lock` at the root.
- **No `preinstall` / `install` / `postinstall` scripts** in any package (per the v2 spec, mục 20).
- **No runtime dependencies** in either subproject — all imports are Node built-ins (`node:fs/promises`, `node:path`, `node:crypto`) or the OMP / VS Code API.

## Testing & QA

- **Framework**: `bun:test` only. 65 tests across 6 files:
  - `sensitive-patterns.test.ts` (8)
  - `validator.test.ts` (~22 incl. generated loop over `VALID_BLOCK_REASONS`)
  - `path-safety.test.ts` (8)
  - `fingerprint.test.ts` (6)
  - `block-builder.test.ts` (10)
  - `reader.test.ts` (11)
- **Test pattern**: `beforeAll`/`afterAll` with `mkdtemp(join(tmpdir(), "omp-ctx-..."))` for FS-touching suites; `afterAll` does `rm(root, { recursive: true, force: true })`. Symlink tests are wrapped in `try/catch` because some sandboxes disallow symlinks.
- **What the test suite covers (security boundaries)**:
  - Path traversal (`..`, NUL bytes, length > 4096).
  - Canonical-path containment (sibling-prefix case `/project` vs `/project-other`).
  - Sensitive patterns (`.env`, `*.pem`, `id_rsa`, `.git/**`, `node_modules/**`, etc.).
  - Malformed JSON, missing fields, wrong `version`, oversized strings.
  - Stale context drops selection.
  - Blocked shapes for every `BlockReason` value.
  - OOW soft-block converts a full context to a blocked context.
  - XML escape in selection text (`</ide_context> evil` is escaped, not broken out).
  - Language attribute sanitization to `[a-z0-9_+\-]+`.
  - Fingerprint determinism and per-field sensitivity.
- **What the test suite does NOT cover**:
  - The VSCode extension's `extension.ts` (no harness; relies on smoke tests).
  - The OMP event wiring in `index.ts` (smoke-tested by injecting synthetic state files into `<cwd>/.omp/ide-context.json` and asking the model "is marker X present?").
- **Smoke test (live OMP)**: create `<cwd>/.omp/ide-context.json` with a unique marker in `selection.text`, then `omp -p --no-session --cwd "$(pwd)" "is the marker present? yes/no"`. Marker should appear in the model's response. The 7-case smoke test is documented in the v2 implementation log.
- **Static security grep**: `SECURITY.md` lists six grep commands; every match is either in a comment or in the `SECURITY.md`/`README.md` prose that names the forbidden primitive. The OMP and VS Code `src/` trees should be free of `fetch`, `axios`, `http`, `https`, `WebSocket`, `net`, `child_process`, `exec(`, `spawn(`, `fork(`, `vm`, `eval(`, `new Function`, `process.env`. `readFile` is allowed only in `omp-extension/src/reader.ts`; `writeFile` is allowed only in `vscode-extension/src/context-writer.ts`; `document.getText` is allowed only in `vscode-extension/src/extension.ts`.
