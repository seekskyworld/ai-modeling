# CLI 命令参考

版本 0.1.9。以下保留实际 Commander 命令树的 239 条路径（含分组）、参数与选项；已发布安装包以本机 `--help` 为准。CLI 是底层执行接口，MCP 工具在内部调用 CLI，Skills 为所选入口提供流程指导。命令存在不等于所有官方 API 效果均已实现，支持条件见[兼容与限制](compatibility.md)。安装、登录、MCP 和恢复流程见[使用指南](usage.md)。

需要导入外部模型或进行 UV 压缩的兼容处理链，使用 `-p accept_variable_cost=true` 接受有效审阅快照中明确标注的未知费用；省略 `--max-credits`，数字 0 也不能代表未知费用。Studio 结构化工具的同意字段在 `parameters` 内，full MCP 对应处理工具使用顶层字段。详见[费用合同](usage.md#费用任务与恢复)。

## 查找命令

```sh
ai-modeling --help
ai-modeling model convert --help
ai-modeling docs --topic commands/process
ai-modeling tools --toolset studio
```

`--help` 显示当前安装版本的实际帮助；`tools` 离线列出结构化工具定义，不读凭据或创建任务状态。`call TOOL --input-stdin` 和 `--input JSON` 读取对象输入，与 `--toolset`、`--profile` 可正常排列并支持 `--flag=value`；重复、未知、互斥、缺值选项或非对象 JSON 返回 `INVALID_INPUT`。`docs` 默认打开使用指南，另可通过 `--topic` 选择 `commands`、`compatibility` 或 `development`。

以下公共选项适用于下方 Commander 业务命令，不在每节重复。`call`、`tools`、`guides` 和 `auth` 是独立的结构化入口，按各自参数使用；例如 `call` 已输出 JSON，不接受 `--json`、`--yes` 或 `--no-open`。

| 选项 | 用途 |
| --- | --- |
| `--json` | 向 stdout 输出机器可读结果 |
| `--yes` | 跳过命令确认 |
| `--quiet` | 隐藏 stderr 进度信息 |
| `--no-open` | 不自动打开浏览器或查看器 |
| `--profile <name>` | 使用指定账号配置 |

## 认证扩展

这些入口在任务库初始化前分派，不计入 Commander 路径数。兼容入口仍为下方的 `ai-modeling login`、`logout`、`whoami`。登录凭据保存在 OS 用户主目录的私有 JSON 文件中，同 profile 的 CLI/MCP 共用，与业务数据目录独立；见[权限与升级](usage.md#本地-json-凭据)。结果未知的写请求不会因重新登录而自动重放。

| 扩展入口 | 行为 |
| --- | --- |
| `ai-modeling auth login` | 检查已有会话，必要时启动浏览器登录；支持 `--no-wait`、`--wait`、`--no-open`、`--force`、`--timeout <seconds>`、`--browser-executable <path>`、`--cdp-endpoint <url>`。 |
| `ai-modeling auth begin` | 启动或复用当前 profile 的登录流程并立即返回 login_id、login_url 与期限；`--no-open` 时使用本机页面按钮打开受控浏览器。 |
| `ai-modeling auth session status [login_id]` | 查询登录流程快照，不读取凭据或验证远端会话；省略 ID 查询当前 profile 流程，接续时须核对原 login_id。 |
| `ai-modeling auth session wait [login_id]` | 等待当前流程；`--timeout <seconds>` 只限定本次等待，不延长登录流程。也接受 `ai-modeling auth wait`。 |
| `ai-modeling auth session cancel [login_id]` | 取消当前流程，不删除已保存会话。也接受 `ai-modeling auth cancel`。 |
| `ai-modeling auth status` | 保留账号会话及余额查询语义；与短时流程状态不同。 |
| `ai-modeling auth import --stdin` / `--file PATH` | 显式备用导入；文件须为本机私有常规文件（Unix 权限 0600；Windows 为当前用户 SID/SYSTEM 的受保护 ACL，只验证、不自动修复）。`auth login --paste` 读取 stdin；`auth login --form` 打开备用本机表单。 |
| `ai-modeling auth logout` | 先取消当前登录流程，再清除当前 profile 的本机会话。 |

## 共享指南入口

这些离线 JSON 入口不计入下方 Commander 命令树；内容与 Skill/MCP 指导资源同源，不调用账号或提交任务。

| 入口 | 内容 |
| --- | --- |
| `ai-modeling guides list` | 列出 `usage`、`commands`、`pipelines` 和 `commands/index` |
| `ai-modeling guides templates` | 列出命令分片模板 `ai-modeling://guides/commands/{+command}` |
| `ai-modeling guides read commands/index` | 当前命令树与具体分片 URI |
| `ai-modeling guides read commands/model/convert` | 一个命令的实时帮助和 Studio 限制；也可读取 `commands/model` 分组 |
| `ai-modeling guides read usage` | Skill 的使用、登录、费用和恢复说明 |
| `ai-modeling guides read commands` | 当前公开命令参考 |
| `ai-modeling guides read pipelines` | 按需组合操作、补交付与批处理示例 |

MCP 用户优先读取 `ai-modeling://guides/commands/index` 与相关命令分片，仍可读取同源的 `usage`、`commands`、`pipelines` 资源，并通过 MCP 工具执行；无需自行启动 CLI。

MCP 的 Studio 工具集新增 `ai_modeling_auth_begin`、`ai_modeling_auth_status`、`ai_modeling_auth_wait`、`ai_modeling_auth_cancel`，含当前网页扩展共 182 项；default 为 6 项（含独立生图），full 为 26 项（启用实验 mesh edit 后 27 项）。三个工具集均可读取 `ai-modeling://auth/status` 资源，资源经同包 CLI 查询且不读取或返回凭据。单次 MCP 等待最多 60 秒，完整登录流程最多 15 分钟。

流程结果标记 `scope: login_flow`，`credential_store_check` 和 `studio_session_check` 均为 `not_checked`。`authenticated`、`login_required`、余额与到期时间仅属于该流程记录；已完成记录可在流程期限后继续存在。接续时必须匹配原 `AUTH_REQUIRED` 返回的 `login_id`，不能把任意历史成功当作当前认证可用。`auth login` 直接验证已有会话成功时返回 `scope: verified_session` 及两项 `verified`；实时账号查询使用 `auth status` 或 MCP 的 `ai_modeling_balance`。

## `ai-modeling make <input...>`

turn text / images / a model file / a task ref into 3D artifacts (the magic command)

```text
--for <scenario>  scenario preset: game-mobile|game-pc|film|print|ar-web|anim|toy
--then <steps>  processing chain, e.g. "texture,rig,convert:fbx"
--model <model>  force model version (tripo-v3.1 / tripo-p1 / tripo-p2 / ...)
-n, --candidates <n>  generate N candidates in parallel [default: 1]
--seed <n>  model_seed for reproducible geometry
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only: print model, completed params and chain steps; no upload, no submit, no credits
```

- `input`: prompt text, image file(s), model file, URL, task id, or @last

## `ai-modeling generate`

deterministic generation endpoints (text/image/multiview → model/image/splat)

## `ai-modeling generate text-to-model <prompt...>`

text → 3D model

```text
--model <model>  model version override
--prompt <text>  prompt for prompt-guided endpoints
--edit-base  Studio extension: first image is the edit base; remaining images are additional references
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

Studio backend: P1/P2 texture=true runs bare generation then native texture; pbr=true adds PBR. Each step has separate website pricing and a resumable receipt. --no-wait requires texture=false. export_orientation adds a native Studio export after the complete generation chain.

## `ai-modeling generate image-to-model <input>`

single image → 3D model

```text
--model <model>  model version override
--prompt <text>  prompt for prompt-guided endpoints
--edit-base  Studio extension: first image is the edit base; remaining images are additional references
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

Studio backend: P2 single-image face_limit starts at 500: the website rejects 100 even for bare geometry. P1/P2 texture=true runs bare generation then native texture; pbr=true adds PBR. Each step has separate website pricing and a resumable receipt. --no-wait requires texture=false. export_orientation adds a native Studio export after the complete generation chain.

## `ai-modeling generate multiview-to-model <inputs...>`

2–4 view images, or one image-to-multiview/edit-multiview task → 3D model

```text
--model <model>  model version override
--prompt <text>  prompt for prompt-guided endpoints
--edit-base  Studio extension: first image is the edit base; remaining images are additional references
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

Studio backend: P1/P2 texture=true runs bare generation then native texture; pbr=true adds PBR. Each step has separate website pricing and a resumable receipt. --no-wait requires texture=false. export_orientation adds a native Studio export after the complete generation chain.

## `ai-modeling generate text-to-image <prompt...>`

text → image (concept art / t_pose templates)

```text
--model <model>  model version override
--prompt <text>  prompt for prompt-guided endpoints
--edit-base  Studio extension: first image is the edit base; remaining images are additional references
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

Studio backend: Default image model: GPT Image 2.5 (gpt_image_2.5_sunburst). Banana supports five verified WxH sizes; Banana Pro supports 1024x1024, 1200x896, 896x1200, 1376x768, 768x1376 and 4096x4096. GPT Image 2 and 2.5 Sunburst support 1024x1024, 1536x1152, 1152x1536, 1792x1024 and 1024x1792 via native 1K resolution/ratio controls. Explicit WxH is frozen and checked against every original image, including --no-download; a mismatch preserves remote success as needs_attention without resizing or regeneration. Nano Banana 2K requests returned 1K and are rejected. Studio extension -p scale=auto omits the ratio without promising pixel dimensions; omitted scale retains 1:1. Sunburst background=opaque freezes a delivery requirement and verifies all original alpha values; it never fills a background or adds a processing task. Transparent/auto background and explicit GPT quality tiers remain unavailable. Seedream and unsupported image options are rejected.

## `ai-modeling generate image-to-multiview <input>`

single image → 4-view sheet

```text
--model <model>  model version override
--prompt <text>  prompt for prompt-guided endpoints
--edit-base  Studio extension: first image is the edit base; remaining images are additional references
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

Studio backend: Studio uses the website multiview engine; API model overrides are unavailable.

## `ai-modeling generate edit-multiview <input>`

edit views of a multiview task

```text
--model <model>  model version override
--prompt <text>  prompt for prompt-guided endpoints
--edit-base  Studio extension: first image is the edit base; remaining images are additional references
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

Studio backend: Each requested view is edited by a separate native Studio image task with its own receipt and website charge. A local four-view composition preserves untouched views and can feed multiview-to-model. Use a successful Studio four-view task or asset; arbitrary sheet URL/file-token layouts have no verified mapping.

## `ai-modeling generate image-to-splat <input>`

image → gaussian splat

```text
--model <model>  model version override
--prompt <text>  prompt for prompt-guided endpoints
--edit-base  Studio extension: first image is the edit base; remaining images are additional references
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

Studio backend: Unavailable: no Studio splat generation flow has been verified. This command fails before submission.

## `ai-modeling generate image-to-image <inputs...>`

image(s) + prompt → edited image (several images: cite them as image[1], image[2], ...)

```text
--model <model>  model version override
--prompt <text>  prompt for prompt-guided endpoints
--edit-base  Studio extension: first image is the edit base; remaining images are additional references
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

Studio backend: Default image model: GPT Image 2.5 (gpt_image_2.5_sunburst). GPT Image 2 and 2.5 Sunburst accept 16 total ordered references; --edit-base assigns one primary plus at most 15 additional references. Exact WxH uses the same model-specific native resolution/ratio mappings as text-to-image and verifies every actual edit result without resizing; reference inputs do not waive the frozen pixel-size requirement. Nano Banana 2K requests returned 1K and are rejected. Studio extension -p scale=auto follows the webpage reference-image flow with no selected ratio; omitted scale retains 1:1. Sunburst background=opaque freezes a delivery requirement and verifies all original alpha values; it never fills a background or adds a processing task. Transparent/auto background and explicit GPT quality tiers remain unavailable. Seedream and unsupported image options are rejected.

## `ai-modeling model`

model processing: texture / convert / import

## `ai-modeling model texture [input]`

re-texture a model (task/@last/file/url)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--model <v>  v3.5-20260815|v3.0-20250812|v2.5-20250123 or v3.5|v3.0|v2.5 (default v3.0; fast/delight select v3.5)
--texture-quality <q>  fast|standard|detailed|extreme (fast needs v3.5)
--texture-alignment <a>  original_image|geometry
```

Studio backend: Explicit v3.5 selects native Studio texture generation and verifies the exact operator engine. The v3.0 alias selects the current website operation without guaranteeing an older engine; v2.5 has no verified exact mapping. fast and texture_seed map to native generation; repeated seeds did not reproduce identical textures. PBR is a separate processing step. Studio extension -p source_representation=studio_normalized explicitly selects the actual Studio representation of a verified Lab mesh-edit or explicitly projected-segmentation task. Projected sources additionally preserve every original named face group. The original Lab artifact/proof stays unchanged; centering/scaling, quantized normals and metadata differences are frozen and disclosed. A new selected source is copied from its exact historical operator; the copied GLB bytes are verified before downstream processing, with a separate possible cost. This new copy plus processing requires waiting; old requests keep their original frozen layout. Omit this selection to retain the original source restriction. Unverified Lab tasks and processing combinations are not implicitly accepted.

## `ai-modeling model convert [input]`

convert format (GLTF/USDZ/FBX/OBJ/STL/3MF)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--format <format>  target format (required)
--texture-size <n>  texture size in px
--texture-format <f>  JPEG/PNG/OPEN_EXR/...
--face-limit <n>  face limit
--quad  quad remesh
--flatten-bottom  flatten the bottom (3D printing)
--fbx-preset <p>  blender|3dsmax|mixamo|bake_scale
--export-orientation <o>  +x|-x|+y|-y
--scale-factor <n>  scale factor
--pivot-to-center-bottom  pivot at center bottom
--export-vertex-colors  include vertex colors (OBJ/GLTF)
```

Studio backend: Studio GLTF is self-contained GLB. --face-limit/--quad add a billed remesh; quad rejects GLTF/GLB and selects FBX for other formats. Static part selection/scale use a billed copy plus native metadata/export. Conversion preserves confirmed source skeletons/motions by default; with_animation=false explicitly requests static output. Static editing of a rigged source requires explicit false. New embedded GLB exports default to JPEG only for verified opaque sources; this image-only path preserves model structures without Blender. Other sources retain native encoding with a warning. Explicit JPEG without other local transforms uses the same verified image-only path and rejects unsupported/transparent textures; other explicit encodings use local conversion, which cannot preserve native quad topology. Native format, orientation, texture size and pose baking use Studio. Explicit animated GLTF bake=false with +x/-x/+y/-y, an explicit pivot_to_center_bottom=true/false and JPEG 2048 uses the pinned Studio frontend engine and export-lite. The original webpage engine implements all four axes; the current webpage export panel selects -y. Each source must pass embedded animation/material preservation; pivot=true also verifies actual skinned rest bottom-center placement. Saved metallic/roughness follows the webpage is_pbr branch. Geometry/display-name edits, separate motions and import/remesh chains are excluded from this animated route. Explicit static bake=false with with_animation=false, GLTF, one of these four axes, a boolean pivot, texture_format=JPEG/PNG/WEBP and texture_size=1–8192 can use the same frontend authorization route. It rejects skins/clips and verifies the actual saved static edits and materials. Existing textures must already match the requested encoding and exact square dimensions; untextured sources require no image conversion. Default requests and other combinations keep their existing paths; this file-only transform creates no new model operator. Studio extension -p source_representation=studio_normalized explicitly selects the actual Studio representation of a verified Lab mesh-edit or explicitly projected-segmentation task. Projected sources additionally preserve every original named face group. The original Lab artifact/proof stays unchanged; centering/scaling, quantized normals and metadata differences are frozen and disclosed. A new selected source is copied from its exact historical operator; the copied GLB bytes are verified before downstream processing, with a separate possible cost. This new copy plus processing requires waiting; old requests keep their original frozen layout. Omit this selection to retain the original source restriction. Unverified Lab tasks and processing combinations are not implicitly accepted.

## `ai-modeling model import <input>`

import an external model file/url (GLB/GLTF/FBX/OBJ/STL ≤150MB)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

结果补充：可验证的默认 identity、原 UV、自包含静态单独立 root、单个三角面 primitive GLB 导入会返回 `normalize_scale`、provenance 和验证信息。这是原件与实际网页产物逐面对应后派生的数值；不修改模型字节，也不代表物理米制 `auto_size`。不符合范围的输入照常导入并省略因子；`--no-download` 可读取原件到私有缓存完成验证，不写调用方交付目录。完整条件和恢复行为见[导入归一化](compatibility.md)。

## `ai-modeling anim`

animation: check (riggability) / rig / retarget

## `ai-modeling anim rig [input]`

rig a model (skeleton binding)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--model <v>  v3.0-20260909|v2.5-20260210|v1.0-20240301 (default v2.5 for quadruped, v3.0 otherwise; aliases v3.0/v2.5/v1.0, rig-v3.0/rig-v2.5/rig-v1.0)
--rig-type <type>  biped|quadruped|hexapod|octopod|avian|serpentine|aquatic|others (others: v3.0)
--spec <spec>  tripo|mixamo|actorcore|unity|unreal|vrm (biped only; actorcore/unity/unreal/vrm: v3.0)
--out-format <f>  glb|fbx
```

## `ai-modeling anim retarget [input]`

apply preset animations to a rigged task

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--animation <name...>  preset:walk preset:run ... (≤5, billed per animation)
--out-format <f>  glb|fbx
--animate-in-place  no root motion
```

Studio backend: Studio creates each motion separately and exports the combined model when requested. Standalone motion downloads are GLB; non-GLB out_format and animate_in_place require export_with_geometry=true. Conflicting animation/animations selections are rejected.

## `ai-modeling anim check [input]`

rig-check: is this model riggable? (GLB/FBX/OBJ/STL input)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

## `ai-modeling mesh`

mesh ops: segment / complete / decimate / uv / smartsegment

## `ai-modeling mesh segment [input]`

segment a model into parts

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--model <v>  v1.0-20250506|v2.0-20260430 (v2-only params select v2.0)
```

Studio backend: Native v1/v2 segmentation remains available with its verified granularity/text controls. A reference mask can use Studio 3D Lab only with explicit -p reference_projection=[[a,b,c,d],[e,f,g,h]] and -p accept_variable_cost=true. These rows map original world [x,y,z,1] to mask pixels; nonzero orthogonal directions must have equal scale. The restricted source is one static untextured GLB primitive with POSITION/NORMAL and default material. The opaque PNG has white background and 2–8 exact RGB groups; every original triangle centroid must project to a group using floor(pixel+0.5). The real output must preserve every oriented original face, normal/material and exact group assignment. This is variable-cost Lab partitioning, not the official v2 engine, arbitrary semantic-mask interpretation or connectivity splitting. Explicit model/granularity/connectivity combinations are rejected. Frozen inputs, preparation receipts, result verification and redo are persistent; unknown writes are not repeated. Studio extension -p source_representation=studio_normalized explicitly selects the actual Studio representation of a verified Lab mesh-edit or explicitly projected-segmentation task. Projected sources additionally preserve every original named face group. The original Lab artifact/proof stays unchanged; centering/scaling, quantized normals and metadata differences are frozen and disclosed. A new selected source is copied from its exact historical operator; the copied GLB bytes are verified before downstream processing, with a separate possible cost. This new copy plus processing requires waiting; old requests keep their original frozen layout. Omit this selection to retain the original source restriction. Unverified Lab tasks and processing combinations are not implicitly accepted.

## `ai-modeling mesh complete [input]`

complete/fill segmented parts (needs a segment task)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--completion-mode <m>  ai_completion|quick_cap
```

## `ai-modeling mesh decimate [input]`

high-poly → low-poly (bakes textures by default)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--model <v>  v3.0|v2.0|v1.0 (default v2.0)
--face-limit <n>  target faces 500–20000 tri / 500–10000 quad
--quad  quad output
--smart-uv  unwrap UVs in the same task (requires --model v3.0)
--no-bake  skip baking textures onto the low-poly
```

Studio backend: Studio remesh uses model_version=default and supports --no-bake. --smart-uv adds separate UV generation and application tasks with website pricing. API engine version overrides are rejected. Studio extension -p source_representation=studio_normalized explicitly selects the actual Studio representation of a verified Lab mesh-edit or explicitly projected-segmentation task. Projected sources additionally preserve every original named face group. The original Lab artifact/proof stays unchanged; centering/scaling, quantized normals and metadata differences are frozen and disclosed. A new selected source is copied from its exact historical operator; the copied GLB bytes are verified before downstream processing, with a separate possible cost. This new copy plus processing requires waiting; old requests keep their original frozen layout. Omit this selection to retain the original source restriction. Unverified Lab tasks and processing combinations are not implicitly accepted.

## `ai-modeling mesh uv [input]`

smart UV unwrap; remaps textures/rig/animation (input ≤80k equivalent triangles)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--no-bake  skip baking textures onto the new UV layout (geometry + UVs only)
--export-orientation <o>  +x|-x|+y|-y
```

Studio backend: Studio generates a UV candidate and applies it in two separately recorded steps. --no-bake explicitly permits texture removal; default/bake=true rejects textured sources before submission. compress=geometry adds native import for a restricted static untextured GLB, verifies each Meshopt result and restores source coordinates locally; UV/normals may be quantized. Further web editing must use the original UV task returned in uv_compression_validation. export_orientation adds a native export and cannot combine with compression. Studio extension -p source_representation=studio_normalized explicitly selects the actual Studio representation of a verified Lab mesh-edit or explicitly projected-segmentation task. Projected sources additionally preserve every original named face group. The original Lab artifact/proof stays unchanged; centering/scaling, quantized normals and metadata differences are frozen and disclosed. A new selected source is copied from its exact historical operator; the copied GLB bytes are verified before downstream processing, with a separate possible cost. This new copy plus processing requires waiting; old requests keep their original frozen layout. Omit this selection to retain the original source restriction. Unverified Lab tasks and processing combinations are not implicitly accepted.

## `ai-modeling mesh smartsegment [input]`

smart segmentation (image or model pipeline)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--seg-type <t>  image|model (default: image for an image file/URL, else model)
--granularity <g>  coarse|medium|fine
--hint <text>  hint for the parts to find
```

Studio backend: Studio maps model granularity and hint to segmentation v2. Identity is accepted; exact +90 degree Z rotation of static GLB files/URLs keeps the guarded native import then segmentation route. Other verified positive TRS uses identity import (GLB file/URL) or exact-version copy (owned task/project), followed by native metadata and segmentation. Files/URLs require one centered unit-extent static triangle primitive with complete normals/UVs and basic opaque material. Owned task/project references additionally accept independent named roots with the same centered unit extent, complete normals/UVs and opaque scalar or embedded base-color materials; new owned references freeze the verified ordinary segmentation route explicitly after original-byte inspection, including a single entity whose Studio is_segmented flag remains true. Old requests retain their original frozen route. New generic v2 GLB segmentation follows the verified webpage Mesh-entity count after saved deletions: one entity uses ordinary segmentation and multiple entities use resegmentation. Explicit resegment keeps its own contract. All sources require no unapplied geometry edits. Original material metadata is frozen separately from the raw GLB material and preserved through the metadata step. Finite translations, proper orthogonal rotations and positive scales 0.01–100 use the three-step route. New single-axis shear and general positive-determinant affine requests use three native steps: import the unchanged original GLB with a source-derived proper rotation, write the frozen second TRS metadata, and ordinary segmentation. The import normalization and both factors are computed only from the original matrix and source coordinates before submission; each actual factor must satisfy the native positive-scale 0.01–100 and precision checks. This route accepts centered unit-extent static single-primitive GLB sources with complete normals/UVs and basic opaque appearance; an original display rename on the sole source node is mapped to the verified imported node, while stale rename keys for absent nodes are rejected before submission. Original Studio material metadata is preserved separately from raw GLB material values. Every native import must prove B1(P), source normals/UVs/embedded texture bytes and the projected original A(P) before continuing; final output separately proves every original A(P) face and every B2(actual import) face at the unchanged fixed 4e-5 bound, without accumulated tolerance or local vertex edits. Existing seven-step affine requests keep their original import/copy, metadata, segment, merge, copy, metadata and segment layout and receipts; no failed or unknown task switches routes. Each actual result is verified; this does not claim every matrix/source was tested against Studio. Reflection, projection, singular or out-of-range matrices and unresolvable coordinates remain rejected. Complete original source, metadata head and step inputs are frozen; get/list/download expose a verified result only after every native output face uniquely matches the requested transform. Each step retains its own receipt and possible cost. Native segmentation can recompute normals, repack UVs and re-encode textures; multi-root ordinary segmentation can remove UVs and materials entirely. Verification covers transformed geometry, not appearance preservation. Ordinary source-head checks are local; the service provides no atomic compare-and-swap. Image files/URLs without a hint use H3.1 Generate Parts with coarse/medium/fine granularity. Explicit seg_type=image also accepts successful Studio image-task references or image asset IDs and uses their first output; model tasks are rejected as image sources. Image hints use two separately billed steps: H3.1 modeling then v2 segmentation at the selected coarse/medium/fine granularity. Hints and granularity do not guarantee exact part counts or a finer split on every model. The result contains segmented GLB and a normalized segmentation-preview PNG, without an original-image pixel-alignment guarantee, semantic part-label text or official internal task IDs. Image transforms are rejected. Studio extension -p source_representation=studio_normalized explicitly selects the actual Studio representation of a verified Lab mesh-edit or explicitly projected-segmentation task. Projected sources additionally preserve every original named face group. The original Lab artifact/proof stays unchanged; centering/scaling, quantized normals and metadata differences are frozen and disclosed. A new selected source is copied from its exact historical operator; the copied GLB bytes are verified before downstream processing, with a separate possible cost. This new copy plus processing requires waiting; old requests keep their original frozen layout. Omit this selection to retain the original source restriction. Unverified Lab tasks and processing combinations are not implicitly accepted.

## `ai-modeling mesh edit [input]`

local retry/refine inside a bounding box (P2 pipeline, model P2-20260801)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--bbox <x1,y1,z1,x2,y2,z2>  required 2×3 axis-aligned bbox in model space
--face-limit <n>  output face limit (≥100)
--ref-image <file-or-url>  reference image for semantic guidance
--model <v>  P2-20260801 (only supported value)
```

Studio backend: Studio supports bounding-box editing with exactly six finite coordinates (flat/nested array or slash/comma/semicolon/space text). Without --ref-image, compress=geometry requires native P2 GLB Meshopt validation even with --no-download. With --ref-image and -p accept_variable_cost=true, a restricted static, untextured GLB uses Studio 3D Lab with the exact model and image attached. This route verifies preserved outside triangles, normals/materials, no added outside geometry and a changed region; semantic fidelity remains an AI result. It uses variable web-account billing, not the fixed P2 engine or its price. Explicit face_limit/model/compression, skins, animations and textured sources have no verified combined mapping. Preparation receipts and the Lab job persist; unknown writes are never repeated. --no-wait returns the submitted task after preparation; --no-download still verifies the actual GLB when complete. Studio extension -p source_representation=studio_normalized explicitly selects the actual Studio representation of a verified Lab mesh-edit or explicitly projected-segmentation task. Projected sources additionally preserve every original named face group. The original Lab artifact/proof stays unchanged; centering/scaling, quantized normals and metadata differences are frozen and disclosed. A new selected source is copied from its exact historical operator; the copied GLB bytes are verified before downstream processing, with a separate possible cost. This new copy plus processing requires waiting; old requests keep their original frozen layout. Omit this selection to retain the original source restriction. Unverified Lab tasks and processing combinations are not implicitly accepted.

## `ai-modeling task`

query, list, and watch tasks

## `ai-modeling task get <task-id>`

fetch one task (accepts @last/@name)

```text
--download  download artifacts if successful
-o, --out <dir>  output directory for --download
--timeout <seconds>  timeout in seconds
--step  include pipeline step details
```

已受理任务沿原本地 task 和远端回执查询。Canvas Agent、续答、Lab 及 Holy 节点 stop/retry 若为 `outcome_unknown`，`ai_modeling_job_reconcile` 拒绝用手填 Turn/Lab ID 猜绑，返回 `RECONCILE_UNVERIFIABLE`；远端 ID 存在、同画布或相近时间均不能证明原提交归属。保留原请求与上下文，不新建任务代替恢复。

## `ai-modeling task watch <task-id>`

block until a task finishes (progress on stderr; stdout carries only the final JSON)

```text
--download  download artifacts on success
-o, --out <dir>  output directory for --download
--timeout <seconds>  timeout in seconds
--step  include pipeline step details
```

## `ai-modeling task list [task-ids...]`

batch-query tasks (default: recent history)

```text
--limit <n>  how many from history [default: 10]
```

## `ai-modeling history`

recent tasks created by this CLI (@name references)

```text
--limit <n>  rows [default: 20]
```

## `ai-modeling canvas`

Studio Canvas projects, graph edits and result selection

## `ai-modeling canvas audit`

Audit a saved Canvas after an Agent conversation: verify exact turn/session ownership, node state, expected assets and a stable read snapshot. Read-only; does not approve REVIEW nodes, download files or accept visual quality. Inspect original artifacts before delivery.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--session-id <value>  sessionId
--turn-id <value>  turnId
--node-ids <value>  Exact nodes to inspect; omitted means the whole saved graph, up to 100 nodes.
--expect <value>  expect
```

`expect` 为 JSON 数组，每项包含 `nodeId`，可选 `kind`（image/model/animation/html）、`minAssets`（默认1）及明确的 `assetIds`。报告区分执行状态、资产就绪和仍待 Agent 审阅的内容；没有预期时不判定产物齐备。`html` 候选优先取当前 HolyMolly 结果 URL 路径的后缀，路径无后缀时才取 `filename`；`.html/.htm` 只证明候选分类，查询参数不参与后缀判定。仍须下载原件并分别检查依赖、试玩和费用；不能交给图片/模型 `artifact-inspect` 冒充游戏验证。`canvas review` 是批准工作流节点的写操作，不能代替该检查。验收流程见[可组合流水线](../skills/ai-modeling/references/pipelines.md)。

审计把 `run_attribution`（运行所属回合）、`current_selection_association`（当前选中资产）和 `turn_attribution`（产物生成来源）分开。生成来源还须匹配已验证原件命名空间中的准确 task/step；选择旧结果不证明本轮生成。支持的图片、HD 基础模型、贴图模型和 Holy HTML 路径以兼容表为准；其它来源或复杂运行返回 unknown。`scope.turn_artifact_attribution_scope=selected_generated_outputs` 只覆盖所选产物，费用归属和流水核对另列。

## `ai-modeling canvas watch`

stream bounded Agent or Lab events as NDJSON; resume using after_id

```text
--kind <value>  kind (agent|lab)
--id <value>  Agent turn ID or Lab job ID.
--after-id <value>  Resume strictly after this event ID.
--wait-seconds <value>  wait_seconds
--max-events <value>  max_events
```

## `ai-modeling canvas upload <file>`

upload a Canvas image, model or Lab video; optionally wait for the input asset to be ready

```text
--project-id <id>  Canvas project ID
--transformation <value>  Model import transform as 16 column-major numbers; omitted means the unrotated identity matrix.
--use-original-uv [boolean]  Preserve model UVs as the Canvas Upload Card does (default true). Model inputs only.
--wait-seconds <value>  Wait up to this many seconds for the registered input asset; 0 returns its actual initial status.
```

## `ai-modeling canvas events`

Read bounded real-time Agent or 3D Lab events, returning a resume cursor. Does not start a task.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--kind <value>  kind (agent|lab)
--id <value>  Agent turn ID or Lab job ID.
--after-id <value>  Resume strictly after this event ID.
--wait-seconds <value>  wait_seconds
--max-events <value>  max_events
```

## `ai-modeling canvas turn-plan`

Prepare a new Canvas composer message or an exact failed-user-message retry. Preserves attachment markers/order, verifies saved node assets and READY inputs, applies proven saved-copy bindings and checks Unicode/new-composer limits. Does not upload, save, submit or accept variable billing.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--session-id <value>  sessionId
--action <value>  action (new|retry)
--agent-mode <value>  agentMode (control|auto)
--capabilities <value>  Explicit Studio Agent capabilities. Only holy_molly is mapped from the observed webpage protocol; omit for ordinary chat. Not inferred from attachments or target nodes.
--node-id <value>  Exact saved target node for a new message; omit to request a new game.
--text <value>  text
--attachments <value>  attachments
--source-turn-id <value>  sourceTurnId
--source-message-id <value>  Exact historical USER message ID for retry, not an assistant card ID.
--expected-revision <value>  expectedRevision
--copied-nodes <value>  Pre-save copied nodes from an already completed canvas save. Requires its expectedRevision; resolves old output IDs without saving again.
```

空正文仅支持新消息显式指定 `holy_molly`、准确已保存 Holy 节点且不含普通附件；只选择插件不能空提交。`action=retry` 读取准确 FAILED 回合的最后 USER 消息；Holy 目标只从服务 `cardJson.capabilities:["holy_molly"]` 与有效 `targetNodeId` 恢复，并核对目标仍属于当前保存图且为 Holy 节点。返回的 `source_target_node_id` 对应准备参数 `node_id`；缺目标仍以 `retry_holy_molly_target_unknown` 阻止准备，不允许调用方覆盖历史。合法 FAILED 的目标恢复、新回合创作及网页玩法已有实测正例；准备本身不提交，实际创作须用新请求身份和独立费用授权。如原任务在本机有准确终态 job，可显式 `redo JOB_ID --request-id NEW_INTENT` 发起新创作，保留原目标和附件，但会按新任务计费。新消息的定向修改传准确 `nodeId`；网页以新版本节点交付并保留原节点，验收须跟随本轮 turn/run/新节点及资产。

## `ai-modeling canvas turn-stop-plan`

Prepare the webpage Agent stop sequence for an exact Canvas turn without submitting writes.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--turn-id <value>  turnId
--expected-revision <value>  expectedRevision
--max-messages <value>  maxMessages (1–2000, default 500)
--max-runs <value>  maxRuns (1–500, default 100)
```

返回 `stages[].actions` 的准确工具与参数。活动回合先请求 `turn-cancel`，读回明确 CANCELLED 后，再重新准备仍属于该回合的活动 `run-stop`；每次停止后重新查询状态。它核对两次发现快照、画布/会话/回合及逐个运行身份，发现变化、分页或身份不全时返回 `ready:false` / `incomplete:true`。`coverage.history_complete:null`：当前返回范围不等于完整历史。DONE/FAILED 回合仍有运行时明确报告，不把自然完成、停止受理或空运行列表当作停止成功。未知写回执不重放。

## `ai-modeling canvas answer-plan`

Prepare an exact Canvas selection or confirmation card answer, including grouped questions, Other, skip and confirmed parts. Checks turn/session/Canvas and selected node assets; does not submit or accept variable billing. Any answer, including Skip, may continue paid creation; use turn-cancel to cancel.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--turn-id <value>  turnId
--card-message-id <value>  cardMessageId
--action <value>  action (continue|skip)
--selected-option-ids <value>  Actual option IDs for selection cards, such as q1:__other__; do not use question IDs. Omit for normal confirmation cards.
--other-text <value>  Free text for a single selection or confirmation card.
--other-texts <value>  For grouped questions, map question IDs to text, for example {"q1":"a red panda"}; keys are not option IDs such as q1:__other__.
--confirmed-parts <value>  confirmedParts
```

按实际卡型填写参数：`selection` 用真实选项 ID，即使选项标签表示确认也一样；普通 `confirmation` 使用 `action:continue` 并省略 `selectedOptionIds`，修改意见只传 `otherText`，跳过用 `action:skip`。把确认卡显示的 option ID 填入 `selectedOptionIds` 会返回 `confirmation_does_not_select_options`；准备就绪后另行提交返回参数，Skip 仍可能继续收费创作。

## `ai-modeling canvas lab-plan`

Prepare Lab reuse_instructions with all current upstream assets or run_again with an exact historical prompt and original inputs. Does not submit or accept variable billing; pass ready parameters to canvas-lab separately.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--node-id <value>  nodeId
--revision <value>  revision
--mode <value>  mode (reuse_instructions|run_again)
--job-id <value>  The exact previous Lab job for run_again; never the latest job implicitly.
--history-limit <value>  historyLimit
--previous-input-binding <value>  A prior reuse_instructions input_binding; when supplied, unchanged inputs are not ready.
```

## `ai-modeling canvas extraction-plan`

Prepare SemanticSplit detection, auto/manual parts and per-result prompt edits from the saved webpage state. Returns graph-edit actions and separate run parameters; does not save or start a paid run.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--node-id <value>  nodeId
--revision <value>  revision
--action <value>  action (inspect|detect|generate|regenerate|retry)
--split-mode <value>  splitMode (auto|manual)
--amount <value>  amount
--parts <value>  parts
--prompt <value>  prompt
```

## `ai-modeling canvas texture-reference`

Prepare the webpage Texture reference inheritance for a saved node. Returns guarded canvas-edit actions from upstream images or the exact model version; save and run separately.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--node-id <value>  nodeId
--revision <value>  revision
```

## `ai-modeling canvas run-check`

Check the native Canvas run preconditions for selected nodes without creating a run.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--node-ids <value>  nodeIds
```

## `ai-modeling canvas access`

Check whether the current Studio account has Canvas access.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
```

## `ai-modeling canvas templates`

List Canvas templates and their reusable graphs.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--offset <value>  offset
--page-size <value>  pageSize
--scenario-id <value>  scenarioId
--placement <value>  placement (TEMPLATE_PLACEMENT_HOME|TEMPLATE_PLACEMENT_PROJECT)
```

## `ai-modeling canvas template-get`

Read one Canvas template graph.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--id <value>  id
```

## `ai-modeling canvas template-create`

Snapshot the saved Canvas graph into a reusable template, optionally guarding its revision. On an unknown response, query template-source before retrying; the template may be visible in the catalogue.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--source-project-id <value>  sourceProjectId
--source-canvas-id <value>  sourceCanvasId
--scenario-id <value>  scenarioId
--name <value>  name
--revision <value>  revision
```

## `ai-modeling canvas template-delete`

Delete an explicitly selected template you own; source projects remain separate.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--id <value>  id
```

## `ai-modeling canvas template-source`

Find the template authored from a source Canvas project; template is null when none exists.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--source-project-id <value>  sourceProjectId
```

## `ai-modeling canvas template-asset-get`

Read a model asset embedded in a Canvas template. Image assets may be unavailable through this endpoint.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--template-id <value>  templateId
--asset-id <value>  assetId
```

## `ai-modeling canvas tools`

Read live Canvas tools, parameters, ports and capacity, with CLI graph/execution mappings and explicit unmapped or retired nodes. Mapping is not a live execution or output-quality guarantee.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
```

## `ai-modeling canvas input-assets`

Inspect imported Canvas input assets and their readiness.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  projectId
--asset-ids <value>  assetIds
```

## `ai-modeling canvas sessions`

List creative planning sessions for a Canvas.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
```

## `ai-modeling canvas session-create`

Create a new ACTIVE creative session as the project default, archiving the previous session while preserving its history. Reload the project webpage to display it.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
```

## `ai-modeling canvas session-get`

Read a creative planning session.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--session-id <value>  sessionId
```

## `ai-modeling canvas session-history`

Cross-check returned session history against all six known turn statuses and exact turn details in two stable read snapshots. Reports missing, changed or reordered messages and local limits; does not claim complete server history. Read full messages with session-get.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--session-id <value>  sessionId
--max-turns <value>  maxTurns (default 50, maximum 100)
--max-messages <value>  maxMessages (default 2000, maximum 10000)
```

`observed_history_consistent` 核已返回数据，`history_complete` 保持 `null`；分页提示或超限用 `incomplete` 明确报告。

## `ai-modeling canvas session-mode`

Set the creative session mode.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--session-id <value>  sessionId
--mode <value>  mode (MODE_AUTO|MODE_CONTROL)
```

## `ai-modeling canvas bind-lab`

Attach a real Agent Astra/Lab request card to an existing Lab node. Use the card message ID, not an ordinary chat message.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--lab-node-id <value>  labNodeId
--message-id <value>  messageId
```

## `ai-modeling canvas turns`

List creative agent turns.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--session-id <value>  sessionId
--statuses <value>  statuses
```

## `ai-modeling canvas turn-get`

Read the creative agent result or required user choice.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--turn-id <value>  turnId
```

## `ai-modeling canvas turn-cancel`

Request cancellation of an explicitly selected creative turn. This command sends CancelTurn only; use turn-stop-plan before and after cancellation to identify any still-active owned runs and verify exact final states before sending StopRun.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--turn-id <value>  turnId
```

## `ai-modeling canvas lab-inputs`

Resolve a Lab node’s new upstream assets plus explicit attachments, excluding inputs already used in observed Lab history. Returns missing inputs without starting a job.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--node-id <value>  nodeId
--revision <value>  revision
--asset-ids <value>  Explicit attachments appended after new upstream assets; these are not removed by history deduplication.
--history-limit <value>  Optional bound for the Lab history query; omitted uses the same service default as the webpage.
```

## `ai-modeling canvas lab-jobs`

List 3D Lab creative jobs for a node.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--node-id <value>  nodeId
--limit <value>  limit
```

## `ai-modeling canvas lab-job-get`

Read a 3D Lab job, artifacts and observed charged credits.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--job-id <value>  jobId
```

## `ai-modeling canvas lab-job-cancel`

Cancel an explicitly selected 3D Lab creative job.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--job-id <value>  jobId
```

## `ai-modeling canvas lab-instructions`

Read server-managed Lab instructions with save-state validation and Copy/Reuse guidance. Does not save or execute instructions.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--node-id <value>  nodeId
```

返回保留原始 `taskInstructions`，另含 `validation`（状态、版本、异常及复用阻塞）和 `cli_support`。当前网页是服务管理说明的保存，Copy 读取 `saved.instructions`，Reuse 用 `canvas lab-plan --mode reuse_instructions`；没有独立手动保存写入。合法说明状态也不证明上游输入或整个 Lab 计划就绪。

## `ai-modeling canvas review`

Approve or revoke an image review checkpoint at an expected revision. Returns downstream node IDs; run those separately to continue.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--node-id <value>  nodeId
--revision <value>  revision
--approved [boolean]  approved
```

## `ai-modeling canvas projects`

List your Canvas projects.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--offset <value>  offset
--page-size <value>  pageSize
```

## `ai-modeling canvas create`

Create an empty Canvas project.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--name <value>  name
```

## `ai-modeling canvas get-project`

Inspect a Canvas project and its canvas ID.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  projectId
```

## `ai-modeling canvas rename`

Rename a Canvas project.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  projectId
--name <value>  name
```

## `ai-modeling canvas visibility`

Change Canvas project visibility.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  projectId
--visibility <value>  visibility (VISIBILITY_PRIVATE|VISIBILITY_PUBLIC|VISIBILITY_SHAREABLE)
```

## `ai-modeling canvas delete`

Delete an explicitly selected Canvas project.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  projectId
```

## `ai-modeling canvas from-template`

Create a Canvas from a template.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--template-id <value>  templateId
--name <value>  name
```

## `ai-modeling canvas append-template`

Append a template to a Canvas project.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  projectId
--template-id <value>  templateId
```

## `ai-modeling canvas copy-shared`

Copy an accessible shared Canvas project.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  projectId
```

## `ai-modeling canvas preview-share`

Preview which Canvas content can be shared.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  projectId
```

## `ai-modeling canvas get`

Read nodes, edges, revision and node execution state.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
```

## `ai-modeling canvas get-shared`

Read an accessible shared Canvas.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  projectId
```

## `ai-modeling canvas save`

Save a complete Canvas graph against an expected revision; conflicts are never overwritten.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
--project-id <value>  projectId
--client-id <value>  clientId
--revision <value>  revision
--nodes <value>  nodes
--edges <value>  edges
```

## `ai-modeling canvas node-assets`

List results for selected Canvas nodes.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--node-ids <value>  nodeIds
```

## `ai-modeling canvas asset-get`

Inspect one Canvas result asset.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--asset-id <value>  assetId
```

## `ai-modeling canvas asset-select`

Select one generated result for downstream nodes.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--node-id <value>  nodeId
--asset-id <value>  assetId
```

## `ai-modeling canvas batches`

List result batches for a Canvas node.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--node-id <value>  nodeId
```

## `ai-modeling canvas batch-select`

Select a generated result batch.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--node-id <value>  nodeId
--batch-id <value>  batchId
```

## `ai-modeling canvas save-to-studio`

Save Canvas results into the Studio asset library.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--asset-ids <value>  assetIds
```

## `ai-modeling canvas run-get`

Inspect one Canvas execution.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--run-id <value>  runId
```

## `ai-modeling canvas runs`

List execution history for a Canvas.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvasId
```

## `ai-modeling canvas run-stop`

Stop a selected Canvas execution.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--run-id <value>  runId
```

## `ai-modeling canvas graph-edit`

edit Canvas get JSON or saved graph state locally: patch parameters, copy, group, layout, expand images, replace uploads and undo/redo; save separately

```text
--graph-path <value>  Saved canvas get JSON, CLI result wrapper, SaveCanvas input or graph-edit state file.
--destination-path <value>  destination_path
--actions <value>  actions
--expected-canvas-id <value>  Require this exact Canvas identity in the input file; does not replace it.
--expected-project-id <value>  Require this exact project identity in the input file; does not replace it.
--expected-revision <value>  Require this exact saved revision in the input file; does not fetch or overwrite a newer one.
```

`patch_params` 使用 `set` 修改顶层键、`unset` 删除明确键，其余参数保留；原 `params` 仍是整体替换。输入及历史保留准确图身份和版本，输出的 `save_input` 独立交给 `canvas save`；本地编辑不隐式保存或运行。完整示例见[使用指南](usage.md)。

## `ai-modeling studio`

Studio-only asset, image, UV, motion and project operations

## `ai-modeling studio frontend-export`

export an exact Studio GLB or verified static binary FBX to GLB with the webpage engine and persistent lightweight authorization

```text
--request-id <id>  reuse the original frontend export intent and authorization
--input <json>  validated frontend export parameters as JSON [default: "{}"]
--project-id <value>  project_id
--operator-id <value>  Exact successful source operator; verified GLB or bounded static binary FBX. GLB supports webpage PBR factors and bounded static root/child TRS or scene deletion with per-file proof.
--destination-path <value>  Caller-selected GLB path; never overwrites. A retry may use another destination.
--format <value>  format
--forward-axis <value>  Explicit webpage forward axis. Binary FBX currently requires -y.
--pivot-to-center-bottom [boolean]  Explicit webpage bottom-center pivot switch. Binary FBX currently requires true.
--exclude-retarget [boolean]  Explicitly select no separate retarget motions. Source skeletons and embedded clips are retained; omitted or false keeps the separate-motion guard.
--name <value>  Filename passed to the converter; defaults to the frozen source project name.
--runtime-dir <value>  Optional directory containing the exact hash-pinned official JS/WASM runtime; engine files are not bundled.
--max-credits <value>  Maximum estimated credits for the persistent export-lite authorization.
```

结果补充：受限静态 GLB 的 root/child TRS、删除和显示名，以及 is_pbr 决定的 PBR factors 均依原 source metadata 冻结。显示名映射只按原网页引擎行为处理；`children_deleted` 可仅移除 scene 节点而保留已核原 mesh 字节。FBX、动画及复杂层级的支持范围分别见[网页前端导出](compatibility.md)，不由静态分支推及任意组合。

## `ai-modeling studio dcc-targets`

list Studio DCC Bridge targets, loopback ports and recommended export settings

## `ai-modeling studio dcc-status`

check the selected local DCC Bridge handshake without importing a file

```text
--target <value>  target (blender|unity|unreal|3ds_max|maya|godot|cocos|zbrush|metatailor|roblox|sketchup)
--port <value>  Optional loopback plugin port; default follows the Studio DCC preset.
--timeout-seconds <value>  timeout_seconds
```

## `ai-modeling studio dcc-send`

send an exported model to a local Studio DCC Bridge and wait for its import receipt

```text
--target <value>  target (blender|unity|unreal|3ds_max|maya|godot|cocos|zbrush|metatailor|roblox|sketchup)
--port <value>  Optional loopback plugin port; default follows the Studio DCC preset.
--timeout-seconds <value>  timeout_seconds
--file-path <value>  file_path
--file-id <value>  Correlation ID, not an upstream deduplication guarantee.
--name <value>  name
--wait-import [boolean]  Wait for file_loaded; false only confirms transfer.
```

## `ai-modeling studio brush-snapshot`

render a perspective Magic Brush input image and its column-major Studio camera matrix

```text
--model-path <value>  model_path
--destination-path <value>  destination_path
--blender <value>  blender
--size <value>  size
--azimuth <value>  azimuth
--elevation <value>  elevation
--fov <value>  fov
```

## `ai-modeling studio brush-parts`

list model part names and texture sizes for Magic Brush selection

```text
--model-path <value>  model_path
```

## `ai-modeling studio brush-bake`

project an image or color through a camera with legacy screen-space selection; use brush-paint for world-space brush strength and hardness

```text
--model-path <value>  model_path
--model-sha256 <value>  model_sha256
--destination-path <value>  Output JSON manifest; sibling .assets directory contains part textures and preview GLB.
--image-path <value>  image_path
--color <value>  color
--camera-matrix <value>  camera_matrix
--fov <value>  fov
--part-names <value>  part_names
--opacity <value>  opacity
--strokes <value>  Legacy screen-space selection, origin top-left; empty selects all front-facing surfaces. Use brush-paint for the webpage world-space brush and hardness.
```

## `ai-modeling studio brush-paint`

paint colors or projected images with world-space brush strength/hardness, fill parts, erase to source, and undo/redo; bake textures for retexture-apply

```text
--model-path <value>  Exact original textured GLB used by this edit history.
--history-path <value>  Prior brush-paint manifest; source and image hashes are checked before replay.
--destination-path <value>  New JSON manifest; sibling .assets directory holds textures and preview GLB.
--actions <value>  actions
```

## `ai-modeling studio brush-pick`

pick the original texture color at a UV coordinate or nearest 3D surface, without lighting; use a brush preview to pick edited colors

```text
--model-path <value>  model_path
--part-name <value>  part_name
--uv <value>  uv
--ray <value>  ray
```

## `ai-modeling studio segmentation-inspect`

inspect segment labels or pick the nearest face of an original static GLB

```text
--model-path <value>  Original static indexed GLB; never use a re-exported preview as the source.
--state-path <value>  Previous segmentation state JSON; must match the exact source GLB.
--source-metadata <value>  Source operator children_deleted, children_rename and children_transform_matrix; reused from state when omitted.
--ray <value>  ray
--mesh-name <value>  mesh_name
--face-index <value>  face_index
```

## `ai-modeling studio segmentation-edit`

select, brush, paint, merge, split, rename, undo or redo segment labels locally

```text
--model-path <value>  Original static indexed GLB; never use a re-exported preview as the source.
--state-path <value>  Previous segmentation state JSON; must match the exact source GLB.
--source-metadata <value>  Source operator children_deleted, children_rename and children_transform_matrix; reused from state when omitted.
--destination-path <value>  destination_path
--project-id <value>  Bind a new state to the Studio project; required before native saving.
--expected-operator-id <value>  Source operator from project-get; prevents applying stale edits.
--reserved-names <value>  Names reserved by project metadata (deleted/renamed/transformed parts).
--actions <value>  Ordered edit actions; empty creates the initial state.
```

## `ai-modeling studio segmentation-preview`

save a colored GLB preview of segment labels without changing the original model

```text
--model-path <value>  Original static indexed GLB; never use a re-exported preview as the source.
--state-path <value>  Previous segmentation state JSON; must match the exact source GLB.
--source-metadata <value>  Source operator children_deleted, children_rename and children_transform_matrix; reused from state when omitted.
--destination-path <value>  destination_path
```

## `ai-modeling studio uv-preview`

save a separate GLB preview highlighting one UV island on the 3D model

```text
--model-path <value>  Self-contained GLB with existing UV coordinates; no unwrap is performed.
--mesh-names <value>  Exact visible mesh node names; omit to inspect all meshes in the default scene.
--destination-path <value>  destination_path
--island-id <value>  island_id
```

## `ai-modeling studio uv-inspect`

inspect existing UV islands and utilization, optionally pick by UV coordinates or a 3D ray

```text
--model-path <value>  Self-contained GLB with existing UV coordinates; no unwrap is performed.
--mesh-names <value>  Exact visible mesh node names; omit to inspect all meshes in the default scene.
--pick <value>  pick
--ray <value>  Nearest 3D surface pick in GLB world coordinates, at the stored pose.
```

## `ai-modeling studio uv-layout`

export the current UV layout as a 1024px PNG locally, matching the browser UV Download function

```text
--model-path <value>  Self-contained GLB with existing UV coordinates; no unwrap is performed.
--mesh-names <value>  Exact visible mesh node names; omit to inspect all meshes in the default scene.
--destination-path <value>  destination_path
--highlight-island <value>  Optional viewer highlight; omit for the webpage Download output.
```

## `ai-modeling studio model-metadata-apply`

Apply Studio part transforms, visibility, names and PBR factors to the original GLB locally; keep materials and coordinates.

```text
--model-path <value>  model_path
--source-metadata <value>  source_metadata
--expected-source-sha256 <value>  expected_source_sha256
--destination-path <value>  destination_path
```

## `ai-modeling studio image-crop`

crop an image locally with an optional aspect ratio and fixed output size, saving PNG

```text
--image-path <value>  image_path
--destination-path <value>  destination_path
--left <value>  left
--top <value>  top
--width <value>  width
--height <value>  height
--aspect-ratio <value>  Optional crop ratio constraint (width / height); one source pixel of rounding is allowed.
--output-width <value>  Resize the cropped area to this width, matching the browser fixed-output crop.
--output-height <value>  output_height
```

## `ai-modeling studio local-convert`

convert a self-contained GLB locally with Blender; no Studio request or credits

```text
--model-path <value>  model_path
--blender <value>  blender
--destination-path <value>  destination_path
--format <value>  format (glb|fbx|obj|stl|usdz|3mf)
--source-metadata <value>  Apply Studio metadata to the original GLB before conversion; do not use an already edited export.
--part-names <value>  Keep only these exact mesh/node names from the exported GLB, using local processing.
--texture-format <value>  Local texture encoding: OBJ/FBX support all listed formats; GLB PNG/JPEG/WEBP; USDZ PNG.
--scale-factor <value>  scale_factor
--pivot-to-center-bottom [boolean]  pivot_to_center_bottom
--flatten-bottom [boolean]  flatten_bottom
--flatten-bottom-threshold <value>  flatten_bottom_threshold
```

## `ai-modeling studio artifact-inspect`

Inspect an exact local image or self-contained GLB/GLTF: decode content, hash bytes and check dimensions, geometry, textures, skeletons and animations against optional expectations. Read-only, offline; visual and prompt acceptance still require Agent review.

```text
--file-path <value>  Exact local image or self-contained GLB/GLTF to inspect.
--expected-sha256 <value>  Bind inspection to the SHA-256 returned by the original download.
--expect <value>  Explicit measurable requirements; never a visual quality verdict.
```

`expect` 为 JSON 对象，可含 `kind`、`width`、`height`、`min_width`、`min_height`、`min_triangles`、`max_triangles`、`min_meshes`、`min_materials`、`textured`、`skinned`、`animation_names`、`min_animations`。检查失败通过 `requirements_status` 和逐项结果返回；结构可读或机器条件通过不等于外观符合用户要求。支持范围与限制见[兼容说明](compatibility.md)。

## `ai-modeling studio model-inspect`

inspect embedded animation names, durations, mesh parts and skeletons for local previews

```text
--model-path <value>  model_path
```

## `ai-modeling studio snapshot`

render a model PNG with viewport modes, HDR, part expansion and an optional animation pose

```text
--model-path <value>  model_path
--blender <value>  blender
--destination-path <value>  destination_path
--size <value>  size
--azimuth <value>  azimuth
--elevation <value>  elevation
--projection <value>  projection (orthographic|perspective)
--fov <value>  Perspective vertical field of view in degrees.
--zoom <value>  Magnification relative to the fitted camera.
--pan-x <value>  Horizontal camera pan as a fraction of the fitted view width.
--pan-y <value>  Vertical camera pan as a fraction of the fitted view height.
--shading <value>  shading (original|flat|smooth)
--display-mode <value>  Local equivalents of Studio viewport modes; not pixel-identical shaders.
--wireframe [boolean]  wireframe
--skeleton [boolean]  Overlay projected joint connections from the evaluated pose.
--explode <value>  Separate mesh parts radially; 1 is fully expanded, without random spinning.
--grid [boolean]  Show a ground grid in the preview.
--pbr [boolean]  Temporary PBR switch; does not change source materials.
--metalness <value>  metalness
--roughness <value>  roughness
--environment <value>  Fetch a public Studio HDR preset at runtime; overrides the local three-light setup.
--environment-path <value>  Caller-provided Radiance HDR file instead of a preset.
--environment-intensity <value>  environment_intensity
--environment-rotation <value>  Environment rotation in degrees around the vertical axis.
--environment-auto-rotate [boolean]  Rotate HDR by 0.5 radians per second during video, matching Studio.
--animation <value>  Exact embedded animation name or zero-based index; omit for the binding pose.
--animation-time <value>  Seconds from the selected clip start.
--animation-speed <value>  animation_speed
--animation-loop [boolean]  Loop the clip, or hold its last pose when false.
```

## `ai-modeling studio showcase-video`

render Showcase Dark or Showcase Sweep MP4 locally with Blender and FFmpeg

```text
--model-path <value>  model_path
--blender <value>  blender
--destination-path <value>  destination_path
--size <value>  size
--azimuth <value>  azimuth
--elevation <value>  elevation
--projection <value>  projection (orthographic|perspective)
--fov <value>  Perspective vertical field of view in degrees.
--zoom <value>  Magnification relative to the fitted camera.
--pan-x <value>  Horizontal camera pan as a fraction of the fitted view width.
--pan-y <value>  Vertical camera pan as a fraction of the fitted view height.
--shading <value>  shading (original|flat|smooth)
--display-mode <value>  Local equivalents of Studio viewport modes; not pixel-identical shaders.
--wireframe [boolean]  wireframe
--skeleton [boolean]  Overlay projected joint connections from the evaluated pose.
--explode <value>  Separate mesh parts radially; 1 is fully expanded, without random spinning.
--grid [boolean]  Show a ground grid in the preview.
--pbr [boolean]  Temporary PBR switch; does not change source materials.
--metalness <value>  metalness
--roughness <value>  roughness
--environment <value>  Fetch a public Studio HDR preset at runtime; overrides the local three-light setup.
--environment-path <value>  Caller-provided Radiance HDR file instead of a preset.
--environment-intensity <value>  environment_intensity
--environment-rotation <value>  Environment rotation in degrees around the vertical axis.
--environment-auto-rotate [boolean]  Rotate HDR by 0.5 radians per second during video, matching Studio.
--animation <value>  Exact embedded animation name or zero-based index; omit for the binding pose.
--animation-time <value>  Seconds from the selected clip start.
--animation-speed <value>  animation_speed
--animation-loop [boolean]  Loop the clip, or hold its last pose when false.
--template <value>  template (showcase-dark|showcase-sweep)
--project-id <value>  Optional project QR; does not change visibility.
--duration <value>  duration
--fps <value>  fps
--camera-motion <value>  camera_motion (turntable|fixed)
--ffmpeg <value>  ffmpeg
```

## `ai-modeling studio share-image`

compose one of the six Studio share-image templates with a model preview and QR

```text
--destination-path <value>  destination_path
--size <value>  size
--azimuth <value>  azimuth
--elevation <value>  elevation
--projection <value>  projection (orthographic|perspective)
--fov <value>  Perspective vertical field of view in degrees.
--zoom <value>  Magnification relative to the fitted camera.
--pan-x <value>  Horizontal camera pan as a fraction of the fitted view width.
--pan-y <value>  Vertical camera pan as a fraction of the fitted view height.
--shading <value>  shading (original|flat|smooth)
--display-mode <value>  Local equivalents of Studio viewport modes; not pixel-identical shaders.
--wireframe [boolean]  wireframe
--skeleton [boolean]  Overlay projected joint connections from the evaluated pose.
--explode <value>  Separate mesh parts radially; 1 is fully expanded, without random spinning.
--grid [boolean]  Show a ground grid in the preview.
--pbr [boolean]  Temporary PBR switch; does not change source materials.
--metalness <value>  metalness
--roughness <value>  roughness
--environment <value>  Fetch a public Studio HDR preset at runtime; overrides the local three-light setup.
--environment-path <value>  Caller-provided Radiance HDR file instead of a preset.
--environment-intensity <value>  environment_intensity
--environment-rotation <value>  Environment rotation in degrees around the vertical axis.
--environment-auto-rotate [boolean]  Rotate HDR by 0.5 radians per second during video, matching Studio.
--animation <value>  Exact embedded animation name or zero-based index; omit for the binding pose.
--animation-time <value>  Seconds from the selected clip start.
--animation-speed <value>  animation_speed
--animation-loop [boolean]  Loop the clip, or hold its last pose when false.
--model-path <value>  model_path
--image-path <value>  image_path
--blender <value>  blender
--template <value>  template (retro-window|modern-game|blister|pixel-game|classic-game|germany)
--project-id <value>  Model project ID used in the share QR. Visibility is not changed.
```

## `ai-modeling studio share-templates`

list supported Studio share-image templates and local video capabilities

## `ai-modeling studio motion-presets`

list Studio preset animations by skeleton and category (offline catalogue)

```text
--rig-type <value>  rig_type (aquatic|avian|biped|hexapod|octopod|quadruped|serpentine)
--category <value>  category (basic|interactive|scene_specific|emotional|combat)
```

## `ai-modeling studio asset-download`

download an existing Studio or Canvas asset, Lab file or UV layout without a new task

```text
--kind <value>  kind (image|model|motion|uv_layout|segmentation_preview|template_model|template_image|canvas_input|canvas_node|lab_artifact|lab_input)
--id <value>  id
--output-index <value>  output_index
--operator-id <value>  Exact model version or applied motion; required for motion, uv_layout and segmentation_preview.
--current-operator-id <value>  Original UV context model version, required for uv_layout.
--template-id <value>  Source Canvas template, required for template_model or template_image.
--canvas-id <value>  Source saved Canvas, required for canvas_input.
--node-id <value>  Exact source node, required for canvas_input, canvas_node and template_image.
--job-id <value>  Remote Lab job ID for lab_artifact or lab_input; not a local CLI job ID.
--destination-path <value>  destination_path
```

## `ai-modeling studio project-edit`

save project metadata as a recoverable task against the expected model version

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--children-deleted <value>  children_deleted
--children-rename <value>  children_rename
--children-transform-matrix <value>  children_transform_matrix
--material-factor <value>  material_factor
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--expected-metadata <value>  Previously read metadata for a local conflict check; upstream has no atomic compare-and-swap.
--replace [boolean]  Restore supplied maps as a complete edit snapshot, including empty maps.
--children-visibility <value>  Original mesh name → visible; false deletes, true restores without replacing unrelated selections.
--export-edits <value>  export_edits
```

## `ai-modeling studio export-lite`

record lightweight export authorization/counting; creates no file (use local-convert)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--operator-id <value>  operator_id
--format <value>  format (glb|fbx|obj|stl|usdz|3mf)
--public-model [boolean]  public_model
```

## `ai-modeling studio refine-submit`

submit a human refinement request; receipt is not delivery, and payment is not automatic

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--requirement <value>  requirement
--accept-variable-cost [boolean]  Submit a human-service request; Studio determines allowance/payment. Does not pay automatically.
```

## `ai-modeling studio export-batch`

export owned projects in one native batch, preserving individual receipts

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--projects <value>  projects
--format <value>  format (glb|fbx|obj|stl|usdz|3mf)
--texture-size <value>  texture_size
--texture-packaging <value>  texture_packaging (embedded|zip)
--fbx-preset <value>  fbx_preset (blender|3dsmax|mixamo)
--export-orientation <value>  export_orientation (+x|-x|+y|-y)
--pack-uv [boolean]  pack_uv
--export-vertex-colors [boolean]  export_vertex_colors
```

## `ai-modeling studio canvas-node-stop`

request stopping an active saved HolyMolly node at the checked run and revision; verify the original node execution stopped, without cancelling already incurred charges

The observed response acknowledges the exact original `runId` with `status:"accepted"`. The CLI stores an `accepted_run` receipt and polls that run; a separate turn receipt retains its own identity checks. Acceptance, `stopRequestedTime`, or a `stopping` event does not prove completion. An original node ending DONE or FAILED reports `STOP_NOT_CONFIRMED`; a replaced execution reports `STOP_STATE_UNAVAILABLE`. Unknown prior submissions remain unresolved and must not be replayed.

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvas_id
--node-id <value>  node_id
--revision <value>  Current saved Canvas revision as a decimal string.
--expected-run-id <value>  Exact run currently attached to this saved HolyMolly node. These guards are checked before sending; the upstream node RPC has no atomic revision/run condition.
```

## `ai-modeling studio canvas-node-retry`

retry a saved HolyMolly node only when Studio marks its terminal run retryable; explicitly accept variable billing and audit the returned turn and game separately

This native node operation is separate from retrying a failed Agent message with `canvas turn-plan --action retry`. No eligible live `retryable:true` node example has passed acceptance yet; a successful historical message retry does not establish native node Retry support in that account state.

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--accept-variable-cost [boolean]  Accept Studio variable billing; no estimate or hard spending limit is available.
--canvas-id <value>  canvas_id
--node-id <value>  node_id
--revision <value>  Current saved Canvas revision as a decimal string.
--expected-run-id <value>  Exact run currently attached to this saved HolyMolly node. These guards are checked before sending; the upstream node RPC has no atomic revision/run condition.
```

## `ai-modeling studio canvas-turn`

start a Canvas agent turn with explicitly accepted variable cost; capabilities=["holy_molly"] opts into the webpage game workflow, with materials in refs and an optional game node_id; audit exact outputs before delivery

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--accept-variable-cost [boolean]  Accept Studio variable billing; no estimate or hard spending limit is available.
--session-id <value>  session_id
--text <value>  Message text. Empty text requires explicit holy_molly capability, an existing HolyMolly node_id and no ordinary asset attachments.
--mode <value>  mode (control|auto)
--capabilities <value>  Explicit Studio Agent capabilities. Only holy_molly is mapped from the observed webpage protocol; omit for ordinary chat. Not inferred from attachments or target nodes.
--node-id <value>  node_id
--attachment-ids <value>  attachment_ids
--refs <value>  Ordered attachment references preserving names, kinds and source nodes. Derives attachment_ids when omitted; if supplied, attachment_ids must match refs in the same order.
--attachment-rebindings <value>  Local-only saved-copy mappings returned by turn-plan. Each old marker must map to a current refs node_id + asset_id; used only for character counting and never sent to CreateTurn.
```

## `ai-modeling studio canvas-continue`

continue a Canvas agent turn using the requested user choice; completion still requires Canvas and artifact acceptance

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--accept-variable-cost [boolean]  Accept Studio variable billing; no estimate or hard spending limit is available.
--turn-id <value>  turn_id
--remote-request-id <value>  Optional stable idempotency key for this answer (CLI --remote-request-id). Defaults to the persisted local job UUID. Do not reuse the original turn.requestId.
--selected-option-ids <value>  selected_option_ids
--confirmed-parts <value>  confirmed_parts
--other-text <value>  Answer a single-question Other/input option; select its option ID (usually __other__) too.
--other-texts <value>  other_texts
--text <value>  Extra composer text; the remote agent may ignore this. Use other_text/other_texts for free-text selection answers.
--attachment-ids <value>  attachment_ids
```

## `ai-modeling studio canvas-lab`

run a 3D Lab instruction against explicitly attached assets

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--accept-variable-cost [boolean]  Accept Studio variable billing; no estimate or hard spending limit is available.
--node-id <value>  node_id
--prompt <value>  prompt
--asset-ids <value>  Explicit input asset IDs. A graph edge alone does not attach a model to the Lab request.
```

## `ai-modeling studio canvas-run`

run selected Canvas nodes with explicit inputs and a checked graph revision

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--canvas-id <value>  canvas_id
--revision <value>  revision
--node-ids <value>  node_ids
--action <value>  action (generate|regenerate|retry|detect)
--parts <value>  parts
```

## `ai-modeling studio modification`

save per-triangle segment labels and names from inline arrays or a bound segmentation state file

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--accept-variable-cost [boolean]  explicitly accept an unquoted Studio charge under a current reviewed snapshot; omit max-credits
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--indices-path <value>  Segmentation editor state JSON, bound to this project/operator; alternative to inline labels.
--part-indices <value>  Mesh name → one segment label (0–255) for each triangle in original order.
--part-indices-name <value>  Segment label → part display name.
```

无预报价合同及预算限制见[费用、任务与恢复](usage.md#费用任务与恢复)。

## `ai-modeling studio retry`

request a free project generation retry only when Studio reports retry_info.can_retry=true

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
```

## `ai-modeling studio remesh`

retopologize a model with triangle, quad or Smart Mesh settings

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--face-limit <value>  face_limit
--quad [boolean]  quad
--smart-poly [boolean]  smart_poly
--part-name-list <value>  part_name_list
--bake [boolean]  bake
```

## `ai-modeling studio segment`

split a model into generated parts

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--model-version <value>  model_version (v1.0-20250506|v2.0-20260430)
--segmentation-granularity <value>  segmentation_granularity (simple|balanced|detailed)
--prompt <value>  prompt
```

## `ai-modeling studio resegment`

resegment the current model using a level or custom prompt

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--model-version <value>  model_version
--segmentation-granularity <value>  segmentation_granularity (simple|balanced|detailed)
--prompt <value>  prompt
--operator-id <value>  operator_id
```

## `ai-modeling studio complete`

complete or cap selected model parts

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--part-names <value>  part_names
--completion-mode <value>  completion_mode (ai_completion|quick_cap)
```

## `ai-modeling studio local-edit`

refine a bounded region of a P2 model

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--source-operator-id <value>  source_operator_id
--face-limit <value>  face_limit
--bbox <value>  bbox
```

## `ai-modeling studio import-model`

import an external model into the Studio workspace

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--accept-variable-cost [boolean]  explicitly accept an unquoted Studio charge under a current reviewed snapshot; omit max-credits
--model-path <value>  model_path
--transform-matrix <value>  transform_matrix
--use-original-uv [boolean]  use_original_uv
```

无预报价合同及预算限制见[费用、任务与恢复](usage.md#费用任务与恢复)。

## `ai-modeling studio uv-generate`

generate or retry a UV candidate without applying it

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--current-operator-id <value>  current_operator_id
--action <value>  action (generate|retry)
```

## `ai-modeling studio uv-commit`

apply a generated UV candidate after checking the current model version

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--current-operator-id <value>  current_operator_id
--candidate-operator-id <value>  candidate_operator_id
```

## `ai-modeling studio retexture`

generate a Magic Brush image preview from a camera-aligned snapshot

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--prompt <value>  prompt
--image-path <value>  image_path
--camera-matrix <value>  camera_matrix
--strength <value>  strength
```

## `ai-modeling studio retexture-apply`

apply baked per-part Magic Brush textures to the current model (may consume credits)

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--accept-variable-cost [boolean]  explicitly accept an unquoted Studio charge under a current reviewed snapshot; omit max-credits
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--image-map <value>  image_map
```

无预报价合同及预算限制见[费用、任务与恢复](usage.md#费用任务与恢复)。

## `ai-modeling studio motion`

generate an animation from a motion description

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--segments <value>  segments
```

## `ai-modeling studio copy`

save a model version as a new Studio project

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--operator-id <value>  operator_id
```

## `ai-modeling studio image-process`

generate multiviews, split, upscale or regenerate an existing image

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--action <value>  action (multiview|split|upscale|regenerate|regenerate_multiview)
--asset-id <value>  asset_id
--image-path <value>  image_path
--output-index <value>  Asset image index for multiview, split or upscale; regeneration uses the whole asset.
--model-version <value>  For regenerate only: assert the original image model, without changing it.
```

## `ai-modeling studio image`

text / reference images → generated images; defaults to GPT Image 2.5

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--prompt <value>  prompt
--model-version <value>  model_version (flux.1_dev|flux.1_kontext_pro|gemini_2.5_flash_image_preview|gemini_3.1_flash_image_preview|gemini_3_pro_image_preview|gpt_4o|gpt_image_1.5|gpt_image_2|gpt_image_2.5_sunburst|midjourney)
--amount <value>  amount
--resolution <value>  resolution (1K|2K|4K)
--scale <value>  Aspect ratio. auto omits the field like Studio with no selected reference-image ratio; it does not guarantee pixel dimensions. Omitted keeps 1:1 for existing request compatibility.
--t-pose [boolean]  t_pose
--sketch-to-render [boolean]  Render the primary image as a sketch.
--template-id <value>  template_id
--template-name <value>  Resolve a named template from the current Studio template catalog.
--image-paths <value>  Ordered image files. GPT Image 2 and 2.5 Sunburst support 16 without a primary or 15 additional with a primary (16 total); other models retain at most 10 additional references.
--image-path <value>  image_path
--image-asset <value>  image_asset
--image-assets <value>  Ordered image assets. GPT Image 2 and 2.5 Sunburst support 16 without a primary or 15 additional with a primary (16 total); other models retain at most 10 additional references.
--image-sources <value>  Ordered references mixing image_path and asset_id/output_index; primary stays separate. GPT Image 2 and 2.5 Sunburst support 16 without a primary or 15 additional with a primary (16 total); other models retain at most 10 additional references.
```

## `ai-modeling studio model`

text / image / multiview / native image batch → 3D models; P2 supports face-count variations

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--mode <value>  mode (text|image|multiview|batch)
--prompt <value>  Text mode only; image inputs have no verified text-prompt mapping.
--negative-prompt <value>  Text-to-model negative guidance; advisory, not a guaranteed constraint.
--export-uv [boolean]  Unwrap UVs during model generation; false returns untextured geometry without UVs when texture=false.
--image-path <value>  image_path
--image-asset <value>  image_asset
--image-assets <value>  image_assets
--image-paths <value>  image_paths
--image-sources <value>  Mixed file/asset references for batch or multiview; multiview order is front, left, back, right with null slots.
--model-version <value>  model_version (v3.1-20260211|v3.0-20250812|v2.5-20250123|Nexus-v1.0-20260214|Nexus-v2.0-20260801)
--face-limit <value>  face_limit
--variations <value>  P2 face-count variations in one native submission; replaces top-level face_limit.
--texture [boolean]  texture
--pbr [boolean]  pbr
--texture-quality <value>  Used when texture=true; the standard default is inactive otherwise.
--geometry-quality <value>  HD v3.1 only; the standard default is inactive for other model versions.
--quad [boolean]  quad
--visibility <value>  visibility (private|public|shareable)
--smart-poly [boolean]  smart_poly
--generate-parts [boolean]  generate_parts
--generate-parts-level <value>  Used when generate_parts=true: coarse/simple, medium/balanced, fine/detailed.
--t-pose [boolean]  Generate a T-pose reference in text-to-model mode.
--symmetry [boolean]  P2 symmetry override. Omit to check the audited primary/front image like Studio; the 1.5s precheck falls back to false. Text/batch modes use false.
--model-seed <value>  model_seed
--texture-seed <value>  texture_seed
--enable-image-autofix [boolean]  Image and batch modes only.
--texture-alignment <value>  Used when texture=true; the default is inactive otherwise.
--delight [boolean]  Used when texture=true; the default is inactive otherwise.
```

## `ai-modeling studio texture`

generate model textures, PBR maps or higher-resolution textures

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--prompt <value>  prompt
--texture-quality <value>  Generate/upscale quality; PBR uses its fixed engine and ignores the standard default.
--texture-seed <value>  Native texture seed. Studio stores it, but repeated seeds did not reproduce identical textures in live verification.
--action <value>  action (generate|pbr|upscale)
--texture-alignment <value>  Generate only; the default is inactive for PBR/upscale.
--image-path <value>  image_path
--image-asset <value>  image_asset
--image-paths <value>  image_paths
--image-assets <value>  image_assets
--style-image-path <value>  Independent style image, billed separately.
--style-image-asset <value>  style_image_asset
--style-preset <value>  style_preset (mecha_pop|heritage|mecha|wood)
--part-names <value>  Original mesh names to texture; empty selects the entire model.
--delight [boolean]  Generate only; the default is inactive for PBR/upscale.
```

## `ai-modeling studio rig`

bind a supported skeleton to a model

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--model-version <value>  model_version (v3.0-20260909|v2.5-20260210|v1.0-20240301)
--rig-type <value>  rig_type (biped|quadruped|hexapod|octopod|avian|serpentine|aquatic|others|auto)
--force [boolean]  force
--skeleton-preset <value>  skeleton_preset (tripo|actorcore|mixamo|unreal|vrm|unity)
```

## `ai-modeling studio animate`

apply a preset or generated motion to a rigged model

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--animation <value>  animation
--motion-asset-id <value>  motion_asset_id
--rig-type <value>  Must match a selected preset family; defaults to that family, or biped for generated motion.
```

## `ai-modeling studio export`

export a model or animation in a supported Studio format

```text
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--bake [boolean]  Verify an existing static native GLB preserves original texture bytes and basic PBR/UV values; advanced materials, animation and material baking are not supported.
--public-model [boolean]  Use the Studio public-model export route for an accessible model you do not own.
--format <value>  format (glb|fbx|obj|stl|usdz|3mf)
--with-animation [boolean]  with_animation
--animations <value>  Completed animation remote_ids.operator_id values belonging to this project, not preset names.
--texture-size <value>  Native texture size cap in pixels; Studio may retain smaller source textures without upscaling.
--texture-packaging <value>  texture_packaging (embedded|zip)
--animate-in-place [boolean]  animate_in_place
--fbx-preset <value>  fbx_preset (blender|3dsmax|mixamo|bake_scale)
--export-orientation <value>  export_orientation (+x|-x|+y|-y)
--pack-uv [boolean]  pack_uv
--enable-bake-animation [boolean]  enable_bake_animation
--bake-animation-frame <value>  bake_animation_frame
--export-vertex-colors [boolean]  export_vertex_colors
--part-names <value>  Keep only these exact mesh/node names from the exported GLB, using local processing.
--texture-format <value>  Local texture encoding: OBJ/FBX support all listed formats; GLB PNG/JPEG/WEBP; USDZ PNG.
--scale-factor <value>  scale_factor
--pivot-to-center-bottom [boolean]  pivot_to_center_bottom
--flatten-bottom [boolean]  flatten_bottom
--flatten-bottom-threshold <value>  Local bottom clipping depth in model units after scale (default 0.01).
```

## `ai-modeling studio gallery-feed`

Browse the Studio gallery feed using its continuation token.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--page-size <value>  page_size
--page-token <value>  page_token
```

## `ai-modeling studio gallery-browse`

Search and filter gallery models by category, topology, material, use case and sort order.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--page-size <value>  page_size
--page-token <value>  page_token
--query <value>  query
--category <value>  category (featured|abstract / symbol|creatures & animals|architecture|character|clothing|food|furniture|machine|nature & environment|props|vehicle|weapon)
--model-type <value>  model_type (all|pbr|rigged|segmented|smart_low_poly|smart_mesh)
--use-case <value>  use_case (all|3d_printing)
--sort <value>  sort (recommended|newest|most_likes)
--featured-only [boolean]  featured_only
```

## `ai-modeling studio collection-list`

List or search the models in your Studio collection.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--page-size <value>  page_size
--page-token <value>  page_token
--query <value>  query
```

## `ai-modeling studio library-list`

List your models or models in the active team workspace, filtered by operation type.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--page-size <value>  page_size
--page-token <value>  page_token
--scope <value>  scope (mine|team)
--type <value>  type (all|rigged|smart_mesh|textured|untextured)
```

## `ai-modeling studio gallery-item`

Read a gallery item with the same full detail view used by Studio.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--item-id <value>  item_id
```

## `ai-modeling studio library-user-items`

List accessible model and collection cards for a specified Studio creator.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--page-size <value>  page_size
--page-token <value>  page_token
--user-id <value>  user_id
```

## `ai-modeling studio export-limit`

Read the current Studio export allowance and account restrictions before exporting.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
```

## `ai-modeling studio assets-filter`

Filter Studio assets by library and model type using offset pagination.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--asset-type <value>  asset_type (mine|collected|team)
--type <value>  type (all|rigged|smart_mesh|textured|untextured)
--locale <value>  locale
--offset <value>  offset
--size <value>  size
```

## `ai-modeling studio gallery-tag`

Browse a gallery tag with model filters, sorting and continuation tokens.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--tag <value>  tag
--locale <value>  locale
--size <value>  size
--page-token <value>  page_token
--model-type <value>  model_type (all|pbr|rigged|segmented|smart_low_poly|smart_mesh)
--sort-by <value>  sort_by (recommended|newest|most_likes)
```

## `ai-modeling studio motion-recent`

List recently used retarget motions for your Studio account.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
```

## `ai-modeling studio symmetry-check`

Check image symmetry before P2 modelling using an uploaded file token or an existing image asset.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--file-token <value>  file_token
--asset-id <value>  asset_id
--output-index <value>  output_index
```

## `ai-modeling studio refine-history`

Read your human refinement service requests; does not place an order.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--page-num <value>  page_num
--page-size <value>  page_size
```

## `ai-modeling studio refine-allowance`

Read the remaining human refinement allowance; does not place an order.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
```

## `ai-modeling studio segmentation-prompt`

Analyze a model operator and suggest a segmentation prompt by part or color; does not segment it.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--operator-id <value>  operator_id
--mode <value>  mode (part|color)
--locale <value>  locale
```

## `ai-modeling studio project-metadata`

Edit part transforms, names, visibility and material factors against an expected model version.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--children-deleted <value>  children_deleted
--children-rename <value>  children_rename
--children-transform-matrix <value>  children_transform_matrix
--material-factor <value>  material_factor
--project-id <value>  project_id
--expected-operator-id <value>  expected_operator_id
--expected-metadata <value>  Previously read metadata for a local conflict check; upstream has no atomic compare-and-swap.
--replace [boolean]  Restore supplied maps as a complete edit snapshot, including empty maps.
--children-visibility <value>  Original mesh name → visible; false deletes, true restores without replacing unrelated selections.
```

## `ai-modeling studio project-related`

Find gallery models related to a project.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--limit <value>  limit
--locale <value>  locale
```

## `ai-modeling studio gallery-like`

Like a model in the Studio gallery.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--id <value>  id
```

## `ai-modeling studio gallery-unlike`

Remove your like from a Studio gallery model.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--id <value>  id
```

## `ai-modeling studio operation-cancel`

Request cancellation for a specific active operation.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--operator-id <value>  operator_id
--operation-type <value>  operation_type
--scene <value>  scene
```

## `ai-modeling studio image-templates`

List available Studio image templates.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
```

## `ai-modeling studio image-get`

Inspect an image asset and its individual outputs.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--asset-id <value>  asset_id
```

## `ai-modeling studio image-delete`

Delete selected image outputs from your library.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--items <value>  items
```

## `ai-modeling studio project-get`

Inspect a Studio project, optionally at a selected operator.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--operator-id <value>  operator_id
```

## `ai-modeling studio project-history`

List a project’s saved operation history.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
```

## `ai-modeling studio project-history-check`

Check whether project history can be restored.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
```

## `ai-modeling studio project-rename`

Rename your Studio project.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--name <value>  name
```

## `ai-modeling studio project-tags`

Set your project’s custom tags.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--tags <value>  tags
```

## `ai-modeling studio project-visibility`

Set your project visibility.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--visibility <value>  visibility (public|private|shareable)
```

## `ai-modeling studio project-restore`

Restore a selected project history version.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--operator-id <value>  operator_id
```

## `ai-modeling studio project-delete`

Delete explicitly selected projects you own.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-ids <value>  project_ids
```

## `ai-modeling studio uv-context`

Inspect UV candidates, active tasks and the next permitted action.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--current-operator-id <value>  current_operator_id
```

## `ai-modeling studio uv-apply`

Apply a completed UV candidate to the expected current model version.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--current-operator-id <value>  current_operator_id
--candidate-operator-id <value>  candidate_operator_id
```

## `ai-modeling studio retexture-get`

Inspect the generated Magic Brush preview.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--operator-id <value>  operator_id
```

## `ai-modeling studio retexture-images`

List Magic Brush preview images for a project.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
```

## `ai-modeling studio rig-check`

Check which skeleton type a model supports before rigging.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--model-version <value>  model_version (v3.0-20260909|v2.5-20260210|v1.0-20240301)
```

## `ai-modeling studio motion-get`

Inspect a generated motion asset.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--asset-id <value>  asset_id
```

## `ai-modeling studio motion-task`

Inspect one AI motion generation task.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--task-id <value>  task_id
```

## `ai-modeling studio motion-list`

List your generated motion assets.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
```

## `ai-modeling studio motion-active`

List your active AI motion tasks.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
```

## `ai-modeling studio motion-rename`

Rename a generated motion asset.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--asset-id <value>  asset_id
--title <value>  title
```

## `ai-modeling studio animation-remove`

Remove one applied animation from a project.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--project-id <value>  project_id
--model-operator-id <value>  model_operator_id
--retarget-operator-id <value>  retarget_operator_id
```

## `ai-modeling studio gallery-search`

Search the Studio model gallery.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--user-input <value>  user_input
--locale <value>  locale
```

## `ai-modeling studio gallery-collect`

Add a gallery model to your collection.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--id <value>  id
```

## `ai-modeling studio gallery-uncollect`

Remove a gallery model from your collection.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--id <value>  id
```

## `ai-modeling studio usage`

List Studio credit transactions.

```text
--input <json>  validated operation parameters as JSON [default: "{}"]
--page-num <value>  page_num
--page-size <value>  page_size
```

## `ai-modeling runtime`

Studio extension: verify or install the pinned website frontend engine locally

## `ai-modeling runtime status`

verify cached runtime files without network, login or directory creation

```text
--source-dir <dir>  check a supplied directory instead of the private cache
```

## `ai-modeling runtime install`

verify both official runtime files and install them without network or overwriting

```text
--source-dir <dir>  directory containing both exact official runtime filenames
```

## `ai-modeling skill`

install, inspect or remove bundled Agent Skill guidance

此组只管理本地指导文件，无需 Studio 账号。必须选择 `--target` 或 `--dir`，没有默认客户端。命名目标默认 `user` 范围，`golutra-agent` 仅支持并默认 `project`；`project` 使用当前目录或显式 `--project-dir`，不向上发现仓库。自定义 `--dir` 指技能父目录，最终目录为其 `ai-modeling/` 子目录，并与另三个位置选项互斥。Skill 目录与 Studio profile 无关。客户端目录、旧安装管理和操作步骤见[使用指南](usage.md#安装-skill)。

## `ai-modeling skill targets`

list supported clients, scopes and documented directories without changing configuration

离线列出客户端目标、用户/项目范围的目录规则及官方来源，同时返回 `default_target: null` 和全局 `default_scope: "user"`，各目标另有自己的 `default_scope`。此列表不表示客户端已安装或已加载 Skill，也不修改客户端配置。

## `ai-modeling skill install`

install or update bundled guidance while preserving user changes

```text
--target <name>  client directory convention; see skill targets
--scope <scope>  project or user scope (default: user; golutra-agent: project)
--project-dir <path>  existing project root; defaults to the current directory in project scope
--dir <path>  custom skills parent directory; installs its ai-modeling subdirectory
```

从当前运行包复制 Skill 及许可。新安装返回 `installed`，相同内容返回 `current`，未修改的受管理旧安装更新后返回 `updated`。用户新增、修改、删除文件或缺少管理记录时拒绝覆盖；`--yes` 不绕过冲突检查。

## `ai-modeling skill status`

verify installed guidance without creating directories or accessing an account

```text
--target <name>  client directory convention; see skill targets
--scope <scope>  project or user scope (default: user; golutra-agent: project)
--project-dir <path>  existing project root; defaults to the current directory in project scope
--dir <path>  custom skills parent directory; installs its ai-modeling subdirectory
```

返回 `not_installed`、`installed`、`unmanaged` 或 `modified`，并包含目标、范围、项目目录、`directory`、`installed_version`、`bundled_version`、`file_count` 和 `conflicts`。`installed` 表示文件与安装记录一致；与当前运行包内容是否相同由 `install` 再核对。查询不存在的目标不会创建目录。

## `ai-modeling skill uninstall`

remove only an unchanged installation managed by ai-modeling

```text
--target <name>  client directory convention; see skill targets
--scope <scope>  project or user scope (default: user; golutra-agent: project)
--project-dir <path>  existing project root; defaults to the current directory in project scope
--dir <path>  custom skills parent directory; installs its ai-modeling subdirectory
```

只移除本工具管理且未被修改的 Skill，成功返回 `uninstalled`；原本不存在时返回 `not_installed`。未管理或被修改的内容保留并返回 `SKILL_INSTALL_CONFLICT`。运行包、账号、任务与素材不受此命令管理。

## `ai-modeling assets`

inspect existing Studio models and images, including assets created on the website

## `ai-modeling assets list`

list account assets; follow next_offset to read another page

```text
--kind <kind>  model or image [default: "model"]
--offset <n>  first asset offset, from 0 to 1000000 [default: 0]
--limit <n>  assets per page, from 1 to 100 [default: 20]
```

联网读取当前 Studio 账号已有的模型或图像资产，包含网页创建的素材；无需先在本机任务历史中出现。沿用返回的 `next_offset` 翻页，值为 `null` 时结束。图像输出的索引用于 `studio asset-download`；如需删除图像，先通过 `studio image-get` 取得所选输出的精确键，不能把输出索引当作删除键。

## `ai-modeling print`

hand existing Studio exports to slicers or inspect print-shop requirements

## `ai-modeling print targets`

list slicers and current-platform handoff support

## `ai-modeling print plan [input]`

plan an existing OBJ or 3MF export handoff without opening or downloading

```text
--target <value>  target (local|bambu-studio|creality-print|orca-slicer|blueprint-studio|elegoo-slicer|anycubic|lychee-slicer)
--artifact-id <value>  Required when the export task contains multiple artifacts.
--output-dir <value>  Caller-selected download directory for unsupported protocols or launch fallback.
```

## `ai-modeling print open [input]`

hand off an existing OBJ or 3MF export; add --execute to open or download

```text
--target <value>  target (local|bambu-studio|creality-print|orca-slicer|blueprint-studio|elegoo-slicer|anycubic|lychee-slicer)
--artifact-id <value>  Required when the export task contains multiple artifacts.
--output-dir <value>  Caller-selected download directory for unsupported protocols or launch fallback.
--execute [boolean]  Explicitly allow opening the native slicer or downloading the original file. Omit to plan only.
```

## `ai-modeling print shop <project-id>`

show JuJuBit project sharing requirements; does not publish or place an order

## `ai-modeling setup`

check installation and connect a Studio session without copying tokens

```text
--check  only report diagnostics; do not start a login flow
--offline  check local prerequisites without reading credentials or using the network
--no-wait  return a bounded login flow without waiting
--browser-executable <path>  use an installed Chrome or Edge executable
--cdp-endpoint <url>  connect an explicitly authorized local browser
--timeout <seconds>  bound browser login up to 900 seconds
```

已认证时直接返回；交互连接沿用浏览器登录协调器，非交互输出有界登录状态。公共 `--no-open` 禁止自动打开窗口。已登录但依赖或价格检查失败时，`setup_status` 仍为 `needs_configuration`。

## `ai-modeling login`

sign in with your Studio browser session and continue automatically

```text
--paste  read a Studio session from stdin
--key <key>  API keys belong to the separate developer wallet and are rejected
--region <region>  Studio region (ov)
--no-wait  return the local login flow immediately; continue in the bounded background coordinator
--form  open the explicit manual session import form
--force  start browser login even when a saved session is present
--browser-executable <path>  use an explicit Chrome or Edge executable
--cdp-endpoint <url>  connect to an explicitly authorized local browser endpoint
--timeout <seconds>  bound the login flow, up to 900 seconds
```

## `ai-modeling logout`

remove the locally stored Studio session (current profile only)

```text
--profile <name>  log out a specific profile instead of the active one
```

## `ai-modeling whoami`

show the active Studio profile, session status and balance

## `ai-modeling use [profile]`

switch the active local profile; omit name to show it

## `ai-modeling config`

global config and directory context (.ai-modeling)

## `ai-modeling config list`

show effective config (keys masked)

## `ai-modeling config set <key> <value>`

set a local config value

## `ai-modeling config unset <key>`

remove a config value

## `ai-modeling config context [entries...]`

set directory context: ai-modeling config context output_dir=./assets

## `ai-modeling docs`

print bundled docs (default: the LLM/agent guide)

```text
--llm  print the agent-facing guide
--topic <name>  commands/<cmd>, examples/<scenario>, common-errors, or project guides
```

## `ai-modeling doctor`

diagnose environment, session, network, and terminal capabilities

```text
--offline  check prerequisites without reading credentials or using the network
--feature <name>  core, render, video or frontend-export [default: "core"]
--browser-executable <path>  diagnose an explicit Chrome/Edge executable
--cdp-endpoint <url>  validate an explicitly authorized local browser endpoint
```

离线诊断不创建任务状态；默认诊断还会验证保存的会话，不主动开始登录。可选依赖只在所选功能需要时成为必要条件。

## `ai-modeling pricing`

inspect, verify and install reviewed Studio prices

## `ai-modeling pricing status`

show price provenance and expiry without network or login

## `ai-modeling pricing verify <file>`

verify a reviewed pricing snapshot and optional official evidence

```text
--sha256 <digest>  independently trusted snapshot digest
--network  verify official evidence hashes over HTTPS
```

## `ai-modeling pricing import <file>`

atomically install a verified pricing snapshot

```text
--sha256 <digest>  independently trusted snapshot digest
--network  verify official evidence hashes over HTTPS
```

## `ai-modeling pricing update <url>`

download and verify a reviewed pricing snapshot using an independently trusted SHA-256

```text
--sha256 <digest>  required independently trusted snapshot digest
```

只接受直接 HTTPS 下载，不跟随重定向；核对快照摘要和官方证据摘要后原子安装，不读取账号、不生成任务、不自动延长有效期。证据字节一致不替代维护者对价格公式的审核。

## `ai-modeling update`

show npm update instructions; --check queries the latest published version

```text
--check  check the public npm version without changing this installation
```

`update` 默认离线显示当前版本与 npm 更新指引；`update --check` 查询 `@seekskyworld/ai-modeling` 的公开最新版本并返回版本比较和安装命令，不自动修改安装。查询失败返回 `UPDATE_CHECK_FAILED`，不假称已经最新。更新运行包后，在原目标更新 Skill，或更新 MCP 固定版本配置并重启。

## `ai-modeling view [target]`

preview a 3D result in the browser (model-viewer, local server)

```text
--keep  keep the preview server running until Ctrl+C
```

- `target`: task id, @last, @name, or a local .glb path (default @last)

## `ai-modeling redo [target]`

re-run a previous task with a fresh seed (same everything else)

```text
--seed <n>  explicit seed (model_seed, texture_seed or image_seed, by task type)
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

- `target`: task id or @reference (default @last)

Studio backend: Studio model and texture-generation tasks accept seeds; texture seeds do not guarantee deterministic output. Other operations repeat their original parameters; --seed is rejected for them. Reuse --request-id to resume the same redo intention. Verified frontend convert redo reconstructs the original complete parameters and exact source operator; an unknown result, missing cache or bare export-lite receipt cannot create a replacement authorization.

## `ai-modeling files`

file uploads

## `ai-modeling files upload <path>`

upload a local image/model and print the reusable Studio file_token

## `ai-modeling ai [request...]`

describe what you want in natural language; experts plan it, you confirm, it runs

```text
--wizard  force wizard mode even when an LLM is configured
-o, --out <dir>  output directory (default ./ai-modeling-out/...)
--no-wait  submit only; do not wait for completion
--no-download  wait but skip downloading artifacts
--notify  desktop notification when done
--timeout <seconds>  watch timeout in seconds
--name <name>  history name for @references
-p, --param <key=value>  extra API parameter (repeatable) [default: {}]
--request-id <id>  Studio extension: reuse the original submission intent
--max-credits <n>  Studio extension: maximum estimated credits per step
--dry-run  plan + validate only; no network calls, uploads or credits
```

- `request`: e.g. "a low-poly knight for my mobile game, with a run animation"

Studio backend: Studio uses a producer and scenario specialist, or an offline wizard. Generated plans are locally validated; only Studio-supported parameters execute.

## `ai-modeling mcp`

run as an MCP server over stdio

```text
--toolset <name>  default (6 tools), full (official contracts), studio (web extensions) [default: "default"]
```

## `ai-modeling mcp export`

export native MCP client integration files without registering or enabling them

```text
--target <name>  client integration target: golutra-agent (required)
--out <dir>  new output directory whose parent already exists (required)
--toolset <name>  default, full or studio [default: "studio"]
--env <name>  explicit non-secret environment variable name to pass through (repeatable)
```

离线导出 Golutra Agent 原生插件，每包最多 64 个工具，schema 来自当前包的真实工具定义。默认 Studio 集自动拆为三包；通过 `--toolset default|full` 可选择较小的集合。超过客户端长度限制的描述会明确标注缩短，完整原文保存在导出的 README，参数 schema 保持完整。输出目录须为安装目录之外的新目录，父目录已存在，已有内容不会被覆盖。只记录显式选择的环境变量名，不读取值；这些名称必须在启动 Golutra Agent 时已设置。不会自动 stage、review、enable 或写客户端配置。流程与平台限制见 [Golutra Agent](usage.md#golutra-agent)。

Golutra Agent 0.3.9 虽接受清单，但会过滤 MCP 工具，当前无法调用。导出摘要的 `host_compatibility` 与生成的 README 明确记录此限制；成功导出不代表宿主可执行。

## `ai-modeling topup`

show the Studio billing entry; subscription and payment management are outside this tool

```text
--no-watch  show the Studio URL without polling
```

## `ai-modeling completion <shell>`

print a completion script (bash|zsh|fish); e.g. ai-modeling completion zsh >> ~/.zshrc

## `ai-modeling batch`

bulk pipelines from a YAML manifest

## `ai-modeling batch run <manifest>`

run all jobs (resumable: finished jobs are skipped on re-run)

```text
--concurrency <n>  parallel jobs (default from manifest or 2)
--retries <n>  retries per failed job (only when no paid task was left behind) [default: 1]
--fresh  ignore previous state and re-run everything
--no-download  skip downloads
--max-credits <n>  maximum estimated credits per step
```

## `ai-modeling balance`

show available and frozen credits

## `ai-modeling usage`

recent task credit usage

```text
--page <n>  page [default: 1]
--limit <n>  max rows to show [default: 20]
```

## `ai-modeling models`

list the model ids each capability accepts (local whitelist, no API call)

```text
```
