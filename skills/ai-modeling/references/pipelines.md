# 可组合流水线

这些示例展示 Skill 如何组织底层 CLI 能力，不是默认执行计划。CLI 模式使用下列命令；用户选择 MCP 时，只通过 MCP 资源和工具执行同一计划，由 MCP 内部调用 CLI，不擅自改成 shell。按目标选步骤并保留已有素材；登录、费用和恢复细节按需查[使用与恢复](usage.md)。

## 参考图到模型

如果用户已经提供参考图，从模型步骤开始。只有用户也要生成参考图时，才使用图片生成；新增步骤可能另行收费。下面的提示、文件路径和请求标识均由当前任务替换。

先按真实输入规划。`--dry-run` 不提交任务或取得实时价格：

```sh
ai-modeling generate text-to-image "USER_CONCEPT" --model chat_image_2.5_sunburst --dry-run --json
ai-modeling generate image-to-model /absolute/path/to/reference.png --model tripo-v3.1 --dry-run --json
```

参考图尚未取得时，第二条等文件可用后再运行。用户已授权图片生成时，可执行第一步并记录 JSON 返回的实际任务身份：

```sh
ai-modeling generate text-to-image "USER_CONCEPT" --model chat_image_2.5_sunburst \
  --request-id IMAGE_REQUEST_ID --no-download --json
ai-modeling task get IMAGE_TASK_ID --download --out /absolute/path/to/image-output --json
```

用返回的实际图片路径替换 `reference.png`。检查图片是否符合当前输入要求，再按已授权范围创建模型：

```sh
ai-modeling generate image-to-model /absolute/path/to/reference.png --model tripo-v3.1 \
  --request-id MODEL_REQUEST_ID --no-download --json
ai-modeling task watch MODEL_TASK_ID --download --out /absolute/path/to/model-output --json
```

`IMAGE_TASK_ID` / `MODEL_TASK_ID` 来自对应步骤返回的本地任务身份，不是请求 ID，也不靠命名后缀猜测。每个新意图选择各自稳定的请求 ID，重试沿用原值。输入尚未通过核验、前一步结果未知或费用授权不足时，不启动依赖步骤。

贴图、减面、绑定和导出是可选后续操作。用当前版本的 `model/mesh/anim` 帮助确定接口，按确切来源选择必要步骤，不因模型生成成功就自动全部执行。

## 已有任务补交付

用户只要查询、等待或补下载时，复用原任务即可，不运行生成前置条件，不以当前报价阻止读取已完成的原结果：

```sh
ai-modeling task get TASK_ID --json
ai-modeling task watch TASK_ID --json
ai-modeling task get TASK_ID --download --out /absolute/path/to/new-output --json
```

按状态选择上述操作，不机械地全部执行。`task watch` 超时不取消远端任务；下载或输出冲突应保留原付费结果，修复交付条件后从同一任务继续。没有唯一任务或可靠回执的未知提交，应停止依赖步骤并报告，不能重新生成来补结果。

## Canvas Agent 交付验收

本节的 `canvas audit` / `studio artifact-inspect`、`canvas session-history`、实时目录诊断、查询结果导入、参数补丁及 HolyMolly 聊天和节点 stop/retry 扩展已在 0.1.9 提供。先通过已安装程序的命令帮助或 Studio 工具发现确认，MCP 则查看客户端当前工具列表。旧 npm 0.1.4 包不包含这些新增入口；升级运行包后同时更新 Skill 或 MCP 配置并重新加载。Holy Stop、合资格原生 Retry 和其它未验收项仍保留下文的限制，不因命令已发布而宣称通过。

停止正在执行的 Agent 工作时，先用 `canvas turn-stop-plan`（MCP：`ai_modeling_canvas_turn_stop_plan`）准备准确回合的停止顺序。按返回动作先 `turn-cancel`，读回 CANCELLED 后再准备、停止仍活动的准确运行；停止后再次读取。此准备只读，发现不完整或快照变化时不提供写动作，不能将一次空 `runs` 响应当成完整历史。回合取消、运行停止、自然完成和失败分别验收；未知回执保留，不自动重发。Holy 节点自己的 Stop 按后文独立分支处理。

用户通过 Canvas Agent 创作后，需要检查画布上的实际结果。保留本次 `canvasId`、`sessionId`、`turnId` 和明确的目标节点；不要把聊天中的“完成”、回合 `DONE` 或画布上任意已有图片当作交付证明。下面的步骤按用户目标组合，不强制生成、转换或重新创作。

