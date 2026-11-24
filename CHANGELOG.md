# Changelog

This file records user-facing changes. Unreleased changes describe the source tree and do not imply an npm or hosted release. Run `ai-modeling --version` or read `package.json` for the current version.

## Unreleased

## 0.1.6 — 2026-11-25

### Added

- Live Canvas validation completed native Smart Low Poly plus Smart UV in one Retopology node and one step, preserving the existing graph. The textured model reduced from about 1.98 million faces to 1,106, with usable UVs, baked textures, webpage views and an exact 35-credit charge. This is a limited default-engine result, not an exact 1,000-face or material-preservation guarantee.
- Read-only `canvas session-history` compares two session/turn-detail snapshots, explicitly requests all six turn states, and detects message, identity, order and completeness hints. Three live sessions with 59 messages and 15 turns matched; stable reads do not prove server-side history completeness.
- Refresh the reviewed pricing source from current webpage evidence: 43 constants, five verified derived numeric prices and three explicitly unquoted operations. Import, modification and retexture application require a valid unquoted declaration plus explicit variable-cost consent, with numeric budgets omitted. Unknown cost is never reported as zero; older published snapshots are unchanged.
- Validate Studio Free Retry separately from HolyMolly node Retry: an eligible project completed submission, generation, original inspection and webpage loading. The output did not strictly satisfy its prompt, and missing exact billing remains unknown.

- Read-only `canvas turn-stop-plan` composes the webpage Agent cancellation sequence using exact turn/run ownership, bounded discovery and stable snapshots. It requires confirmed turn cancellation before preparing active run stops, preserves unknown writes and separates cancellation from natural completion. Live webpage cancellation reached STOPPED; a separate CLI cancellation also reached CANCELLED with its exact run stopped, requiring no redundant stop request.
- Canvas audits now verify complete one-to-one multi-node runs; a live two-image chat run passed exact output attribution. Textured HD originals require matching task IDs in both their directory and exact filename. Exact `currentStepId` now resolves repeated-node steps when complete run coverage and unique task identities hold. Internal split outputs without a proven original-file mapping and unbound Canvas runs still retain unknown generation attribution.
- A live non-indexed fixture completed file import, UV generation/application and native Meshopt compression, with decoded geometry/UV inspection and webpage model/layout checks. The final file preserves the applied UV geometry within the documented quantization bound. The initial import still fails the stricter original-attribute normalization proof, and Blender 4.5.16 requires a separate decoded copy for Meshopt input; neither limitation is hidden.
- Live card checks cover plan confirmation, detected-part renaming, candidate selection through textured HD generation, original inspection and webpage views, and the HolyMolly recommendation selection protocol. The recommendation sample ended without HTML delivery; successful continuation does not imply successful generation.

- Canvas audits separate run ownership, current selection and generated-output provenance. Supported image, HD-model, texture and HolyMolly originals must match exact task/step identities; selecting an old output does not attribute it to the current run. Run reads join both snapshots, while node credit ownership stays separate from account-ledger verification and settlement.
- Live checks cover grouped Other/per-question Skip, selection confirmation, confirmation gates before model generation and texturing, original-file inspection and webpage comparison. Session creation documents its actual default/active-session switch and retained archived history; confirmation-card guidance distinguishes its arguments from selection cards.
- Read-only Canvas acceptance audits bind the exact conversation to its Canvas, check node and asset expectations, and verify a stable read snapshot. They do not approve workflow review nodes or infer that current assets were created by the last message.
- Local artifact inspection decodes image/model content and reports file identity, geometry, textures and animation evidence with optional machine-checkable expectations. Visual and semantic acceptance remains an explicit Agent responsibility.
- Canvas chat task results now retain acceptance follow-up guidance after remote completion, shared through CLI, MCP and the progressive Skill workflow.
- Canvas graph editing imports `canvas get` output directly, supports explicit identity/revision guards and patches selected parameter keys without replacing the rest. Undo/redo retains the original graph identity.
- Live Canvas tool discovery reports CLI graph and execution mappings, retired definitions and unmapped capabilities. HolyMolly uses explicit Agent capabilities and verified attachment preparation; its graph supports HTML-to-HTML/Lab connections.
- Live HolyMolly checks verified original attachment bytes, HTML download, in-Canvas Play, keyboard movement, collection, victory and restart. Targeted changes preserved the original node and delivered new version nodes with the requested appearance, win threshold and Space pause/resume behavior; later revisions added a Pause/Resume button and P shortcut, verified using player position changes and original dependencies. Restarting while paused also restored the zero-score state. Acceptance follows the exact turn/run/new-node/asset chain. Successful stopping and eligible native node Retry remain unverified, and a settled revision does not settle other pending generation charges.
- HolyMolly audits expose HTML candidates, game preview diagnostics and separate credit status. Confirmation cards retain game recommendations; historical game retries with no verifiable target remain blocked. Core documentation is consolidated into five maintained guides.

