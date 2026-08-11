# SECURITY.md

The threat model is the central reason this project exists. A "context bridge" between an IDE and a coding agent is exactly the kind of feature where a careless implementation can leak secrets, exfiltrate source code, or become a remote-code-execution foothold. This document lists the things the bridge **can access**, the things it **cannot**, the worst capability it has today, and the verdict for local testing.

## Threat model (mục 40)

### Assets

- **Source code** in any open VS Code document.
- **Selected code** — the highlighted slice that the bridge synchronizes.
- **Project paths** — workspace roots and relative file paths.
- **Credentials** — anything in `.env`, `*.pem`, `*.key`, etc.
- **Environment variables** — none, but called out for completeness.
- **User filesystem** — strictly the workspace folder and the IDE state file.
- **OMP context** — the model prompt that will receive the bridge output.

### Trust boundaries

```text
VS Code editor state
    ↓
VS Code extension
    ↓
.omp/ide-context.json  (atomic write: tmp + rename)
    ↓
OMP extension (read + validate + canonical-path check + size cap)
    ↓
OMP agent / model provider
```

The bridge itself is **local-only** — no socket is opened, no packet is sent, no remote endpoint is contacted. Any context the bridge injects into OMP may subsequently be transmitted to the model provider the user has configured; that is normal OMP behavior and is the user's choice.

### Threats evaluated (and how each is mitigated)

| Threat | Mitigation |
|---|---|
| Malicious workspace files | Source content is read only via `document.getText(selection)`, never from disk. The active file path is canonical-checked against the workspace root (mục 28). |
| Prompt injection in source code | The injection block is wrapped in `<ide_context trust="untrusted">`, the boundary hint tells the model it is data, and every byte is XML-escaped. Selection text is wrapped in `<selected_code>` and the `language` attribute is sanitized to `[a-z0-9_+\-]+` (mục 38). |
| Maliciously modified `ide-context.json` | Strict hand-rolled validator; closed set of `BlockReason` values; every string is bounded (`MAX_PATH_CHARS`, `MAX_LANGUAGE_ID_CHARS`, `MAX_GENERIC_STRING_CHARS`); the workspace field is matched against the realpath of the OMP cwd and rejected otherwise (mục 29). |
| Path traversal | The `file` field goes through `assertInsideWorkspace` which rejects `..` traversal, absolute paths outside the workspace, symlink escapes, NUL bytes, and paths over `MAX_PATH_CHARS`. Soft-block rather than hard-reject on OOW so the model still sees a `outside-workspace` marker (mục 30). |
| Symlink escape | `realpathSync` is called on the candidate and compared to the realpath of the workspace root (mục 28). `/var/folders` ↔ `/private/var/folders` on macOS is handled correctly. |
| Oversized context | The state file is bounded at `MAX_CONTEXT_FILE_BYTES = 100_000`. Selection text is bounded at `MAX_CONTEXT_FILE_BYTES` (the same hard cap) regardless of the config's `maxSelectionChars`. Cursor line/column are bounded at `MAX_CURSOR_LINE` and `MAX_CURSOR_COLUMN` (mục 31). |
| Sensitive-file selection | The VS Code side redacts the selection when the file matches a closed list of patterns (`.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`, `.git/**`, `.ssh/**`, `.aws/**`, `.gnupg/**`, `node_modules/**`, `credentials*`, `secrets*`). The OMP side re-checks the pattern on the OMP side as defense in depth (mục 4). |
| Out-of-workspace editor | The VS Code side emits a `BlockedContextFile` with `reason="outside-workspace"`. Untitled (new unsaved) documents emit `reason="untitled"`. Neither path ever includes the file body (mục 30). |
| Local process tampering with the context file | The reader validates schema, size, path, and freshness on every read. A hand-edited state file fails closed. The `version` field is pinned to `1`; the validator rejects anything else. |
| Accidental source-code logging | There is no logging code in either extension. The boundary hint and the OMP UI show only metadata (`<active_file>` and `<selected_lines>`), never selection contents. The OMP status line shows `ide-ctx:blocked:outside-workspace` (a closed enum) and similar — no source content. (mục 33) |
| Untrusted workspace | VS Code's `workspace.isTrusted` is checked before every capture. When false, the writer deletes the state file and the OMP side sees a missing file (mục 34). The companion `onDidGrantWorkspaceTrust` listener resumes writes. |
| Multi-root workspace cross-contamination | `vscode.workspace.getWorkspaceFolder(document.uri)` is used to pick the boundary for each document; one workspace root cannot authorize another (mục 35). |
| TOCTOU between validation and use | Source text comes from VS Code's in-memory editor API at capture time. The state file is read once and validated in the same call. There is no second-stage source-file read (mục 27, mục 36). |
| Secret expansion (`$HOME`, `~`, `$(cmd)`) | The validator treats them as plain untrusted strings. The boundary check is the only place paths are resolved, and it does not expand them. (mục 37) |

