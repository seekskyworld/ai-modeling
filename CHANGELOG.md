# Changelog

This file records user-facing changes. Unreleased changes describe the source tree and do not imply an npm or hosted release. Run `ai-modeling --version` or read `package.json` for the current version.

## Unreleased

### Added

- A version-tag npm release workflow using GitHub OIDC Trusted Publishing, Node.js 24 and npm 11.17.0. Manual dispatch previews checks without publishing; new submissions require the same standard-export archive to pass the Linux, macOS and Windows installation gates.
- Durable archive identity and submission records that preserve accepted or unknown uploads across workflow retries. Publication verification downloads the exact public npm tarball and compares its bytes and registry digests with the frozen archive; legacy processing submissions reuse their original receipt and archive.

### Fixed

- Retry private login-state reads when a concurrent login worker atomically replaces the file, while retaining ownership, permission, link and bounded-size checks.

These source changes do not republish 0.1.3 or establish that npm Trusted Publisher configuration, OIDC uploads or native Windows validation have already completed.

## 0.1.3 — 2026-11-17

### Changed

- Store Studio sessions, private artifact links, upload references and optional LLM keys in private local JSON records, shared by the same OS user/profile independently of business data directories. System keychains and Linux Secret Service are no longer required. Existing keychain entries are not automatically read, migrated or deleted; use the normal browser login flow to create a JSON session after upgrading.
- Protect credential directories/files with POSIX `0700/0600` permissions or Windows current-user/SYSTEM ACLs, preserving account binding, atomic updates, compare-and-save, cancellation and original request identities. Windows implementation and configuration support do not constitute a completed Windows runtime or browser acceptance test.
- Use `%LOCALAPPDATA%/ai-modeling` for Windows business data, falling back to the OS home `AppData/Local/ai-modeling`. Existing installations can explicitly select their original data directory with `AI_MODELING_DATA_DIR` to retain tasks and settings; the private credential root is unchanged by this setting.
- Document Windows npm/MCP launch differences and provide an optional `cmd.exe` / `npx.cmd` configuration for hosts that cannot directly launch npm shims.

### Fixed

- Keep a live login lock valid during bounded synchronous credential checks, preventing a late login from restoring a session after logout. Contention reports a retryable credential-store busy error without changing the original login or request.
- Resolve relative credential-import file paths before Windows ACL validation. Upgrade legacy application-owned authentication control ACLs after ownership and identity checks, preserving login and cancellation state; credential records and external import files remain validation-only.

## 0.1.2 — 2026-11-17

### Fixed

- Distinguish a completed browser login flow from a currently verified Studio session in authentication status. Reading an MCP login-status resource remains a local operation and does not imply that the OS credential store is accessible.
- Bind login recovery guidance to the returned login ID and preserve the original task identity when current credential access fails.
- Include explicit image-size and model-parameter examples in the published first-use documentation.

## 0.1.1 — 2026-11-17

### Fixed

- Correct global npm installations by allowing npm to install native entry packages with their platform dependencies. Local npm and npx success no longer substitutes for a real global-install smoke check.
- Defer Sharp loading until image processing is needed, so version/help, Skill management and static MCP discovery can start independently of the image-processing native module.
- Update npm/npx and MCP examples to the 0.1.1 patch version and document separate global-install validation and credential-store recovery.

## 0.1.0 — 2026-11-17 (prerelease)

The initial GitHub prerelease has a known global-install native-dependency defect. Use the patched release; successful archive/local-npm checks did not establish a working global npm installation.

- Golutra Agent project Skill target and native MCP plugin export, with reviewed schemas split to 64 tools per package. Export reports the verified 0.3.9 host limitation that prevents MCP tools from reaching the model; registration alone is not working MCP execution.

### Added