- Saved HolyMolly node stop/retry operations preserve a durable request, exact source run and revision guards. Stop confirmation is separate from turn completion; retry requires variable billing consent. Unknown receipts are retained without replay or unproven turn reconciliation. A live accepted stop ending in FAILED remains unconfirmed; native node Retry has no eligible live success example.

### Fixed

- Serialize login revocation monitoring so slow native permission checks do not accumulate overlapping reads. Cancellation remains observable and closing the broker prevents new polls.
- Preserve concurrent readers when replacing private Windows credentials and login state. If ordinary rename is blocked, use one same-directory native replacement after rechecking file identity and private ACLs. Uncertain replacements retain protected temporary records for inspection and are never automatically retried.
- Explicitly load the system JSON module during Windows credential ACL checks, retaining the controlled environment, permission validation and timeouts. Native installation and publication outcomes are recorded with the corresponding Release; this change alone does not establish successful Windows or browser acceptance.
- Recheck reviewed fixed-price expiry immediately before a new remote write, after preparation or authentication delays. Already submitted and unknown receipts remain recoverable without replay.
- Preserve valid webpage-generated graph connections with an empty source port when the source has exactly one output. Keep original graph JSON, Lab selection requirements and ambiguous-output rejection; a real saved graph passed local editing and remote save/readback without changing existing nodes or edges.
- Expose unquoted-operation consent on applicable full MCP tools and on the default model-file import entry. Default model imports no longer inherit the unrelated PBR generation flag; later processing steps require their own explicit consent.
- Preserve unquoted-operation consent across native CLI tools and multi-step processing, preflight the complete new chain before uploads or billable work, and recheck each new submission. Existing submitted/unknown receipts are recovered without replay.
- Recognize the current numeric plan-card alias and retain exact current-step attribution while keeping selected-output association separate from generation provenance.

- `anim retarget` with the default JPEG export no longer fails with `IDEMPOTENCY_CONFLICT` before export submission. Animations created earlier in the chain are now merged into the export parameters before the JPEG intent is frozen, so the pre-submit check compares the same intent. A live Studio run exported one GLB with both requested preset motions and verified JPEG textures.
- Studio uploads scale their per-request timeout with the body size (60 seconds plus the transfer time at 32 KiB/s, capped at 10 minutes), allowing more time for 10 MiB parts and large reference images on slower or proxied connections.
- Expired or future-dated pricing reviews report when the review expired, or that it is future-dated, and the recovery commands, instead of a generic message.

