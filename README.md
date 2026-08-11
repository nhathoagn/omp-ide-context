# omp-safe-ide-context

A small, security-focused bridge that lets the [Oh My Pi](https://ohmy.pi) agent see the file and selection you have open in VS Code — automatically, before every prompt. No `@file`, no copy/paste, no manual `/ide` command. The bridge is local-only; the OMP agent may still transmit the resulting context to the model provider you have configured.

```text
VS Code (active editor, cursor, selection)
  │  (atomic write, in-memory editor APIs only)
  ▼
<workspace>/.omp/ide-context.json
  │  (schema-validated, canonical-path checked, size-bounded)
  ▼
OMP extension
  │  (auto-injected as <ide_context trust="untrusted"> before each prompt)
  ▼
Model
```

The opening tag of the injected block is always `<ide_context trust="untrusted">`, every byte of source content is XML-escaped, and the boundary hint outside the block tells the model the contents are data — not instructions. The full threat model, the worst capability, and the verdict are in [`SECURITY.md`](./SECURITY.md).

## What it does

1. The VS Code extension watches the active editor and writes the active file path, cursor position, and current text selection to `<workspace>/.omp/ide-context.json` whenever any of them changes.
2. The OMP extension reads that file before each user turn and prepends an `<ide_context trust="untrusted">…</ide_context>` block to the prompt.
3. You type "refactor this" or "fix that bug" and the model already knows what you mean.

## What it does NOT do

This project is intentionally narrow. It is **not** a generic IDE bridge, it does not sync your editor over the network, and it does not run shell commands.

- The bridge **never** reads the active file's body from disk. Source content comes from VS Code's in-memory `document.getText(selection)` only.
- The bridge **never** opens a socket or calls `fetch`. The data flow is one-directional, local, and file-based.
- The bridge **never** executes commands, including from `ide-context.json`. The `workspace` field is verified against the OMP cwd, never trusted.
- The bridge **never** reads `~/.ssh`, `~/.aws`, `~/.gnupg`, `.env`, `*.pem`, or any other sensitive location. Selections from sensitive files are redacted at the writer.
- The bridge **respects** VS Code Workspace Trust. When the workspace is untrusted, no state file is produced.
- The bridge **does not** follow imports, references, or symbol lookups. There is no pre-fetching of "related" files.

## Installation

### One-command install

After a GitHub Release has been published, install the latest version on macOS or Linux with:

```bash
curl -fsSL https://raw.githubusercontent.com/nhathoagn/omp-ide-context/main/install.sh | bash
```

The installer downloads the latest release archive, installs the bundled VS Code extension, and links the OMP extension into `~/.omp/agent/extensions/`. It requires the VS Code `code` command to be available in `PATH`. Restart OMP afterwards; its status line should show `IDE:ready`.

For an auditable installation, download `omp-ide-context.tar.gz` from the [latest GitHub Release](https://github.com/nhathoagn/omp-ide-context/releases/latest), inspect it, extract it, then run:

```bash
./install.sh --archive ./omp-ide-context.tar.gz
```

### Development install

```bash
# From the project root
bun install
(cd omp-extension && bun run typecheck)

# Option A — symlink into the user agent directory
ln -s "$(pwd)/omp-extension" ~/.omp/agent/extensions/omp-safe-ide-context

# Option B — point settings at it
#   Add to ~/.omp/agent/config.yml:
#   extensions:
#     - /absolute/path/to/omp-extension

# Build and install the VS Code extension
(cd vscode-extension && bun run build)
(cd vscode-extension && ./node_modules/.bin/vsce package)
code --install-extension vscode-extension/omp-ide-context-vscode-0.1.0.vsix
```

### 3. Git ignore

Add to `<workspace>/.gitignore` (one-time per project, not done automatically):

```gitignore
.omp/ide-context.json
.omp/ide-context.tmp
.omp/ide-context.config.json
```

## Usage

1. Open a file in VS Code. Highlight some code.
2. Type a prompt in OMP, for example: `Refactor this logic to use composition over inheritance.`
3. The model receives the active file path, language, cursor position, and the selected text automatically.

### Slash commands (OMP)

| Command | Effect |
|---|---|
| `/ide-context-status` | Show the runtime state, config, last fingerprint, last status reason, and the absolute state file path. |
| `/ide-context-reload` | Manual reload. The bridge auto-reloads on config/state-file change (see below); the slash command is the manual fallback. |
| `/ide-context-show`   | Open the `<ide_context>` block that would be injected, in a read-only editor. |
| `/ide-context-clear`  | Disable injection for the rest of the session. Re-enable by restarting OMP. |

### VS Code commands

| Command | Effect |
|---|---|
| `OMP IDE Context: Show Current Context` | Open `.omp/ide-context.json` in a side editor, or report the block reason. |
| `OMP IDE Context: Enable` | Resume writing the state file. Warns if the workspace is untrusted. |
| `OMP IDE Context: Disable` | Stop writing and delete the state file for the current workspace. |

### Blocked reasons

The bridge can produce a "blocked" state file instead of a full context. The OMP side surfaces the reason in the status line and in the prompt as a short note.

| `reason` in the state file | When the writer emits it | What the model sees |
|---|---|---|
| `outside-workspace` | The active document is not inside any VS Code workspace folder. | The OMP reader detects the OOW file path and converts it to a soft-block. |
| `untrusted-workspace` | `vscode.workspace.isTrusted` is `false`. | No state file is produced; the OMP reader sees a missing file. |
| `sensitive-file` | The active file matches a sensitive pattern (`.env`, `*.pem`, …). | Selection is redacted; file metadata is preserved. |
| `untitled` | The active document is a new unsaved buffer. | No state file content; only metadata. |

## Configuration

The OMP extension reads `<workspace>/.omp/ide-context.config.json` if present, otherwise falls back to defaults. The file is small (< 4 KiB) and validated defensively. Edit the file and run `/ide-context-reload` in OMP to pick up changes without restarting.

```json
{
  "enabled": true,
  "includeSelection": true,
  "maxSelectionChars": 20000,
  "staleAfterMs": 600000
}
```

| Key | Default | Effect |
|---|---|---|
| `enabled` | `true` | Master switch. `false` skips injection for the whole session. |
| `includeSelection` | `true` | When `false`, the model sees only the file path and cursor; selection text is replaced with a placeholder. |
| `maxSelectionChars` | `20000` | Cap on selection text. Larger selections are truncated. The hard trust-boundary cap is `MAX_CONTEXT_FILE_BYTES = 100000` regardless of this value. |
| `staleAfterMs` | `30000` (recommend `600000`) | If the state file is older than this, the selection is dropped (active file metadata is kept). The default of 30 s is too tight for long prompts — most users want 5–10 minutes so the selection survives typing and agent streaming. |

## Why does the status line say `(stale)` when I just highlighted?

The state file carries an `updatedAt` timestamp. The OMP reader drops the selection when that timestamp is older than `staleAfterMs` (default 30 s). If you highlight, type a long prompt, and the agent streams for a couple of minutes, the read may land after the threshold. Three ways to fix:

- Re-highlight any text in the editor right before sending the prompt — the writer re-stamps `updatedAt`.
- Set `staleAfterMs` in `.omp/ide-context.config.json` to a longer window (10 minutes is recommended for normal use).
- The bridge watches `.omp/ide-context.config.json` automatically; the pick-up happens within ~50 ms. You can also type `/ide-context-reload` as a manual fallback. The state file is refreshed on every VS Code selection change.

The status line shows `IDE:…/path/to/file.vue (stale)` so you can tell at a glance whether the selection is being passed through to the model or only the file metadata.

## Auto-reload

The OMP extension watches `<workspace>/.omp/` for file changes:

- When `ide-context.config.json` is edited, the bridge re-reads it and re-applies the new config. The status line updates within ~50 ms and a notification summarises what changed.
- When `ide-context.json` is rewritten by the VS Code extension (selection, cursor, or active file change), the bridge refreshes the cached `lastContext` so the status line tracks the IDE state in real time. Selection-change notifications show only the selected line range; the status line retains the file path to avoid duplicate, visually noisy context.

If the watcher fails to start (rare, e.g. on a read-only filesystem), the bridge still works through `/ide-context-reload` and the per-turn `input` read. The status line will report `watcher=off` via `/ide-context-status`. so you can tell at a glance whether the selection is being passed through to the model or only the file metadata.

## How to inspect `.omp/ide-context.json`

Open it in VS Code (any file path will do — the bridge writes one file per workspace folder). A full context looks like:

```json
{
  "version": 1,
  "updatedAt": 1786380000000,
  "workspace": "/Users/me/project",
  "file": "src/components/UserForm.vue",
  "language": "vue",
  "cursor": { "line": 82, "column": 14 },
  "selection": { "startLine": 75, "endLine": 92, "text": "..." }
}
```

A blocked context looks like:

```json
{
  "version": 1,
  "updatedAt": 1786380000000,
  "workspace": "/Users/me/project",
  "blocked": true,
  "reason": "sensitive-file",
  "truncated": false
}
```

The OMP side rejects the file if `version` is not `1`, if any required field is missing, if the workspace does not match the current cwd (canonical-path check), if the active file path escapes the workspace, if the state file is over 100 KiB, or if any string exceeds its per-field cap. The check is fast and fail-closed.

## Workspace Trust

If VS Code is showing the "Restricted Mode" banner in the workspace, the writer refuses to produce a state file. Grant trust (Command Palette → "Manage Workspace Trust") and the writer resumes on the next selection change. The companion OMP session will see the new file on its next turn.

## Development

```bash
bun install
bun test
bun run typecheck:omp
bun run typecheck:vscode
```

Both extensions are plain TypeScript. OMP loads `src/index.ts` directly through Bun; VS Code loads the compiled output under `vscode-extension/out/`.

## Publishing a release

The release workflow publishes `dist/omp-ide-context.tar.gz` when a `v*` tag is pushed:

```bash
bun run release:build
git tag v0.1.0
git push origin v0.1.0
```

The archive contains the OMP extension and a prebuilt VSIX. Do not include `.omp/ide-context*.json`; those workspace-local files can contain editor selection content.

## How to uninstall

```bash
# 1. Remove the OMP extension symlink
rm ~/.omp/agent/extensions/omp-safe-ide-context

# 2. Remove the VS Code extension
code --uninstall-extension omp-safe-ide-context.omp-ide-context-vscode

# 3. Remove the state files from any project that has them
find ~/projects -path '*/.omp/ide-context.json' -delete
find ~/projects -path '*/.omp/ide-context.tmp' -delete
```

## License

MIT.