- Version-pinned npm and npx onboarding for `@seekskyworld/ai-modeling`, with separate complete Skill and MCP setup paths, client reload checks, and default-toolset browser login recovery.
- Standalone image generation/editing in the default MCP toolset, sharing the complete Studio image schema and CLI execution. New image requests default to GPT Image 2.5 across CLI, MCP and Skill examples. Existing jobs retain their recorded model and conflicting request reuse is rejected.
- Local Skill installation management through `ai-modeling skill targets/install/status/uninstall`, with explicit client or custom-directory selection, user/project scopes, and preservation of modified or unmanaged files. No client is selected implicitly. The runtime package still includes its guidance and the standalone Skill ZIP remains available.
- Native MCP configuration examples for Codex and VS Code editor compatibility, alongside the portable `mcpServers` example for clients such as Claude Code, Cursor and current VS Code Copilot.
- `ai-modeling assets list` exposes account model/image inventory, including website-created assets, with bounded pagination and safe summaries shared with the structured asset-list tool.
- Separate npm consumer smoke checks and release-candidate evidence for archive installation/execution, with dependency drift reported independently from the locked installation checks. No npm package is published by these checks.
- Read-only public npm version and archive-integrity checks through `package:registry-check`, with optional post-publication existence enforcement and no registry credentials or publication.
- Apache-2.0 project licensing with retained third-party notices.
- Public installation, configuration, troubleshooting and contributor guides; an English README and reusable CLI/MCP examples.
- Community standards, support and security reporting guidance, issue forms and a pull request template.
- Local documentation and package-content checks, plus CI and a manual package-validation workflow.
- A standalone ai-modeling Skill and a shared export command for Skill ZIPs and CLI/MCP installation packages, with installation instructions, MCP configuration and SHA-256 checksums.
- Reviewed portable production dependencies bundled in runtime exports, with exact-version optional platform packages, production shrinkwrap and source/lock/toolchain provenance. Real TGZ and npm consumer installation checks compare functionality and dependency integrity on three platforms.
- Offline release readiness checks for confirmed repository/contact metadata, source identity and bundled pricing lifetime; missing information remains an explicit blocker.
- Guided setup, feature-specific offline diagnostics and reviewed price verification/import/update commands; price expiry is never silently extended.
- A public, versionable price snapshot shared with the runtime, with current Studio price evidence and credential-free source verification.
- Focused command-guide resources, offline tool discovery and bilingual installation/recovery/capability guidance.

### Changed

- The npm package is `@seekskyworld/ai-modeling`; the executable remains `ai-modeling`. MCP starts with `ai-modeling mcp` and the six-tool default set, with `--toolset studio` for asset/editing extensions. Runtime archives use `ai-modeling-VERSION.tgz`.
- Configuration uses `AI_MODELING_*`, directory context uses `.ai-modeling`, tools use `ai_modeling_*`, and authentication status uses `ai-modeling://auth/status`. State and credentials use this namespace without legacy aliases or fallback. The npm scope does not change the CLI name or invalidate a saved session.
- CLI is the execution interface. MCP provides agent-facing tools that invoke it internally, while Skills provide instructions, examples and workflow guidance for the selected entry point.
- Public documentation separates supported functionality from incomplete or unverified Studio mappings.
- Internal investigation reports, local account fixtures, caches and generated packages are excluded from the public source tree.
- The bundled batch example uses `batch run` and distinguishes per-request planning from actual batch execution.
- CLI and MCP versions now read the single package metadata source; version checks detect lockfile drift.

### Fixed

- Bound OS credential-store operations to 10 seconds in isolated helper processes. On permission or availability errors, report `CREDENTIAL_STORE_UNAVAILABLE` with instructions to unlock/authorize the OS store; keep unknown write outcomes and existing login/request identities.

### Included capabilities

The initial version includes visible browser login, shared profile-level login state, safe CLI continuation and MCP authentication status. Creative operations remain subject to the [current compatibility limits](docs/compatibility.md).

A release maintainer should move the relevant entries into a dated version section when a release is actually published. See [release preparation](docs/development.md).