## What the bridge CAN access

- The **active file path** in the currently focused editor tab.
- The **active file's language id** as reported by VS Code.
- The **cursor position** (1-indexed line and column).
- The **selected text** of the active editor — only via VS Code's in-memory `document.getText(selection)` API, never by reading the file from disk.
- The **workspace folder path** as configured in VS Code.

That is the entire attack surface. Nothing else is touched.

## What the bridge CANNOT access

- The **internet**. There is no `fetch`, `axios`, `http`, `https`, `WebSocket`, `net`, `dgram`, or `dns` import in either extension. The OMP side runs inside an offline terminal; the VS Code side does not import any networking primitive.
- A **shell**. No `child_process`, `exec`, `execFile`, `spawn`, `fork`, or terminal API. Configuration is read from JSON files, nothing else.
- **Environment variables**. The OMP side never reads `process.env`; the VS Code side does not import `process`.
- **Home-directory secrets**. There is no code path that reads `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, or any other dot-folder. The only filesystem access is `<workspace>/.omp/ide-context.json` and its `.tmp` sibling.
- **Sensitive files inside the workspace**. The patterns below are blocked at the writer (selection is redacted) AND re-checked at the reader (defense in depth):
  - `.env`, `.env.*`
  - `*.pem`, `*.key`, `*.p12`, `*.pfx`
  - `id_rsa`, `id_ed25519`
  - `.git/**`, `.ssh/**`, `.aws/**`, `.gnupg/**`
  - `node_modules/**`
  - `credentials*`, `secrets*`
- **The body of the active file**. The bridge writes only the selection text. To get the rest of the file, the OMP model must use its built-in `read` tool, which has its own (audited) path-safety rules.
- **Multiple files at once**. There is exactly one selection per turn. There is no batch read.
- **Pre-fetched related files**. The bridge never follows imports, references, or symbol lookups.

## Data flow

```text
VS Code (in-memory editor state)
  │
  ▼
serialized JSON, no other channels
  │
  ▼
<workspace>/.omp/ide-context.json  (atomic write: tmp + rename)
  │
  ▼
OMP extension reads the file
  │
  ▼
validates schema + path + freshness + size
  │
  ▼
builds <ide_context trust="untrusted"> block, XML-escapes every byte,
sanitizes the language attribute
  │
  ▼
prepends to user prompt
```

There is **no third party** in this flow. No relay server, no analytics, no telemetry, no auto-update check.

## Prompt-injection protection

The bridge treats **all source code, file paths, and language ids as untrusted data**. Specifically:

1. The opening tag is `<ide_context trust="untrusted">`. Downstream consumers cannot mistake the block for a system instruction.
2. The block has explicit sub-tags `<active_file>`, `<selected_code>`, `<cursor>`, `<language>`. The boundary hint outside the block tells the model the block is untrusted data, not instructions, and that source comments cannot override OMP policies (mục 38).
3. Every byte inside `<active_file>`, `<selected_code>`, and `<cursor>` is XML-escaped. A snippet like `</ide_context> evil` becomes `&lt;/ide_context&gt; evil` and cannot break out of the block.
4. The `language` attribute on `<selected_code>` is sanitized to `[a-z0-9_+\-]+` so a malicious language id like `vue" onerror="evil` cannot break out of the attribute.
5. The selection text is truncated to a configurable cap (`maxSelectionChars`, default 20 000) before injection.
6. The block sits **before** the user's prompt, so the user's instructions always come last and are not displaced.

The model is the only thing that decides what to do with the block. The OMP extension does not interpret commands that may appear inside source code.

## Path-safety guarantees (mục 28)

- The bridge accepts only paths that resolve (after `realpath`, following symlinks) to a child of the current workspace root.
- It rejects `..` traversal, absolute paths outside the workspace, symlink escapes, NUL bytes, and paths longer than `MAX_PATH_CHARS = 4096`.
- The state file path itself is validated on every read.
- The `workspace` field in the state file is checked against the current cwd via realpath; the file is rejected if they differ. String-prefix siblings such as `/project-other` are NOT treated as children of `/project`.
- The active file path is also validated, even though the bridge does not read its contents from disk.

## Configuration safety

- The configuration file is read with a hard 4 KiB cap; anything larger is dropped and the defaults are used.
- Configuration is parsed by `JSON.parse` only. There is no `eval`, no `new Function`, no dynamic import.
- All config keys are individually type-checked. An unknown key is ignored. A wrongly-typed key falls back to the default.

## Workspace Trust (mục 34)

The writer checks `vscode.workspace.isTrusted` before producing a state file. When the workspace is untrusted:

- The writer deletes any existing state file (best effort).
- The OMP side sees a missing file and skips injection.
- The user sees a status bar message in VS Code explaining that the workspace is untrusted.

When the user grants trust, the `onDidGrantWorkspaceTrust` listener re-captures so the file is produced immediately.

## Multi-root workspace safety (mục 35)

`vscode.workspace.getWorkspaceFolder(document.uri)` is the single source of truth for the boundary of each active document. The writer never assumes the first workspace folder owns every active document; the active document's folder is the boundary. The state file is written under that specific folder. The OMP reader compares the writer's `workspace` field to its own cwd; multi-root configurations where OMP is launched in a different folder than the active document's folder are rejected.

## TOCTOU protection (mục 36)

Source text comes from VS Code's in-memory selection, captured once. The state file is read once per turn and validated in the same call. There is no second-stage source-file read that could race a filesystem change. The atomic write (tmp + rename) means a reader never sees a half-written file.

## Telemetry

There is none. No usage counters, no machine IDs, no anonymous identifiers, no analytics, no crash reporting, no external update check. The extensions do not import any package that would do those things; both `package.json` files list only the official OMP package, the official `@types/vscode`, and dev tooling.

## How to verify

Every claim above is verifiable. From the repository root:

```bash
# 1. No network primitives in either extension
grep -rE "fetch\(|axios|require\(['\"]http|require\(['\"]https|WebSocket|require\(['\"]net" omp-extension/src vscode-extension/src

# 2. No shell primitives
grep -rE "child_process|exec\(|spawn\(|fork\(|require\(['\"]vm" omp-extension/src vscode-extension/src

# 3. No dynamic code evaluation
grep -rE "\beval\(|new Function" omp-extension/src vscode-extension/src

# 4. No process.env reads in the OMP extension
grep -rE "process\.env" omp-extension/src

# 5. No reads of the active file from disk
grep -rE "readFile|writeFile" vscode-extension/src
# expect: only fs.rename / fs.unlink / fs.mkdir / fs.writeFile in context-writer.ts
# expect: no readFile call anywhere

# 6. Workspace trust gate is wired
grep -rE "isTrusted|onDidGrantWorkspaceTrust" vscode-extension/src
```

Each grep above returns the matching lines with a one-line comment. If any command surfaces a new primitive, that is a regression and must be reviewed before merging.

## Worst capability

The single most dangerous capability the implementation has today is: **it can read text that the user has currently selected in VS Code, even if that text comes from a file with a non-sensitive path that contains secret-shaped strings (a private key pasted into a `.txt` file, for example)**.

Mitigations:

- The selection is capped at 20 000 characters by default.
- The block is wrapped in `<selected_code>` inside a `<ide_context trust="untrusted">` block and the model is told it is data, not instructions.
- The block is XML-escaped so it cannot break out of the prompt structure.
- The `language` attribute is sanitized so a malicious id cannot break out of the attribute either.
- The user can disable the bridge per-session with `/ide-context-clear` or per-workspace with `.omp/ide-context.config.json#enabled = false`.

If a user has secret-shaped data in a non-sensitive file, the responsible thing is to keep it out of the selection range or to disable the bridge. There is no way to detect this in code without a full content classifier, which is out of scope.

## Final verdict

> **`SAFE TO TEST LOCALLY`**

All mandatory acceptance criteria in mục 39 are satisfied:

- [x] No external network code exists.
- [x] No network listener is opened.
- [x] No telemetry exists.
- [x] No shell/process execution exists.
- [x] No install lifecycle hooks execute code automatically.
- [x] The bridge does not recursively scan the repository.
- [x] The bridge does not automatically read active source files from disk.
- [x] Only active-file metadata and explicit selection are synchronized.
- [x] Sensitive files are blocked (writer + reader re-check).
- [x] Out-of-workspace files are blocked (soft-block with `outside-workspace` reason).
- [x] Canonical path checks prevent traversal and symlink escape.
- [x] Context JSON is strictly validated with a closed set of `BlockReason` values.
- [x] Context size is bounded (`MAX_CONTEXT_FILE_BYTES = 100_000`, plus per-field caps).
- [x] Selected code is never written to logs.
- [x] Stale selections are not injected.
- [x] Duplicate unchanged context is not repeatedly injected (fingerprint gate).
- [x] VS Code Workspace Trust is respected.
- [x] Multi-root workspaces are handled safely.
- [x] IDE context is treated as untrusted data (`<ide_context trust="untrusted">`).
- [x] Tests cover all security boundaries (65 tests across 6 files).
- [x] `SECURITY.md` accurately describes actual implementation behavior.

This verdict is **not** a guarantee of absolute security. Source code provided to OMP through this bridge is still subject to whatever transmission the user has configured OMP to perform with the model provider. The bridge does not weaken that — it only augments the prompt. Disable the bridge, delete the state files, or set `enabled: false` in `.omp/ide-context.config.json` if you do not want IDE state in your prompts.

## Reporting issues

Open a private issue in this repository. Do not include secret-shaped strings in the report; use a synthetic example instead.
