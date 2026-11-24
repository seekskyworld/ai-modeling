/** 官方帮助模板与网页差异分开维护；选项出现不代表网页可执行该参数。 */
import type { Command } from 'commander';
import { helpContract } from './help-contract.ts';
const preserve = new Set([
  'login',
  'logout',
  'whoami',
  'use',
  'config',
  'config set',
  'doctor',
  'update',
  'docs',
  'topup',
  'mcp',
  'files upload',
]);
const differences: Record<string, string> = {
  'generate text-to-model':
    'P1/P2 texture=true runs bare generation then native texture; pbr=true adds PBR. Each step has separate website pricing and a resumable receipt. --no-wait requires texture=false. export_orientation adds a native Studio export after the complete generation chain.',
  'generate image-to-model':
    'P2 single-image face_limit starts at 500: the website rejects 100 even for bare geometry. P1/P2 texture=true runs bare generation then native texture; pbr=true adds PBR. Each step has separate website pricing and a resumable receipt. --no-wait requires texture=false. export_orientation adds a native Studio export after the complete generation chain.',
  'generate multiview-to-model':
    'P1/P2 texture=true runs bare generation then native texture; pbr=true adds PBR. Each step has separate website pricing and a resumable receipt. --no-wait requires texture=false. export_orientation adds a native Studio export after the complete generation chain.',
  'generate text-to-image':
    'Default image model: GPT Image 2.5 (gpt_image_2.5_sunburst). Banana supports five verified WxH sizes; Banana Pro supports 1024x1024, 1200x896, 896x1200, 1376x768, 768x1376 and 4096x4096. GPT Image 2 and 2.5 Sunburst support 1024x1024, 1536x1152, 1152x1536, 1792x1024 and 1024x1792 via native 1K resolution/ratio controls. Explicit WxH is frozen and checked against every original image, including --no-download; a mismatch preserves remote success as needs_attention without resizing or regeneration. Nano Banana 2K requests returned 1K and are rejected. Studio extension -p scale=auto omits the ratio without promising pixel dimensions; omitted scale retains 1:1. Sunburst background=opaque freezes a delivery requirement and verifies all original alpha values; it never fills a background or adds a processing task. Transparent/auto background and explicit GPT quality tiers remain unavailable. Seedream and unsupported image options are rejected.',
  'generate image-to-image':
    'Default image model: GPT Image 2.5 (gpt_image_2.5_sunburst). GPT Image 2 and 2.5 Sunburst accept 16 total ordered references; --edit-base assigns one primary plus at most 15 additional references. Exact WxH uses the same model-specific native resolution/ratio mappings as text-to-image and verifies every actual edit result without resizing; reference inputs do not waive the frozen pixel-size requirement. Nano Banana 2K requests returned 1K and are rejected. Studio extension -p scale=auto follows the webpage reference-image flow with no selected ratio; omitted scale retains 1:1. Sunburst background=opaque freezes a delivery requirement and verifies all original alpha values; it never fills a background or adds a processing task. Transparent/auto background and explicit GPT quality tiers remain unavailable. Seedream and unsupported image options are rejected.',
  'generate image-to-multiview':
    'Studio uses the website multiview engine; API model overrides are unavailable.',
  'generate image-to-splat':
    'Unavailable: no Studio splat generation flow has been verified. This command fails before submission.',
  'generate edit-multiview':
    'Each requested view is edited by a separate native Studio image task with its own receipt and website charge. A local four-view composition preserves untouched views and can feed multiview-to-model. Use a successful Studio four-view task or asset; arbitrary sheet URL/file-token layouts have no verified mapping.',
  'model texture':
    'Explicit v3.5 selects native Studio texture generation and verifies the exact operator engine. The v3.0 alias selects the current website operation without guaranteeing an older engine; v2.5 has no verified exact mapping. fast and texture_seed map to native generation; repeated seeds did not reproduce identical textures. PBR is a separate processing step.',
  'model convert':
    'Studio GLTF is self-contained GLB. --face-limit/--quad add a billed remesh; quad rejects GLTF/GLB and selects FBX for other formats. Static part selection/scale use a billed copy plus native metadata/export. Conversion preserves confirmed source skeletons/motions by default; with_animation=false explicitly requests static output. Static editing of a rigged source requires explicit false. New embedded GLB exports default to JPEG only for verified opaque sources; this image-only path preserves model structures without Blender. Other sources retain native encoding with a warning. Explicit JPEG without other local transforms uses the same verified image-only path and rejects unsupported/transparent textures; other explicit encodings use local conversion, which cannot preserve native quad topology. Native format, orientation, texture size and pose baking use Studio. Explicit animated GLTF bake=false with +x/-x/+y/-y, an explicit pivot_to_center_bottom=true/false and JPEG 2048 uses the pinned Studio frontend engine and export-lite. The original webpage engine implements all four axes; the current webpage export panel selects -y. Each source must pass embedded animation/material preservation; pivot=true also verifies actual skinned rest bottom-center placement. Saved metallic/roughness follows the webpage is_pbr branch. Geometry/display-name edits, separate motions and import/remesh chains are excluded from this animated route. Explicit static bake=false with with_animation=false, GLTF, one of these four axes, a boolean pivot, texture_format=JPEG/PNG/WEBP and texture_size=1–8192 can use the same frontend authorization route. It rejects skins/clips and verifies the actual saved static edits and materials. Existing textures must already match the requested encoding and exact square dimensions; untextured sources require no image conversion. Default requests and other combinations keep their existing paths; this file-only transform creates no new model operator.',
  'anim retarget':
    'Studio creates each motion separately and exports the combined model when requested. Standalone motion downloads are GLB; non-GLB out_format and animate_in_place require export_with_geometry=true. Conflicting animation/animations selections are rejected.',
  'mesh decimate':
    'Studio remesh uses model_version=default and supports --no-bake. --smart-uv adds separate UV generation and application tasks with website pricing. API engine version overrides are rejected.',
  'mesh uv':
    'Studio generates a UV candidate and applies it in two separately recorded steps. --no-bake explicitly permits texture removal; default/bake=true rejects textured sources before submission. compress=geometry adds native import for a restricted static untextured GLB, verifies each Meshopt result and restores source coordinates locally; UV/normals may be quantized. Further web editing must use the original UV task returned in uv_compression_validation. export_orientation adds a native export and cannot combine with compression.',
  'mesh segment':
    'Native v1/v2 segmentation remains available with its verified granularity/text controls. A reference mask can use Studio 3D Lab only with explicit -p reference_projection=[[a,b,c,d],[e,f,g,h]] and -p accept_variable_cost=true. These rows map original world [x,y,z,1] to mask pixels; nonzero orthogonal directions must have equal scale. The restricted source is one static untextured GLB primitive with POSITION/NORMAL and default material. The opaque PNG has white background and 2–8 exact RGB groups; every original triangle centroid must project to a group using floor(pixel+0.5). The real output must preserve every oriented original face, normal/material and exact group assignment. This is variable-cost Lab partitioning, not the official v2 engine, arbitrary semantic-mask interpretation or connectivity splitting. Explicit model/granularity/connectivity combinations are rejected. Frozen inputs, preparation receipts, result verification and redo are persistent; unknown writes are not repeated.',
  'mesh edit':
    'Studio supports bounding-box editing with exactly six finite coordinates (flat/nested array or slash/comma/semicolon/space text). Without --ref-image, compress=geometry requires native P2 GLB Meshopt validation even with --no-download. With --ref-image and -p accept_variable_cost=true, a restricted static, untextured GLB uses Studio 3D Lab with the exact model and image attached. This route verifies preserved outside triangles, normals/materials, no added outside geometry and a changed region; semantic fidelity remains an AI result. It uses variable web-account billing, not the fixed P2 engine or its price. Explicit face_limit/model/compression, skins, animations and textured sources have no verified combined mapping. Preparation receipts and the Lab job persist; unknown writes are never repeated. --no-wait returns the submitted task after preparation; --no-download still verifies the actual GLB when complete.',
  'mesh smartsegment':
    'Studio maps model granularity and hint to segmentation v2. Identity is accepted; exact +90 degree Z rotation of static GLB files/URLs keeps the guarded native import then segmentation route. Other verified positive TRS uses identity import (GLB file/URL) or exact-version copy (owned task/project), followed by native metadata and segmentation. Files/URLs require one centered unit-extent static triangle primitive with complete normals/UVs and basic opaque material. Owned task/project references additionally accept independent named roots with the same centered unit extent, complete normals/UVs and opaque scalar or embedded base-color materials; new owned references freeze the verified ordinary segmentation route explicitly after original-byte inspection, including a single entity whose Studio is_segmented flag remains true. Old requests retain their original frozen route. New generic v2 GLB segmentation follows the verified webpage Mesh-entity count after saved deletions: one entity uses ordinary segmentation and multiple entities use resegmentation. Explicit resegment keeps its own contract. All sources require no unapplied geometry edits. Original material metadata is frozen separately from the raw GLB material and preserved through the metadata step. Finite translations, proper orthogonal rotations and positive scales 0.01–100 use the three-step route. New single-axis shear and general positive-determinant affine requests use three native steps: import the unchanged original GLB with a source-derived proper rotation, write the frozen second TRS metadata, and ordinary segmentation. The import normalization and both factors are computed only from the original matrix and source coordinates before submission; each actual factor must satisfy the native positive-scale 0.01–100 and precision checks. This route accepts centered unit-extent static single-primitive GLB sources with complete normals/UVs and basic opaque appearance; an original display rename on the sole source node is mapped to the verified imported node, while stale rename keys for absent nodes are rejected before submission. Original Studio material metadata is preserved separately from raw GLB material values. Every native import must prove B1(P), source normals/UVs/embedded texture bytes and the projected original A(P) before continuing; final output separately proves every original A(P) face and every B2(actual import) face at the unchanged fixed 4e-5 bound, without accumulated tolerance or local vertex edits. Existing seven-step affine requests keep their original import/copy, metadata, segment, merge, copy, metadata and segment layout and receipts; no failed or unknown task switches routes. Each actual result is verified; this does not claim every matrix/source was tested against Studio. Reflection, projection, singular or out-of-range matrices and unresolvable coordinates remain rejected. Complete original source, metadata head and step inputs are frozen; get/list/download expose a verified result only after every native output face uniquely matches the requested transform. Each step retains its own receipt and possible cost. Native segmentation can recompute normals, repack UVs and re-encode textures; multi-root ordinary segmentation can remove UVs and materials entirely. Verification covers transformed geometry, not appearance preservation. Ordinary source-head checks are local; the service provides no atomic compare-and-swap. Image files/URLs without a hint use H3.1 Generate Parts with coarse/medium/fine granularity. Explicit seg_type=image also accepts successful Studio image-task references or image asset IDs and uses their first output; model tasks are rejected as image sources. Image hints use two separately billed steps: H3.1 modeling then v2 segmentation at the selected coarse/medium/fine granularity. Hints and granularity do not guarantee exact part counts or a finer split on every model. The result contains segmented GLB and a normalized segmentation-preview PNG, without an original-image pixel-alignment guarantee, semantic part-label text or official internal task IDs. Image transforms are rejected.',
  ai: 'Studio uses a producer and scenario specialist, or an offline wizard. Generated plans are locally validated; only Studio-supported parameters execute.',
  redo: 'Studio model and texture-generation tasks accept seeds; texture seeds do not guarantee deterministic output. Other operations repeat their original parameters; --seed is rejected for them. Reuse --request-id to resume the same redo intention. Verified frontend convert redo reconstructs the original complete parameters and exact source operator; an unknown result, missing cache or bare export-lite receipt cannot create a replacement authorization.',
};
const labSourceHelp =
  'Studio extension -p source_representation=studio_normalized explicitly selects the actual Studio representation of a verified Lab mesh-edit or explicitly projected-segmentation task. Projected sources additionally preserve every original named face group. The original Lab artifact/proof stays unchanged; centering/scaling, quantized normals and metadata differences are frozen and disclosed. A new selected source is copied from its exact historical operator; the copied GLB bytes are verified before downstream processing, with a separate possible cost. This new copy plus processing requires waiting; old requests keep their original frozen layout. Omit this selection to retain the original source restriction. Unverified Lab tasks and processing combinations are not implicitly accepted.';