选择或修改节点前，用 `canvas tools`（MCP：`ai_modeling_canvas_tools`）读取当前服务目录及 `cli_support`，区分可编辑图类型、目录允许创建的类型和实际执行入口；未映射或退役节点不补造运行方法。它与离线的 `tools --toolset studio` 不同，会访问当前账号的 Canvas 目录。容量以实时 `max_canvas_nodes` 为准，本地文件结构上限不代表服务容量；`execution:mapped` 也不代表所有参数与效果已验收。

1. **核对会话与进度。** 使用原回合查询详情；`running` 时以有界 `canvas events/watch` 继续读取，保留 `after_id`。遇到 `waiting_input`，读取真实选择或确认卡，经 `answer-plan` 核对后按已有授权继续原回合。普通 `confirmation` 省略准备参数 `selectedOptionIds`，低层续答采用空 `selected_option_ids`；标签为“确认”的 `selection` 仍须传真实选项 ID，不按按钮文字判断卡型。实际续答要求原回合仍是 `WAITING_FOR_USER`，未知或变化的卡片保留阻塞。`Skip` 可能继续收费生成，取消另用 `turn-cancel`。
2. **回读画布。** 用 `canvas audit` 检查准确画布和目标节点，按需要填写 `expect`。它读取前后快照、节点状态、连线和资产信息，只收集证据，不保存图、不批准 REVIEW 节点、不运行任务。传入回合会核对其与会话、画布的身份关系。另读 `run_attribution`（运行）、`current_selection_association`（选择）与 `turn_attribution`（生成）：旧资产可被重新选中，生成归属须有准确原件 task/step 证明。支持范围见兼容表；不把所选产物的证明推广到整图。
3. **检查实际原件。** 根据返回的准确资产身份和来源类型调用 `studio asset-download`。图片或 GLB 用 `studio artifact-inspect` 解码，并按用户要求检查尺寸、面数、贴图、骨架或动作；游戏 HTML 使用下文的独立验收分支。使用返回的真实路径；已知原件摘要时传入 `expected_sha256`。读取或下载失败从同一原件恢复，不重新生成替代。
4. **审阅并交付。** 图片实际打开查看；模型按要求用 `studio snapshot` 生成正面、侧面等视角，动作还要检查选定 clip 的多个时刻。Agent 将可见内容与用户目标逐项比较，报告通过、未通过和未检查项，以及实际文件位置与证据。机器统计不能证明人物、造型、动作或风格正确。

CLI 的只读画布检查示例：

```sh
ai-modeling canvas audit --canvas-id CANVAS_ID --session-id SESSION_ID --turn-id TURN_ID \
  --node-ids '["NODE_ID"]' \
  --expect '[{"nodeId":"NODE_ID","kind":"image","minAssets":1}]'
```

所有 ID 都使用真实回执。`nodeIds` 限定此次检查范围，`expect[].assetIds` 可进一步指定应存在的准确资产；没有明确选择时，画布清单只是当前状态，不是本次创作产物的因果证明。读取过程中画布或相关状态发生变化时，保留 `CANVAS_CHANGED` 错误并重新读取，不以旧快照批准下游操作。

单次最多检查 100 个节点、1,000 个资产身份；大画布须显式选择目标节点，超出限额返回 `AUDIT_SCOPE_REQUIRED`，不会悄悄截断。`artifact_ready` 和 `expectations[].met` 可能为 `null`：未提供期望或来源状态证据不足时，不能当成 `true`。跨图复制的上传挂载可以有准确下载地址，但当前项目查不到其元数据，此时资产 `ready:null`、`input_metadata_scope:not_in_current_project`；可继续核原件，不据此声称它满足新创作所需的 READY 输入条件。

`canvas audit` 的 `acceptance.status` 为 `running`、`waiting_input`、`blocked` 或 `needs_review`；即使机器准备条件成立，仍是 `needs_review`，`acceptance.requirements_met` 为 `null`。Agent 必须完成相关原件与目标审阅才能报告验收结论。`canvas review` 是另一个会修改网页 REVIEW 节点的批准/撤销操作，不能用来替代只读验收。

对明确的生成节点资产，可按其来源下载原件；上传节点等其它来源应沿用对应的 `kind` 和上下文，不机械照搬此例：