- Classify HolyMolly HTML candidates by the download URL path suffix first, falling back to the filename only when that path has no suffix. Extensionless display names no longer hide HTML outputs; classification still requires separate content and gameplay checks.
- Reject manually supplied Turn/Lab IDs for uncertain Canvas creative submissions with `RECONCILE_UNVERIFIABLE`. An existing remote result does not prove request ownership; preserve the original unknown job without replay or guessed receipt binding.
- Serialize JobStore schema initialization and migration after acquiring the database write lock, with bounded retries for WAL setup contention. Concurrent CLI/MCP startup no longer races partially initialized schemas; this does not retry remote submissions.
- Accept verified HolyMolly Stop receipts containing the exact original run ID and `status:accepted`, preserving their identity separately from turn receipts. Poll the original node execution and retain stop-request timing as evidence; a DONE or FAILED result remains `STOP_NOT_CONFIRMED`, even after a stopping event. Previously unknown submissions are not rebound or replayed.
- Recover a failed HolyMolly message's target only from the service's explicit `cardJson.targetNodeId` and matching capability, verifying the saved Canvas node and read snapshot. A live FAILED-message retry completed a new turn, run, node and HTML output with verified original download, attachment bytes, dependency loading, movement, collection threshold, pause/resume and restart. Missing targets remain blocked; callers cannot override historical identity. Accept `turnRefs:null` as no ordinary references without inferring a target from attachments; historical retries remain separate from native node Retry.
- Validate Lab instruction save states before reuse while preserving the service response and Copy/Reuse guidance. Current webpage instructions are saved by the service; a Canvas snapshot is not a separate manual instruction-save API.
- Preserve supported Agent card titles, option descriptions, plan groups and requirements for review; displayed cost ranges remain separate from executable pricing and consent.
- Recheck the durable submission claim after Canvas turn, answer, Lab and graph-run preparation/authentication, immediately before the write.

- New Canvas chat submissions validate standalone and mixed attachment identity/readiness; continuations require a turn waiting for user input. Run preparation verifies the exact Canvas and unique Lab outputs, while Lab reuse rejects explicitly unavailable selected assets. Submitted jobs query their original receipts; uncertain creative submissions remain unbound without resubmission.

## 0.1.5 — Unpublished candidate

The `v0.1.5` tag is retained as a failed release candidate. Windows installation validation failed before publication; no npm upload or GitHub Release was created. Its changes are carried forward to 0.1.6.

## 0.1.4 — 2026-11-17

### Added

- Verified publication notes include the pricing JSON's immutable source URL, original-file SHA-256, review/expiry dates and a copyable update command. The generator compares the original source with the frozen runtime and rejects missing or mismatched publication evidence; historical recovery preserves the original price validity.
- Cross-version channel reconciliation separates version-specific npm uploads from `latest`/`next` and GitHub Latest promotion. Surviving promotion jobs inspect durable published receipts for the whole backlog, verify original public archives, and only advance channels to higher semantic versions.
- Offline workflow-contract checks in `npm run check`, a separate checksum-verified actionlint job, and synthetic regression coverage for release ordering, coalesced pending jobs, unknown write results and recovery. Third-party Actions are pinned to full commit SHAs.
- A version-tag npm release workflow using GitHub OIDC Trusted Publishing, Node.js 24 and npm 11.17.0. Manual dispatch previews checks without publishing; new submissions require the same standard-export archive to pass the Linux, macOS and Windows installation gates.
- Durable archive identity and submission records that preserve accepted or unknown uploads across workflow retries. Publication verification downloads the exact public npm tarball and compares its bytes and registry digests with the frozen archive; legacy processing submissions reuse their original receipt and archive.

### Fixed

- Bound default test-file parallelism to reduce CLI/MCP startup contention on machines with many reported CPUs, while preserving test timeouts and explicit concurrency overrides.
- Retry private credential JSON reads after safe concurrent replacement or deletion. Repeated contention reports `CREDENTIAL_STORE_BUSY`; invalid ownership, links, permissions, size or content still fail, and reads never restore deleted credentials or replay writes. This is separate from the login-flow state-file fix below.
- Keep publication-note failures free of raw JSON, private file paths and subprocess diagnostics; compare the complete original pricing object before schema normalization so extra fields cannot hide a source/runtime difference.
- Retry private login-state reads when a concurrent login worker atomically replaces the file, while retaining ownership, permission, link and bounded-size checks.

Version 0.1.4 was published to npm. At that release, native Windows validation and the first GitHub OIDC upload had not been verified; npm availability alone did not establish those results. Refer to each subsequent Release for its own acceptance records. Existing 0.1.3 artifacts and version tags are unchanged.

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