for (const command of [
  'model texture',
  'anim rig',
  'model convert',
  'mesh decimate',
  'mesh uv',
  'mesh segment',
  'mesh edit',
  'mesh smartsegment',
])
  differences[command] = [differences[command], labSourceHelp].filter(Boolean).join(' ');
const unquotedSourceHelp =
  'New file/URL imports and UV compression imports require -p accept_variable_cost=true plus a current reviewed unquoted declaration. Omit --max-credits for an unquoted operation; a numeric value, including zero, is rejected because Studio provides no verified advance price or spending cap. Known-price steps still use their ordinary budget checks. This consent is validated locally and never forwarded to the Studio model request. Existing submitted or unknown steps retain their original receipts.';
for (const command of [
  'model import',
  'model texture',
  'anim check',
  'anim rig',
  'model convert',
  'mesh decimate',
  'mesh uv',
  'mesh segment',
  'mesh edit',
  'mesh smartsegment',
])
  differences[command] = [differences[command], unquotedSourceHelp].filter(Boolean).join(' ');
export function applyOfficialHelp(command: Command, prefix = ''): void {
  for (const child of command.commands) {
    const path = `${prefix} ${child.name()}`.trim();
    const source = helpContract[path];
    if (source && !preserve.has(path)) {
      child.description(source.description);
      for (const option of child.options) {
        const hint = source.options[option.flags];
        if (hint) option.description = hint;
      }
    }
    if (differences[path]) child.addHelpText('after', `\nStudio backend: ${differences[path]}\n`);
    applyOfficialHelp(child, path);
  }
}
