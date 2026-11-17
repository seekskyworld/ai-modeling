# Contributor instructions

- Read `README.md`, `docs/development.md` and the relevant command and compatibility notes before changing behavior.
- Keep this repository independent of neighboring projects and machine-specific paths.
- Preserve the dependency direction `mcp/` → `cli/` → `studio/`. MCP invokes the packaged CLI; it does not access credentials or Studio business services directly.
- Use `@seekskyworld/ai-modeling` for the npm package, `ai-modeling` for the sole executable and Skill, `ai-modeling mcp` for MCP, `AI_MODELING_*` for configuration, and `ai_modeling_*` / `ai-modeling://` for tools and resources. Do not add aliases or fallback state for previous project names. Preserve Tripo provider domains, model IDs and third-party attribution.
- Keep CLI capabilities composable and use it as the underlying execution interface. MCP exposes tools that invoke the CLI internally; an agent choosing MCP must use MCP tools without switching to shell CLI. Skills provide instructions, examples and workflow guidance for the selected entry point, without a separate engine or fixed business workflow.
- Prefer verified Studio endpoints. Local equivalents are appropriate for behavior performed by the webpage frontend; identify these explicitly. Do not silently switch to the developer API wallet or another model provider.
- Match the official CLI command structure where practical, then add Studio extensions using the same conventions. Document semantic differences and unsupported combinations in `docs/compatibility.md`.
- Trace the complete request chain, including upload, authorization, preparation, submission and result retrieval. Similar field names or a successful response alone do not prove equivalent effects.
- Keep credentials in the operating system credential store. Never include sessions, signed URLs, account identifiers, private paths or account reports in public documentation, fixtures or logs.
- Preserve request identity and account binding. An expired lock or missing response is not evidence that a remote submission did not execute. Do not automatically resubmit an unknown write.
- Keep migrations, task state, cached artifact identity and idempotency updates transactional. Validate downloaded bytes and avoid overwriting unrelated files.
- Run checks appropriate to the change. Documentation changes require valid links, accurate examples and a clean package inventory; they do not require unrelated live generation.
- Live tests require the operator's authorization and credit budget. Distinguish offline checks, live requests, output validation and website comparisons in reports.
- Keep public documentation focused on usage, architecture and current limitations. Store local investigation notes, screenshots, raw responses and historical reports under ignored `artifacts/`.
- Retain third-party license notices. Do not bundle upstream application assets or conversion runtimes without appropriate distribution rights.
- Preserve concurrent contributors' changes. Update the relevant documentation with behavior changes; do not rewrite unrelated work.