```sh
ai-modeling studio asset-download --kind canvas_node --id ASSET_ID --node-id NODE_ID \
  --destination-path /absolute/path/to/output/result.png
ai-modeling studio artifact-inspect --file-path /absolute/path/to/output/result.png \
  --expected-sha256 DOWNLOAD_SHA256 \
  --expect '{"kind":"image","width":1024,"height":1024}'
```

`DOWNLOAD_SHA256` 使用刚才 `asset-download` 回执中的实际 `sha256`，不是 `audit.snapshot.fingerprint`，也不能通过重新计算已替换文件的摘要来冒充原下载身份。上例尺寸只适用于用户明确要求 1024×1024 的任务。检查器支持 PNG/JPEG/WebP 及自包含 GLB/glTF；其它格式或超过检查限额时保留未检查原因，不以识别文件头代替解码。文件身份、解码和检查失败须保留错误，不能改文件后仍冒称原件通过。

检查结果的 `requirements_status` 为 `passed`、`failed` 或 `not_requested`。未给出 `expect` 或原摘要时只报告文件事实；有条件时仅判这些条件。`failed` 对应 `status:requirements_failed`，仍是成功返回的检查报告，不能只看 CLI 退出码或 MCP 的 `isError` 判断条件通过。逐项读取 `checks`；摘要不符时停止交付原件结论。`visual_review` 与 `semantic_review` 仍为 `not_checked`，机器条件通过也不等于用户目标完成。

模型检查和可选视图示例：

```sh
ai-modeling studio artifact-inspect --file-path /absolute/path/to/output/model.glb
ai-modeling studio snapshot --model-path /absolute/path/to/output/model.glb \
  --destination-path /absolute/path/to/output/front.png --azimuth 0
ai-modeling studio snapshot --model-path /absolute/path/to/output/model.glb \
  --destination-path /absolute/path/to/output/side.png --azimuth 90
```

`snapshot` 是需要 Blender 的本地渲染，不保证与网页逐像素一致；素材坐标可能使默认视角并非正面，应查看结果后选合适角度。动画使用检查返回的准确 clip 名称或索引，以及显式 `--animation-time`；静态骨架不能证明动画正确。缺少渲染依赖或图像查看能力时，将对应视觉项标为未检查，不将 JSON 统计替代为视觉结论。

MCP 用户通过 Studio 工具集的 `ai_modeling_canvas_audit`、`ai_modeling_asset_download`、`ai_modeling_artifact_inspect` 和按需的 `ai_modeling_snapshot` 执行上述计划。先读取各工具 schema；例如 audit 使用 `canvasId`，文件检查使用 `file_path`，不能统一猜字段大小写。所有工具继续经同包 CLI 执行，Agent 不为验收自行改用 shell。默认轻量工具集没有这些 Canvas 工具；当前入口不提供时报告缺少能力，不静默更换入口。

已有会话用 `canvas session-history --canvas-id CANVAS_ID --session-id SESSION_ID` 核对；MCP 使用 `ai_modeling_canvas_session_history`。六种已知回合状态全部显式读取，逐消息比较两端身份、内容、顺序和状态。默认最多 50 回合/2,000 消息，可设至 100/10,000；服务分页提示或本地超限明确 `incomplete`。`observed_history_consistent:true` 仍不证明服务器全量留存，`history_complete:null` 保留未知，不补造历史。发现不符合要求时，在原授权范围内选择修正步骤并保留旧回执；新的生成、分享或删除不由验收流程自动授权。

需要修正画布时，`canvas graph-edit` 可直接读取已保存的 `canvas get` 完整 JSON（也接受 CLI `result` 包装），以 `expected_canvas_id`、`expected_project_id`、`expected_revision` 约束所选文件；这些守卫不自动拉取新图。用 `patch_params` 的 `set` / `unset` 修改指定顶层参数，保留其它配置；嵌套值整体替换，`null` 是值，`params` 则替换整个参数对象。编辑仅产生本地状态文件和 `save_input`，后者供独立 `canvas save` 使用；保存后读取新 revision，按需要检查、运行，再重新验收。不要把带历史的状态文件当保存请求，也不要把本地 undo 当远端撤销。

新消息实际提交会重新核对独立附件、节点引用和目标节点的唯一身份及可用状态。准备后发生素材变化、回合不再待答或运行回执身份不符时，从原状态继续核查，不能凭旧计划盲目重发。

