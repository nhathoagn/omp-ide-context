# Plan: Public release distribution

## Context
- Goal: distribute the OMP and VS Code extensions through one installer command.
- Scope: a GitHub Release archive, installer, and tag-triggered release workflow.
- Out of scope: publishing the VS Code extension to the Marketplace.

## Implementation

### Release packaging
- [x] Build the VS Code VSIX and package both extensions into one archive.
- [x] Exclude workspace state and development dependencies from the archive.

### Installation
- [x] Download the latest GitHub Release archive in an idempotent installer.
- [x] Verify required archive files before installing.
- [x] Link the OMP extension and install the VSIX with the VS Code CLI.

### Automation and documentation
- [x] Publish the archive when a `v*` tag is pushed.
- [x] Document the installation and release process.

### Windows distribution
- [ ] Add a PowerShell installer with the same archive validation and extension-link behavior.
- [ ] Bundle the PowerShell installer in each release archive.
- [ ] Run the public installer in an isolated Windows GitHub Actions job after release publication.

## Verification
- [x] Build the release archive locally.
- [x] Inspect archive contents.
- [x] Run the installer against the built archive with an isolated fake VS Code CLI.

## Risk
- The target GitHub repository currently has its own initial README. Publishing the plugin as the repository root requires an explicit choice to replace it or preserve it.
