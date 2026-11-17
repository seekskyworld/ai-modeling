/** 官方 tripo-cli@0.11.2 公开命令帮助基线（MIT，见 THIRD_PARTY_NOTICES）；只复用契约文案，不导入其 API 客户端。 */
export const helpContract: Record<string, { description: string; options: Record<string, string> }> = {
  make: {
    description: 'turn text / images / a model file / a task ref into 3D artifacts (the magic command)',
    options: {
      '--for <scenario>': 'scenario preset: game-mobile|game-pc|film|print|ar-web|anim|toy',
      '--then <steps>': 'processing chain, e.g. "texture,rig,convert:fbx"',
      '--model <model>': 'force model version (tripo-v3.1 / tripo-p1 / tripo-p2 / ...)',
      '-n, --candidates <n>': 'generate N candidates in parallel',
      '--seed <n>': 'model_seed for reproducible geometry',
      '--dry-run':
        'plan + validate only: print model, completed params and chain steps; no upload, no submit, no credits',
    },
  },
  ai: {
    description: 'describe what you want in natural language; experts plan it, you confirm, it runs',
    options: {
      '--wizard': 'force wizard mode even when an LLM is configured',
    },
  },
  view: {
    description: 'preview a 3D result in the browser (model-viewer, local server)',
    options: {
      '--keep': 'keep the preview server running until Ctrl+C',
    },
  },
  redo: {
    description: 're-run a previous task with a fresh seed (same everything else)',
    options: {
      '--seed <n>': 'explicit seed (model_seed, texture_seed or image_seed, by task type)',
    },
  },
  login: {
    description: 'sign in: browser authorizes, the key arrives automatically',
    options: {
      '--paste': 'skip the browser flow; just paste an API key',
      '--key <key>': 'provide the API key directly (tsk_...); region is auto-detected',
      '--region <region>': 'ov or cn — needed for the browser flow; required for non-interactive login',
    },
  },
  logout: {
    description: 'remove the locally stored API key (current profile only)',
    options: {},
  },
  whoami: {
    description: 'show the active key (masked), region, balance, and other profiles',
    options: {},
  },
  use: {
    description: 'switch the active account profile (no argument: pick interactively)',
    options: {},
  },
  topup: {
    description: 'open the billing page and watch for the credits to arrive',
    options: {
      '--no-watch': 'just open the page; skip balance polling',
    },
  },
  balance: {
    description: 'show available and frozen credits',
    options: {},
  },
  usage: {
    description: 'recent task credit usage',
    options: {
      '--limit <n>': 'max rows to show',
    },
  },
  models: {
    description: 'list the model ids each capability accepts (local whitelist, no API call)',
    options: {},
  },
  generate: {
    description: 'deterministic generation endpoints (text/image/multiview → model/image/splat)',
    options: {},
  },
  'generate text-to-model': {
    description: 'text → 3D model',
    options: {
      '--model <model>': 'model version override',
    },
  },
  'generate image-to-model': {
    description: 'single image → 3D model',
    options: {
      '--model <model>': 'model version override',
      '--prompt <text>': 'prompt for prompt-guided endpoints',
    },
  },
  'generate multiview-to-model': {
    description: '2–4 view images, or one image-to-multiview/edit-multiview task → 3D model',
    options: {
      '--model <model>': 'model version override',
      '--prompt <text>': 'prompt for prompt-guided endpoints',
    },
  },
  'generate text-to-image': {
    description: 'text → image (concept art / t_pose templates)',
    options: {
      '--model <model>': 'model version override',
    },
  },
  'generate image-to-image': {
    description: 'image(s) + prompt → edited image (several images: cite them as image[1], image[2], ...)',
    options: {
      '--model <model>': 'model version override',
      '--prompt <text>': 'prompt for prompt-guided endpoints',
    },
  },
  'generate image-to-multiview': {
    description: 'single image → 4-view sheet',
    options: {
      '--model <model>': 'model version override',
      '--prompt <text>': 'prompt for prompt-guided endpoints',
    },
  },
  'generate edit-multiview': {
    description: 'edit views of a multiview task',
    options: {
      '--model <model>': 'model version override',
      '--prompt <text>': 'prompt for prompt-guided endpoints',
    },
  },
  'generate image-to-splat': {
    description: 'image → gaussian splat',
    options: {
      '--model <model>': 'model version override',
      '--prompt <text>': 'prompt for prompt-guided endpoints',
    },
  },
  model: {
    description: 'model processing: texture / convert / import',
    options: {},
  },
  'model texture': {
    description: 're-texture a model (task/@last/file/url)',
    options: {
      '--dry-run': 'plan + validate only; no network calls, uploads or credits',
      '--model <v>':
        'v3.5-20260815|v3.0-20250812|v2.5-20250123 or v3.5|v3.0|v2.5 (default v3.0; fast/delight select v3.5)',
      '--texture-quality <q>': 'fast|standard|detailed|extreme (fast needs v3.5)',
      '--texture-alignment <a>': 'original_image|geometry',
    },
  },
  'model convert': {
    description: 'convert format (GLTF/USDZ/FBX/OBJ/STL/3MF)',
    options: {
      '--format <format>': 'target format (required)',
      '--texture-size <n>': 'texture size in px',
      '--texture-format <f>': 'JPEG/PNG/OPEN_EXR/...',
      '--face-limit <n>': 'face limit',
      '--quad': 'quad remesh',
      '--flatten-bottom': 'flatten the bottom (3D printing)',
      '--fbx-preset <p>': 'blender|3dsmax|mixamo|bake_scale',
      '--export-orientation <o>': '+x|-x|+y|-y',
      '--scale-factor <n>': 'scale factor',
      '--pivot-to-center-bottom': 'pivot at center bottom',
      '--export-vertex-colors': 'include vertex colors (OBJ/GLTF)',
    },
  },
  'model import': {
    description: 'import an external model file/url (GLB/GLTF/FBX/OBJ/STL ≤150MB)',
    options: {},
  },
  anim: {
    description: 'animation: check (riggability) / rig / retarget',
    options: {},
  },
  'anim check': {
    description: 'rig-check: is this model riggable? (GLB/FBX/OBJ/STL input)',
    options: {},
  },
  'anim rig': {
    description: 'rig a model (skeleton binding)',
    options: {
      '--model <v>':
        'v3.0-20260909|v2.5-20260210|v1.0-20240301 (default v2.5 for quadruped, v3.0 otherwise; aliases v3.0/v2.5/v1.0, rig-v3.0/rig-v2.5/rig-v1.0)',
      '--rig-type <type>': 'biped|quadruped|hexapod|octopod|avian|serpentine|aquatic|others (others: v3.0)',
      '--spec <spec>':
        'tripo|mixamo|actorcore|unity|unreal|vrm (biped only; actorcore/unity/unreal/vrm: v3.0)',
      '--out-format <f>': 'glb|fbx',
    },
  },
  'anim retarget': {
    description: 'apply preset animations to a rigged task',
    options: {
      '--animation <name...>': 'preset:walk preset:run ... (≤5, billed per animation)',
      '--out-format <f>': 'glb|fbx',
      '--animate-in-place': 'no root motion',
    },
  },
  mesh: {
    description: 'mesh ops: segment / complete / decimate / uv / smartsegment',
    options: {},
  },
  'mesh segment': {
    description: 'segment a model into parts',
    options: {
      '--model <v>': 'v1.0-20250506|v2.0-20260430 (v2-only params select v2.0)',
    },
  },
  'mesh complete': {
    description: 'complete/fill segmented parts (needs a segment task)',
    options: {
      '--completion-mode <m>': 'ai_completion|quick_cap',
    },
  },
  'mesh decimate': {
    description: 'high-poly → low-poly (bakes textures by default)',
    options: {
      '--model <v>': 'v3.0|v2.0|v1.0 (default v2.0)',
      '--face-limit <n>': 'target faces 500–20000 tri / 500–10000 quad',
      '--quad': 'quad output',
      '--smart-uv': 'unwrap UVs in the same task (requires --model v3.0)',
      '--no-bake': 'skip baking textures onto the low-poly',
    },
  },
  'mesh edit': {
    description: 'local retry/refine inside a bounding box (P2 pipeline, model P2-20260801)',
    options: {
      '--bbox <x1,y1,z1,x2,y2,z2>': 'required 2×3 axis-aligned bbox in model space',
      '--face-limit <n>': 'output face limit (≥100)',
      '--ref-image <file-or-url>': 'reference image for semantic guidance',
      '--model <v>': 'P2-20260801 (only supported value)',
    },
  },
  'mesh uv': {
    description: 'smart UV unwrap; remaps textures/rig/animation (input ≤80k equivalent triangles)',
    options: {
      '--no-bake': 'skip baking textures onto the new UV layout (geometry + UVs only)',
      '--export-orientation <o>': '+x|-x|+y|-y',
    },
  },
  'mesh smartsegment': {
    description: 'smart segmentation (image or model pipeline)',
    options: {
      '--seg-type <t>': 'image|model (default: image for an image file/URL, else model)',
      '--granularity <g>': 'coarse|medium|fine',
      '--hint <text>': 'hint for the parts to find',
    },
  },
  task: {
    description: 'query, list, and watch tasks',
    options: {},
  },
  'task get': {
    description: 'fetch one task (accepts @last/@name)',
    options: {
      '--step': 'include pipeline step details',
      '--download': 'download artifacts if successful',
    },
  },
  'task list': {
    description: 'batch-query tasks (default: recent history)',
    options: {
      '--limit <n>': 'how many from history',
    },
  },
  'task watch': {
    description: 'block until a task finishes (progress on stderr; stdout carries only the final JSON)',
    options: {
      '--download': 'download artifacts on success',
    },
  },
  files: {
    description: 'file uploads',
    options: {},
  },
  'files upload': {
    description: 'upload a local image/model and print the file_token',
    options: {},
  },
  history: {
    description: 'recent tasks created by this CLI (@name references)',
    options: {
      '--limit <n>': 'rows',
    },
  },
  batch: {
    description: 'bulk pipelines from a YAML manifest',
    options: {},
  },
  'batch run': {
    description: 'run all jobs (resumable: finished jobs are skipped on re-run)',
    options: {
      '--concurrency <n>': 'parallel jobs (default from manifest or 2)',
      '--retries <n>': 'retries per failed job (only when no paid task was left behind)',
      '--fresh': 'ignore previous state and re-run everything',
    },
  },
  config: {
    description: 'global config and directory context (.ai-modeling)',
    options: {},
  },
  'config list': {
    description: 'show effective config (keys masked)',
    options: {},
  },
  'config set': {
    description:
      'set a config value (region, api_base_url, platform_base_url, default_output_dir, llm.base_url, llm.api_key, llm.model)',
    options: {},
  },
  'config unset': {
    description: 'remove a config value',
    options: {},
  },
  'config context': {
    description: 'set directory context: ai-modeling config context output_dir=./assets',
    options: {},
  },
  doctor: {
    description: 'diagnose environment, key, network, and terminal capabilities',
    options: {},
  },
  update: {
    description: 'show npm update instructions; --check queries the latest published version',
    options: {
      '--check': 'check the public npm version without changing this installation',
    },
  },
  docs: {
    description: 'print bundled docs (default: the LLM/agent skill map)',
    options: {
      '--llm': 'print the agent-facing SKILL.md (default)',
      '--topic <name>': 'print a specific doc: commands/<cmd> or examples/<scenario> or common-errors',
    },
  },
  completion: {
    description: 'print a completion script (bash|zsh|fish); e.g. ai-modeling completion zsh >> ~/.zshrc',
    options: {},
  },
  mcp: {
    description: 'run as an MCP server over stdio; shared guidance and tools invoke the bundled CLI',
    options: {
      '--toolset <name>': 'default (6 tools), full (official-style contracts), studio (web extensions)',
    },
  },
};