Canvas Agent、续答、Lab 与 Holy 节点 stop/retry 的未知回执不能通过手填远端 Turn/Lab ID 修复；`ai_modeling_job_reconcile` 返回 `RECONCILE_UNVERIFIABLE`。ID 存在、同会话/画布或内容相似都不足以绑定原写请求。保留原 job、请求身份和上下文，继续只读取证，不重新生成替代。

HolyMolly 的网页请求通过 `studio canvas-turn`（MCP：`ai_modeling_canvas_turn`，能力放在 `parameters.capabilities`）发送显式 `capabilities:["holy_molly"]`。素材使用 `refs` / `attachment_ids`：独立上传核当前项目 READY，节点产物核准确 node_id + asset_id 和唯一可用结果；不伪造普通素材 ID 来表示游戏节点。修改已有游戏时传准确目标 `node_id`，新建时省略。`canvas turn-plan` 的 `capabilities` 与 `nodeId` 在顶层，准备后按已有费用授权提交。新游戏已有真实附件、HTML 下载及画布内方向键、收集、胜利和重开验证；修改版本还通过 Space 暂停不移动、恢复可移动和暂停中 Restart 恢复零分。每次交付仍须验自己的结果。定向修改已有成功样本：服务保留原节点并交付新版本节点。先核原请求目标，再按本轮 turn/run/新版本节点/资产验修改效果，不要求覆盖旧节点，也不把无关新增节点当结果。

最终正文为空，仅允许显式 holy_molly、准确已保存的 Holy 节点目标且无普通附件；只选择能力不能发空消息。纯目标引用可在 turn-plan 省略 text，低层 canvas-turn 仍需 `text:""`。历史 retry 只读准确 FAILED 回合的最后 USER 消息；服务 `cardJson` 必须同时含明确 `capabilities:["holy_molly"]` 和有效 `targetNodeId`，该目标还须是当前保存图中的准确 Holy 节点。准备结果的 `source_target_node_id` 和参数 `node_id` 来自该字段；缺字段仍返回 `retry_holy_molly_target_unknown`、`ready:false`、`parameters:null`。不用正文、普通附件或唯一现存节点猜目标，也不允许调用方以 nodeId/capabilities 覆盖历史。失败可重试性、附件和两次读取的快照仍须通过；历史重试是新写意图，CLI 原 job 恢复继续保原回执。合法 FAILED 已有准确目标恢复、新回合与新 HTML 交付的实测正例，方向键、收集阈值及暂停/恢复通过；每次新产物仍须单独验收，不能据此放宽未知目标或原生节点 Retry 的守卫。

持久历史目标不可证时不要猜补。若原请求是准确的本机终态任务，CLI 的 `redo EXACT_LOCAL_JOB_ID --request-id NEW_INTENT` 保留原目标和附件，但属于新创作，需独立费用授权；选择 MCP 时使用对应工具并保留相同新意图，不切换 shell。

游戏间连线使用 `html` → `html`，游戏到 Lab 使用 `html` → `input`；网页连线构造器不会建立素材 → `materials`。该端口的目录声明不能替代完整请求链。普通 `canvas-run` 不运行 HolyMolly。

停止/重试节点用 `studio canvas-node-stop` / `studio canvas-node-retry`（MCP：`ai_modeling_canvas_node_stop` / `ai_modeling_canvas_node_retry`）。仅支持已保存 Holy 节点，均需准确 `canvas_id`、`node_id`、十进制字符串 `revision`、`expected_run_id`；参数取自同一保存图及原运行，不按“最新”补来源。stop 要求原节点/运行仍活跃，不索取新生成预算，不清零原账单；retry 要求原节点/运行终态、`retryable:true`，并接受 `accept_variable_cost:true`。两者通过持久 job 执行，但预检不是上游原子条件。未知写入保持原 job，不能自动重提，也不能用后来出现的运行对账；目前没有可验证的未知回执绑定。

Stop 已适配准确原 `runId` + `status:"accepted"` 的真实回执，保存 `accepted_run` 并回读原运行；独立 turn 回执另行核验。受理不代表停止：`stopRequestedTime` 与 `stopping` 事件只作过程证据，原节点最终 DONE/FAILED 保留 `STOP_NOT_CONFIRMED`，状态被其它运行替换则 `STOP_STATE_UNAVAILABLE`。实际样本分别结束为 FAILED 或 DONE/SUCCEEDED，不能泛化为 stopped。原生节点 Retry 仍无符合条件的线上正例；历史 Agent 消息重试与该节点操作分开验收。

Holy 的只读审计使用 `expect.kind:"html"`，可同时指定准确 `assetIds`。候选分类优先使用当前结果 URL 路径的后缀，路径无后缀才用 `filename`；识别 `.html/.htm`，不从查询参数取后缀，也不证明内容已经解码。没有明确选中或指定的 HTML 身份时，不取第一项充作产物。`game.preview.entry_url` 是移除查询参数的诊断信息，不能当作完整试玩链接或 HTML 原件下载地址；审计不会自动打开、公开分享或试玩。按准确资产下载 HTML 后，独立验证依赖、加载、控制和所需玩法，图片/GLB 检查器不支持游戏。

`game.credits` 与节点/回合终态独立：`NODE_CREDITS_STATUS_PENDING` 不是零费用，DONE 不代表 SETTLED，缺失或无效状态保持未知。其来源是节点运行，费用归属独立核 run；`attribution_scope:node_run_record` 不等于账号流水已核对，`ledger_attribution:not_checked` 必须保留；`turn_attribution:unknown` 时不能计作本次聊天账单；账号账单缺少唯一任务身份时，不按 `holy_molly` 类型、时间或金额猜绑。stop 不将历史费用归零。HTML 字节、视觉、游戏玩法和结算分别报告；一个修改版本已结算也不能替其它仍为 PENDING 的生成运行结算，节点控制另行验收。

## 独立候选批处理

`batch run` 适合独立的候选任务，不表达“先生成图片、再把其结果自动送给下一项”的依赖图。当前没有批处理 `--dry-run`；先用各项等价的 `make --dry-run --json` 规划。

清单可按用户需求填写：

```yaml
concurrency: 2
defaults:
  model: tripo-v3.1
jobs:
  - name: candidate-a
    input: USER_CONCEPT_A
  - name: candidate-b
    input: USER_CONCEPT_B
```

授权范围覆盖这些生成任务后，才运行 `ai-modeling batch run /absolute/path/to/batch.yaml`。保留清单及其 `.state.json`；恢复时不改清单，不使用 `--fresh` 绕过未知状态。单项失败不表示其它项没有提交，逐项核对回执后再选择后续操作。

## 使用 MCP 执行同一计划

MCP 提供同源的 `ai-modeling://guides/usage`、`ai-modeling://guides/commands` 和 `ai-modeling://guides/pipelines`。按需读取相关主题，保留上述步骤选择和身份记录，通过当前客户端的 `ai_modeling_*` 工具执行。先读取相关工具 schema，不根据 CLI 参数名称拼猜 JSON 字段，也不调用 shell 代替 MCP。`ai-modeling://auth/status` 提供登录流程快照；需要用户交互时返回登录入口，完成匹配的流程后继续原任务。

默认6工具集可以完成“图片 → 模型”：先用 `ai_modeling_image_generate`，其图片参数位于 `parameters`，并提供当前意图的 `request_id` 和已授权 `max_estimated_credits`；使用返回的真实任务身份调用 `ai_modeling_task_wait`，取得下载的实际图片路径。确认图片后，把该路径传入 `ai_modeling_make.input`，为模型步骤选择独立请求身份，再通过返回的任务身份等待/下载。`ai_modeling_image_generate` 默认 GPT Image 2.5；不要把 CLI 的 `--model` 字段名直接套入原生工具 schema。

首次缺会话时，把工具返回的登录 URL 交给用户并保留 `login_id`，读取 `ai-modeling://auth/status`，确认相同 ID 的流程 `authenticated: true` 后继续原请求。`scope: login_flow` 的历史成功不证明当前凭据和会话可用；接续工具仍会检查认证，按其实际结果处理。图片或模型需要较长时间时保留原任务，通过 `ai_modeling_task_get` / `ai_modeling_task_wait` 查询；客户端超时不意味着需要再生成。此流程是用户同时要求图片和模型时的示例，已有图片直接使用模型步骤。

CLI 执行所选操作，MCP 提供指导资源并代理工具调用；是否需要下一步、如何连接产物和何时停止由 Skill 根据用户目标指导。已经授权的范围内继续推进；新增收费意图、发布或删除不从示例中自动取得授权。

Lab 说明由服务自动保存；读取 `canvas lab-instructions` 的 `validation` 和 `reuse_blockers`，再用 `lab-plan` 复核全部上游输入。说明合法不等于计划就绪；画布镜像不是另一个保存接口。作答前审阅 `answer-plan` 保留的标题、选项说明、计划组和需求，展示估价不能替代费用授权。
