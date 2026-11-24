# 兼容范围与已知限制

ai-modeling 以 `tripo-cli 0.11.2` 的基础命令能力为对齐基线，底层使用 Tripo Studio 网页会话与网页积分，MCP 调用同包 CLI。npm 包名为 `@seekskyworld/ai-modeling`，唯一命令为 `ai-modeling`，MCP 通过其 `mcp` 子命令启动；配置使用 `AI_MODELING_*`，工具使用 `ai_modeling_*`。官方能力对齐不表示保留旧项目名称的别名或配置回退。

**当前不保证全部官方效果等价，也不保证覆盖网页全部菜单、权限和条件分支。** 命令存在、参数被接受、远端成功、文件有效和效果等价是不同层次。“未建立映射”指尚无完整、可执行且效果相符的链，不表示平台永远没有接口。以下编号保留稳定引用，不代表缺失命令数量。

参数与结构化工具输入见[命令目录](commands.md)及 `ai-modeling <command> --help`；安装、登录和常见流程见[使用指南](usage.md)，验证方法见[开发说明](development.md)。本页集中说明支持条件，有限成功样本不能外推任意输入。

## 能力状态 / Capability status

此表用于先选路线；“已提供”表示有可执行实现，不代表任意输入、所有操作系统或全部官方效果均已验收。下方矩阵给出具体条件。 “Implemented” identifies an available implementation; it does not certify every input, platform, or official behavior.

`capabilities` 从当前命令、工具集与模型注册表生成 mapping/support 清单，生成方法见[开发检查](development.md#开发与本地检查)。缺少逐项执行证据的条目保留 `not_verified`；测试源码引用不代表本次运行或实时服务验证。The generated catalogue describes implementation and constraints; references to tests are not execution evidence.

| 状态 / Status | 能力 / Capability | 适用边界 / Limits |
| --- | --- | --- |
| 已提供 / Implemented | CLI、MCP、Skill；离线工具和分片指南发现 / CLI, MCP, Skill and offline discovery | 唯一运行入口为 CLI，MCP 内部调用；发现不读账号、凭据或创建任务状态 / MCP invokes CLI; discovery has no account or state access. |
| 已提供 / Implemented | 网页生成、原请求恢复、下载证明 / Studio generation, original-request recovery, verified delivery | 使用 Studio 网页积分，保留多步回执和产物检查 / Studio web credits, per-step receipts and output checks apply. |
| 条件支持 / Conditional | 浏览器登录、setup、doctor / Browser sign-in and diagnostics | 需要可见 Chrome/Edge 与可访问的私有 JSON 凭据目录；POSIX 权限或 Windows ACL 必须可验证；三平台安装冒烟不等于真实登录实测 / Requires a visible browser and protected local JSON storage; install smoke does not verify sign-in or every OS permission path. |
| 条件支持 / Conditional | 本地转换、渲染、视频、网页前端导出 / Local processing and frontend export | 依赖 Blender、FFmpeg 或固定引擎，且受具体来源、几何和材质条件限制 / Optional programs and source/geometry/material constraints apply. |
| 实验 / Experimental | full 工具集 `ai_modeling_mesh_edit` | 默认不暴露；显式启用 `AI_MODELING_EXPERIMENTAL_MESH_EDIT=1`，仍受参考编辑限制 / Opt-in only; reference-edit restrictions remain. |
| 未完成或未验证 / Incomplete or unverified | Gaussian 链、任意 mask/变换/动画保真、全部网页条件 / Gaussian pipeline, arbitrary masks/transforms/animation, complete website parity | 参见 E23/W23 条目；命令名称和单例成功不证明等价 / See E23/W23; names and isolated successes do not prove parity. |

本页对应 0.1.10。旧 0.1.4 包不包含本次新增的 Canvas 验收、历史与节点控制扩展；后续标为 [Unreleased](../CHANGELOG.md#unreleased) 的改动仍不保证存在于已发布 npm 包。以所用版本的帮助、schema 和返回字段核对能力。发布和三平台 CI 配置不代表对应版本已完成原生环境或业务验收。

## 基本合同

| 范围 | 当前行为与边界 |
| --- | --- |
| 后端 | 优先使用已验证网页接口；已确认属于网页浏览器计算的功能可提供本地对应实现，并披露处理方式。不静默切换官方 API 钱包或其它服务。 |
| 身份 | 本机 job、Studio project/operator、Canvas asset、Lab job 与官方 API task ID 不可互换。上传句柄受来源与账号限制，不补造服务未返回的身份。 |
| 登录与 MCP | 可见浏览器登录、同 OS 用户/profile 的私有 JSON 会话、等待/取消和安全请求边界接续已提供；MCP 不返回凭据。首次密码、验证码和双重验证由用户完成。Windows、Linux、macOS 的代码支持与现场验收分别记录，不保证所有系统与登录方式均已实测。 |
| 工具集 | `default`、`full`、`studio` 分别为常用入口（含独立生图）、官方兼容合同和网页扩展；均通过 CLI。full 的实验 `ai_modeling_mesh_edit` 需 `AI_MODELING_EXPERIMENTAL_MESH_EDIT=1`。 |
| 宿主适配 | Golutra Agent 0.3.9 的原生插件清单可注册，但 provider 白名单阻止模型发现/调用 MCP 工具；导出器保留 `host_compatibility` 阻塞，不能用独立 SDK 测试替代宿主验收。该适配器不暴露 MCP resources/prompts，Skill 仅项目范围；Windows 执行外部工具还需 OS 沙箱。其它宿主或新版本须分别验证。 |
| 路径 | `make/generate/处理命令 --out` 为根目录，产物写入其下 `ai-modeling-out/<name>-<id8>/`；`task get/watch --download --out` 与 full MCP 下载为精确目录。路径由调用方选择。 |
| 计费 | 多步骤分别保存回执并可能收费，不具备官方单任务原子性。估算阈值不是上游扣费硬上限；普通报价未知/过期会阻止提交。0.1.10 内置审阅快照含43个网页常量、5个已证派生数值及3项无预报价声明；仅 `import_model/modification/retexture_apply` 可在有效声明和显式 `accept_variable_cost=true` 下执行，报价仍为 unknown/variable，必须省略数字预算（包括0）。Canvas/Lab 的可变费用合同独立。0.1.4 及更早安装包和旧 Release 的快照不会随本次发布自动更新。 |
| 任务结果 | 产物未满足尺寸、alpha、几何、材料或动画要求时保留远端回执并标为 `needs_attention`；无可靠提交回执为 `outcome_unknown`，不自动重发。`--no-download` 不免除产物检查。 |
| 版本与权限 | CLI/MCP 应一起升级；当前任务库 schema v18，初始化/迁移在写锁内串行完成，WAL 设置竞争有界重试。旧读取器不能读取新义务；初始化重试不重发远端任务。来源必须有合法权限和准确历史版本；网页变化可能使原有路线不可用。 |

full MCP 的 `ai_modeling_usage` 统一返回 `usage`、`missed`、`errors`、`unknown`、`complete`、`truncated` 与可空的 `total_credits`。`task_ids` 按本地 job 去重，一项失败不会吞掉其余项；账单默认返回 50 行、最多 500 行，为验证完整性最多检查 10,000 条原始记录，并按远端 operator 分组，使用 namespace 区分身份。总额只汇总返回行中已确认的 gross charge；未知不填 0，refund/add 不算收费。`complete: false` 或 `truncated: true` 时，不把有限结果当作完整账单。

新独立生图/图像编辑请求未指定模型时使用 GPT Image 2.5。已有任务的模型保存在原输入中，查询、等待和下载沿用原任务；重用旧请求 ID 时须保持原参数，曾使用 FLUX 的任务可显式指定原模型。省略模型后发生默认值变化会返回意图冲突，不会更换旧任务模型或自动重复提交。

## 官方 CLI 差异矩阵

| 编号 | 功能 | 当前支持与未完成范围 |
| --- | --- | --- |
| E23-01 | image-to-splat / Gaussian | 未建立 Gaussian 输入→任务→产物链。普通 POINTS GLB 不含 Gaussian 属性，不能代替 Gaussian splat。 |
| E23-02 | 引擎、图片 seed/negative | **Texture 按网页实际 `v3.5-20260815` 提供支持**；旧 v3.0 别名不保证旧引擎身份。精确图片引擎、独立图片 seed/negative 尚未等价；文生模型 negative 已支持。 |
| E23-03 | GPT quality、Sunburst 背景 | opaque 验证原图 alpha；transparent、auto、quality 尚未等价。Cutout 会改变画布且缺原位置，不能替代保画布透明输出；JPEG 无法保存 alpha。 |
| E23-04 | auto_size、有纹理 align_image | 手工尺寸、矩阵、朝向和贴图 alignment 不能代替自动现实尺度估计或基于原图的几何对齐；尚缺对应完整网页链。 |
| E23-05 | 精确 remesh v1/v2/v3 | 网页将相关值归一为 default；UI 标签或保存参数不能证明算法版本。Canvas 单 Retopology 节点 `smart_poly=true,smart_uv=true,bake=true` 已真实完成带纹理模型减面、UV、原件与网页对照；目标1000面实际1106面，不能据此声明精确面数或官方引擎身份。兼容 `mesh decimate --smart-uv` 保留其原独立UV步骤，不静默更换旧请求路线。 |
| E23-06 | 连通分割、参考 mask、复杂 edit | 受限 Lab 参考编辑和明确投影分区已实现；`split_by_connectivity` 尚未映射。未知相机、任意 mask、带纹理/复杂结构及任意提示语义仍有限制。 |
| E23-07 | SmartSegment 任意 transform | 支持 coarse/fine＋hint、精确 Rz90、有限正 TRS、通过检查的正行列式仿射；要求特定来源结构。多 root、反射、名称冲突和复杂来源未普遍通过，不能承诺任意矩阵或属性无损。 |
| E23-08 | 原图定位、语义标签、内部 ID | 单一来源和规范化预览有支持；多来源历史不总能唯一还原原图。PNG 预览不保证原图像素对齐，缺失语义标签与官方内部 ID 不合成。 |
| E23-09 | 任意多视图 sheet/file | 成功四槽任务链已支持；任意布局和方向不猜切。官方总描述与字段/端点对 URL、file_token 或成功任务 ID 的要求有差异，网页多任务计费与原子性也不同。 |
| E23-10 | 全容器 JPEG、透明/特殊贴图 | 有限 JPEG/fallback、FBX 内嵌 JPEG 和全不透明 PNG 已支持；不代表全部贴图角色或容器。零图像编码空操作不证明有纹理转码；有 alpha 的贴图不能转 JPEG 后宣称效果不变。 |
| E23-11 | 高级材料通用 bake=true | 有限镜面、发光、各向异性和部分标量材料保留不等于烘焙。volume、iridescence、texture_transform、部分零值、无/退化 UV 和 FBX 导入属性重置仍有限制；动画 bake 不等于材料 bake。 |
| E23-12 | 自包含 GLTF 的特殊图片格式 | BMP/DPX/HDR/EXR/TGA/TIFF 尚无完整、标准加载器可读的封装合同。枚举、独立图片或其它容器外部贴图成功不能证明 GLTF 支持。 |
| E23-13 | 复杂 UV 压缩 | 静态无纹理非索引盒体已完成文件导入→UV生成→应用→再次导入压缩→下载、逐面/UV检查和网页模型/布局对照；无需将无预报价导入伪装为免费。压缩结果是真实 Meshopt，允许已披露量化；首导入的严格 `normalize_scale` 属性合同仍未通过。共享实例/层级/动画组合未普遍验证，当前 Blender 不直接支持该压缩扩展。 |
| E23-14 | 任意内嵌动画保真 | 受限转换和复杂 Canvas 原件播放/seek/下载已支持；导入可能改插值、删 clip、改变时序/根运动。原件下载不等于合法转换来源，任意动画保真尚未完成。 |

## 网页覆盖矩阵

| 编号 | 范围 | 当前边界 |
| --- | --- | --- |
| W23-01 | 菜单与条件分支 | 已覆盖主要创作、编辑、素材、项目和 Canvas 功能，但尚未穷尽输入、权限与状态组合；工具数不是全站覆盖率。账号管理、支付管理和站内消息不在创作适配范围。 |
| W23-02 | NURBS | 网页 Line 预览、Canvas 原件保留/下载不证明 Studio import 保留曲线或曲面；导入可能把曲线 Geometry 丢为 Null。 |
| W23-03 | FAILED、WAITING、Free Retry | Canvas 历史失败重试及多问题 Other/逐题 Skip→单选确认→同回合生图已有正例；已答卡重入拒绝。独立 Studio Free Retry 已在准确 `retry_info.can_retry=true` 项目完成提交、生成、原件检查与网页加载，但新产物不保证提示语义，缺准确账单仍记费用未知。Holy 原生节点 Retry 仍需 `retryable=true` 合法样本，不能混用其它入口的成功。 |
| W23-04 | Lab 手工 Save | 当前说明卡为 Copy/Reuse，自动保存与读取已有映射；没有已确认的独立手工 Save 或设置说明 RPC，不虚构缺失接口。 |
| W23-05 | 原生图片格式选择 | Canvas/Gallery 当前下载原件，未确认原生 PNG/JPEG 选择器；`output_format` 是本地交付编码扩展。 |
| W23-06 | FBX / Draco | 有限原引擎 FBX 导出已支持；当前网页 FBX 预览工厂只选择第一段有效 clip，导入也可能重置材料或法线。主 GLTF loader 已配置 Meshopt，未发现应用配置 Draco 的证据；库含方法或服务导入成功不等于网页可加载。 |
| W23-07 | 引擎冷启动 | 可显式安装经过长度/摘要校验的固定官方资源，普通 HTTP 获取 WASM 可能 403；浏览器可下载不保证 CLI 可下载，不运行其它未知版本。 |
| W23-08 | AI 严格语义 | 实际产物和几何/像素检查不能保证任意提示的语义；一次成功不能外推全部输入。未知点击/提交不盲目重发。 |
| W23-09 | REVIEW、退役节点、模板 | 当前不可创建或无权限的节点不伪装可执行。模板图片须取准确原件，不能用模型详情接口替代；大图预览不证明存在独立下载按钮。 |
| W23-10 | 精修、DCC、其它系统、打印 | 协议、文件传输及部分 Blender 流程已有支持；其它软件/系统、人工成品和实体设备未全部验证，打开或传输成功不等于成品完成。 |
| W23-11 | 未知回执与账单 | 只凭唯一服务回执/交易证据对账，不按提示或相近时间猜任务。余额未变和缺少账单不等于免费；来源任务旧费用不重复分配到后续处理。 |
| W23-12 | Canvas 游戏与新目录 | HolyMolly 图保存、部分 html 连接、显式 Agent 能力及节点 stop/retry 请求已有源码映射；素材经准确附件引用，不新增 materials 图边。新游戏已实测原附件字节保留、HTML 下载和画布内试玩；定向修改已确认以新版本节点交付并保留原节点。节点 stop/retry、未结算运行及全部依赖组合仍待验收。完整边界见[Canvas 表](#canvaslab-会话与模板)。 |

## 生成、图片与导入

| 功能 | 重要支持条件 |
| --- | --- |
| P1/P2 流程 | 默认带纹理通常为白模→纹理，PBR 可能另加一步。依赖前一步的处理链不接受 `--no-wait`；其它入口依各自合同。每步独立回执和费用。 |
| 图片参考与尺寸 | GPT Image 2 / 2.5 Sunburst 支持普通 16 图或主图＋15 图，保留顺序与角色但不保证画面逐格排列。显式 `size=WxH` 即使不下载也核原尺寸；不符不通过本地缩放/重生成补成功。UI 某些分支的 10 图限制不推定为所有模型的服务上限。 |
| 图片参数优先级 | 图片入口 `-p model=...` 覆盖 `--model`；3D 入口仍按 `--model` 优先。文本生成的 `-p prompt=...` 覆盖位置文本；未映射字段明确拒绝或警告，不静默丢弃。 |
| normalize_scale | 仅从冻结原输入与实际导入件逐面验证后派生，不是服务直接返回，也不表示米制尺度。identity、保 UV、自包含静态单 root/primitive、完整法线/UV、标量不透明材质和至多一张底图的 GLB 为受限范围：≤25,000 面、≤100,000 顶点。 |
| 导入来源变化 | Studio 可居中并将最长边归一为 1；`normalize_scale=1` 也不保证中心不变。超范围仍可导入，但不补造比例；旧任务、缺原快照/缓存或面不符时省略并说明原因。不能仅用包围盒比值证明保真。 |
| 绑骨与动作 | 预检建议和后续步骤冻结到原计划；明确不通过返回 `stopped_early`，可交付前面成功模型。无法解析预检不会算通过。主模型含骨骼不代表包含独立动作文件。 |

## 分割、UV 与编辑

| 入口 | 支持条件与限制 |
| --- | --- |
| SmartSegment 变换来源 | 文件/URL 限居中、最长边 1、静态单场景/root mesh/三角 primitive，完整法线/UV0，≤25,000 面、≤100,000 顶点；不透明标量材质及至多一张内嵌 JPEG/PNG 底图。层级、skin、动画、morph、多材质和额外贴图不在该范围。 |
| SmartSegment 矩阵 | 接受有限列主序 4×4 矩阵；正 TRS 每轴尺度 0.01–100。六轴剪切系数绝对值 0.01–1；一般正行列式仿射须通过两因子、重构及原面精度检查。反射、投影、奇异矩阵、名称歧义或未应用几何编辑拒绝；受限多 root 仍有服务 code 5 失败。 |
| SmartSegment 执行与证明 | 精确文件 Rz90 为导入→分割；正 TRS 为导入/历史复制→metadata→分割；新受限仿射为原字节正旋转导入→metadata→普通分割。旧七步请求沿用原冻结布局，不改成新链。未冻结步骤可明确接受无预报价费用；旧已冻结且缺同意的步骤保留 `UNQUOTED_CONSENT_FROZEN`，等有效数值报价，不补改原意图。最终必须逐面验证原目标；中间预检不能放行。分割可能重算法线/UV/纹理/材料，粒度和 hint 不保证部件数。 |
| 普通分割路由 | 对可验证 v2 GLB，应用删除后按实际绑定 Mesh 实体数选择 ordinary/resegment，不单看 `is_segmented`、root 或材质数。primitive 与复用实例分别计数；损坏或歧义来源不降级，正确路由也不保证服务接受或属性无损。 |
| 删除与版本竞争 | 服务可能继承旧删除名并再次隐藏新部件；CLI 不静默清空，可用独立 `project-edit` 显式恢复指定可见性。来源与 metadata 重查不是远端原子 CAS，最后读取与接收间仍有竞争窗口。copy 也不保证继承 metadata，须重新核对。 |
| 手工分割 | 本地拾取/刷选/标签/撤销对应网页前端，保存用原生 `apply_indices`。仅静态单 scene、indexed triangles、每 mesh 单 primitive、唯一安全名称、自包含 GLB；≤256 网格/标签，单网格≤200 万面/顶点，总和≤800 万。状态≤64 MiB，历史≤32 步/16 MiB。 |
| 标签与保存 | 网页按顶点标记、三角首顶点定面标签；共享顶点可影响邻面。状态绑定原文件、project/operator 和删除/改名/变换快照，不能换重排顶点的导出件。带变换保存为 modification→project_edit→export；不同矩阵部件并入同标签拒绝，最终坐标/名称不保证与原件相同。 |
| Smart UV | 网页会移除旧纹理；有纹理来源须显式 `bake=false`，默认/true 不能假称保纹理。生成→应用→导出按步恢复。无纹理非索引盒体的完整文件导入→UV生成→应用→压缩导入已通过真实任务与网页对照；准确UV步骤有独立结算证据，导入缺账单仍未知。服务把样本材质 doubleSided 从 false 改成 true；最终压缩保留应用后的材质，不能承诺输入材质原样。旧 context 返回409时仅可用准确原布局缓存恢复，无缓存不自动重生成。 |
| UV 压缩与查看 | `mesh uv --no-bake -p compress=geometry -p accept_variable_cost=true` 限受证静态无纹理根 mesh、多 primitive，≤64 primitive/25,000 面；允许已披露量化，唯一同坐标基才重组。真实最终件对准确UV应用件保持全部12面和位置/法线，UV最大误差0.000161以内，4个Meshopt几何视图可解码。网页可加载并显示布局；Blender 4.5.16不能直接导入Meshopt原件，单独解码副本可导入，不改变原件。首导入的原材质浮点/UV精度未通过旧严格 `normalize_scale` 合同，保留 unverified。继续网页编辑用 `original_uv_task_id`；查看按保存姿态，缺UV列跳过，不采样动画。 |
| metadata 本地应用 | 只接明确删除/改名/变换及可选材料因子；列主序 delta 左乘原局部矩阵，先按原名编辑再改名。拒绝动画 TRS 目标、骨关节静态 delta 或不可表达矩阵；同 metadata 不重复应用。原生导出可能丢平移（`NATIVE_EXPORT_TRANSLATION`），本地文件保坐标不代表再导入仍保世界位置/尺寸。 |

## Lab 参考编辑与后续模型

| 能力 | 条件与交付要求 |
| --- | --- |
| 共同输入 | 参考编辑/投影分区限自包含静态 GLB，单 scene/node/mesh/primitive、完整 POSITION/NORMAL、默认无纹理材质，≤25,000 面/50 MiB；附件≤20 MiB。纹理、额外 UV/颜色、skin、动画、morph 和复杂结构不静默接纳，须显式接受可变费用，不保证 P2 或官方 v2 引擎。 |
| `mesh edit --ref-image` | 图片为 PNG/JPEG/WebP，支持文件/URL/本地成功任务，不接受旧 API file_token。bbox 各轴 min<max，至少含一个完整原面并保留一个框外面；禁止框外变化/新增几何，框内须真改变。不能组合未映射的 face_limit/model/compress；语义仍为 `not_automatically_verified`。 |
| 投影分区 | `reference_projection` 为 2×4 world→像素矩阵，两方向非零、正交、同尺度。PNG 无 alpha，白背景＋2–8 精确非白 RGB；每面重心按 `floor(pixel+0.5)` 取色，遮挡面也必须完整覆盖，抗锯齿额外颜色计数。不猜相机，拒绝未映射的 model/granularity/connectivity。 |
| 分区验收 | 原有向面必须且仅出现一次，坐标/法线/默认材料保持；每色唯一 `mask_六位小写RGB` 组，错组、缺面、新增或贴图代分组均不通过。唯一真实 GLB 才能交付，报告和预览不能替代。 |
| 准备、等待、redo | 独立 Canvas、上传 READY、精确附件和回执逐步持久保存；未知写不重发。局部编辑 `--no-wait` 在准备/提交后返回；`--no-download` 仍核产物。redo 仅对已验原任务用冻结输入建立新付费链，未知/未验任务及不支持的覆盖不可重做。 |
| `studio_normalized` 来源 | 仅已验静态无纹理 Lab 结果可显式选择网页副本；居中、尺度/法线量化，参考编辑还可能合并 primitive/缩短名称。分区须保原组名及逐面归属；总面数相同不足以证明。通用 Lab、纹理/动画来源不自动准入。 |
| 后续处理 | 按精确历史 operator 独立 copy，验副本字节后处理；copy 可收费且不保证 metadata 相同，链不接受 `--no-wait`。分别保留原件、规范化件及处理版本，不宣称原坐标/法线无损。copy 可供 convert/texture 等使用，complete/retarget 仍需相应分割/绑骨类型。 |

## 导出、材料与动画

| 范围 | 支持条件与已知差异 |
| --- | --- |
| 三种处理路径 | 服务导出、固定网页 Assimp JS/WASM 在本机转换＋`export-lite` 授权、普通本地后处理分别披露；不能相互冒充。转换验证、授权、交付各自成立后才算完成。输出 GLTF 的前端路线为自包含 GLB。 |
| 精确来源与引擎 | 当前账号成功历史 project/operator、原 `model_url` 和 metadata 必须匹配且无进行中编辑；不用预览/当前件/独立动作替换。引擎不随包分发，只运行固定长度/SHA 版本，独立 worker 有时限且不读取凭据/外部贴图。资源 403、损坏或变版明确失败，不降低摘要要求。 |
| GLB 通用准入 | 自包含单场景、唯一节点名、≤150 MiB/100,000 面/200,000 顶点，基础 PBR 或已验材料，可接受已验 Meshopt/量化。morph、未知扩展/键、额外顶点属性、自定义 chunk/extras 等拒绝；明确验证的 `asset.extras.AIGC` 原字符串例外。 |
| 朝向与轴心 | GLB 前端支持 `+x/-x/+y/-y` 与显式布尔轴心；网页面板当前固定 `-y`。原引擎与服务两个 X 枚举相反，新兼容 convert 意图 v2 交换 X 以对齐服务；旧 v1/redo 保原字节，披露 `orientation_mapping`。省略轴心不等于 false，也不保证完整底部居中。 |
| 静态网页编辑 | 编辑限独立唯一根 mesh/单 primitive、无 skin/动画/morph、有限正 TRS（各轴 0.0001–10000）。多根按根×部件×原世界矩阵，单根按部件×根×原世界矩阵；按删除前根数决定。剪切/反射/复杂编辑拒绝；无编辑的部分层级/多 primitive 轴心可验，共享实例塌陷仍拒绝。 |
| 显示名与删除 | `children_rename` 是显示映射，当前引擎不把它写入文件原节点名；键须精确，值 1–100 字符属本地验证范围。删除可在 GLB 留下未引用原 mesh，仅唯一完整对应且不再被引用时接纳并披露；不是清除文件内部几何。 |
| 静态 convert 组合 | 显式静态、不烘焙 GLTF、四向之一、布尔轴心、PNG/JPEG/WEBP、尺寸 1–8192；每张既有图须已是目标编码及精确正方形尺寸，无贴图为空操作。拒绝原件 skin/动画和导入/重拓扑/额外 CLI 编辑组合，不以删内容放行；其它或旧请求依原路线。 |
| 动画 convert 组合 | 受限自包含 GLB、内嵌骨架/动作、既有图全部 JPEG 2048²，显式四向、轴心、`bake=false`；逐帧核原时间/插值/数值、骨权重/逆绑定和静止姿态。几何编辑、独立 retarget、其它编码尺寸或导入/减面组合拒绝。只产生授权回执，不创建新模型 operator，本地轴心不冒充网页已存编辑。 |
| 动画严格保真 | LINEAR/STEP 为已支持子集；规范解码 normalized 整数轨道并按原值恢复受证 TRS/rest，不拟合原轨道。CUBICSPLINE 只在时间/关键值一致时可恢复切线，仍缺完整保插值远端来源链；额外轨道须恒定且不延长 clip。最终文件可能与 worker 整字节不同，不保证任意动画。 |
| PBR 与高级材料 | `is_pbr=true` 才按网页覆盖完整 `[0,1]` metallic/roughness，否则保源。受限 unlit/clearcoat/transmission/sheen、镜面强度/颜色、发光及各向异性可保；各向异性需法线/非退化 UV，不放宽显式 TANGENT 或扩展纹理范围。volume/iridescence/texture_transform、发光零值及镜面因子0配白色拒绝。IOR 导入可能剥除；发光强度可折入颜色，仅声明效果，不保原字段。 |
| 独立动作选择 | `studio frontend-export --exclude-retarget true` 对应不选独立动作，保主文件骨骼/内嵌 clip；默认拒绝隐式丢弃。选择冻结，同请求省略/改值冲突；不扩大其它兼容路线的独立动作支持。 |
| FBX 来源 | 限精确原生二进制 FBX→GLB，`-y`、底部中心、无 GLB 编辑/PBR覆盖；≤150 MiB、输出≤100,000 面，每 mesh≤200,000 顶点、原多边形≤64角。静态 Mesh/Null、Y-up/UnitScaleFactor=100、正缩放/有限 XYZ TRS，子级 RSrs；单 Geometry、显式法线、最多一层 UV/一个 Lambert或Phong 材料。动画、曲线、约束及未知对象拒绝。 |
| FBX 材料与纹理 | 复刻网页有损 Lambert/Phong 标量映射，不保原光照/Ambient 烘焙；忽略 SpecularColor 色相，以 SpecularFactor 分段映射镜面/IOR且强度可能饱和。服务导入可重置该值，非中性镜面完整链仍未证。只接内嵌底色 JPEG 或 8位非交错全不透明 RGB/RGBA PNG、UV0/default repeat；不读外部依赖。每图≤32 MiB/8192²，≤64图/总1亿像素，透明、未知块/profile/连接及其它槽拒绝。 |
| FBX 蒙皮与表面 | 静态 skin≤256关节、完整 BindPose/Cluster、每点≤4近归一权重；原引擎转 Float32、删除≤1e-6权重再归一化，属有损行为。逐多边形核 n−2 三角、方向/边界/属性；非共面多边形与 Three 预览可选不同对角线，不能称逐点表面等价。native→导出证明不替代上传→native 保真。 |
| 编码与恢复 | 透明/不支持的默认 JPEG 可保原编码并警告，显式不支持编码不降级；部分编码/轴心需 Blender并披露。前端缓存缺失或摘要变更不重转换/授权，旧 FBX 缺格式证明不以源 FBX替代目标GLB；只恢复原产物。 |

## Canvas、Lab 会话与模板

`canvas tools` 读取当前账号的服务目录，保留原字段并追加 `cli_support`；`ai-modeling tools --toolset studio` 是本地工具发现。`directory_status` 区分资料可用、不完整和不可用，`graph_edit` 表示本地类型支持，`create_node` 还要求当前目录允许创建，`execution` / `execution_command` 表示执行入口映射。退役、未映射、缺少定义及仅本地保留的类型分别列出；这些状态不证明账号权限、任意参数或产物效果，目录中的 `verified` 与空参数列表也不构成验收。

0.1.10 已包含目录诊断、HolyMolly 图表示/聊天/节点停止重试、查询结果导入、`patch_params`、会话历史核对和聊天后验收入口；旧 0.1.4 包不包含这些新增能力。Holy 节点停止/重试的真实结果与其它未验证范围仍按下表保留。

| 网页能力 | CLI 入口及当前边界 |
| --- | --- |
| 项目与画布 | `canvas projects/create/get-project/get/rename/delete`；创建回执不代替图内容验收，删除针对明确项目。 |
| 分享与共享副本 | `canvas preview-share/visibility/get-shared/copy-shared`；分别检查权限、共享内容与副本身份。 |
| 模板与原件 | `canvas templates/template-get/template-create/template-source/template-asset-get/from-template/append-template/template-delete`。创建核所属/revision并提交完整已保存图，未知创建先查不重发，删除模板与来源独立。图片须有唯一原 inputMount/nodeAssets，模型按实际格式/魔数下载，不换缩略图或失败后的其它资源。 |
| 图编辑 | `canvas graph-edit` 接受完整 `canvas get` JSON、CLI `result` 包装、保存输入及自身历史；保留 canvas/project/revision，`expected_canvas_id/project_id/revision` 只比较、不补造身份。`params` 整体替换，`patch_params` 只 set/unset 顶层键，嵌套值整体替换并保留 null。拒绝不能无损保存的保留键和无效历史，undo+redo 合计≤100步；布局不保证网页同排布。网页Agent合法空输出端口仅在单输出节点可唯一解析时接纳，保留原JSON；多输出不猜，Lab仍核选择。只改本地，另行 `canvas save` 后读回新 revision，不能用旧版本覆盖远端修改。 |
| 节点目录与容量 | `canvas tools`；运行时读取 `cli_support.max_canvas_nodes`，已核目录声明为200。本地≤1,000节点/4,000边只是解析保护上限，不代表远端容量。EXPORT_MODEL/BAKE/COMBINATION 为退役定义，其它导出命令不使这些节点可创建。 |
| 输入上传与替换 | `canvas upload/input-assets`、`graph-edit replace_upload`；素材须属于准确项目且就绪，替换检查兼容连线，不继承无证据的旧变换。 |
| 生成和处理节点 | 图片、多视图、HD/Smart Mesh、贴图、拓扑、UV、PBR、拆件、绑定及动作通过 `canvas tools/run-check`、`graph-edit/save` 和 `studio canvas-run` 映射；输入、参数、报价与实际输出分别核验，存在入口不代表全部效果一致。 |
| 原生拓扑＋UV | Canvas Retopology 可在非SmartMesh上游、`smart_poly=true` 下选择 `smart_uv=true`。真实带纹理HD来源经单节点、单步骤完成，原图其它节点/边不变；约198万面降到1106面，UV及烘焙贴图、网页正侧视和准确35点账单已核。材质粗糙度发生变化，目标面数非精确上限；不能外推所有输入、通用高级材质烘焙或官方v3身份。 |
| 运行与历史 | `canvas run-check/run-get/runs/run-stop`、`studio canvas-run`；保存 revision、准确 run 与上游资产须匹配，未知状态不新建运行补救。 |
| 结果选择与交付 | `canvas node-assets/asset-get/asset-select/batches/batch-select/save-to-studio`、`studio asset-download`；选择、入库和下载独立，不以“最新”、缩略图或不同身份代替准确结果。 |
| Agent 会话与消息 | `canvas sessions/session-create/session-get/session-history/session-mode/turn-plan/turn-stop-plan/answer-plan/turns/turn-get/turn-cancel/events/watch`、`studio canvas-turn/canvas-continue`。0.1.10 新增的 `session-history` 两轮读取会话、显式六状态回合列表及每回合详情，逐条核消息ID、正文、顺序、状态和归属；分页提示或超限标 incomplete，不虚构游标。三个真实会话59条消息/15回合一致，最大29条/8回合；60回合240消息只是离线回归。`history_complete` 保持 null，不用稳定快照证明服务器无截断。session-create 会切换默认 ACTIVE 会话并归档旧会话，旧历史保留。 |
| Agent 停止顺序 | `canvas turn-stop-plan` 只读准备准确回合，核两次发现快照、计划节点和逐个 GetRun；先 `turn-cancel`，确认 CANCELLED 后再重新准备仍活动的准确 `run-stop`，最后复核。网页实测 CancelTurn→CANCELLED→StopRun→STOPPED，模型步骤 ABORTED/studio_cancelled；CLI 的另一次准确 CancelTurn 后，重读已得到对应运行 STOPPED，页面记录没有额外代发 StopRun，因此无需再停一次。这是普通 Agent 运行，不代表 Holy 节点 Stop，也不把未实际调用的 CLI run-stop 算成写入验收。发现分页、超限、缺 runId、未知状态或变化时 `ready:false`；无关空等待节点若归属不可证也会阻止完整停止准备。ListCanvasRuns 已出现空数组而当前图仍有运行，不能据空列表宣称完整历史；`history_complete:null`。准备不是原子锁，提交可能遇到自然完成，不能把 DONE 当取消成功。 |
| 附件与失败重试 | `turn-plan` 新消息≤30附件、正文≤200,000 Unicode码点，低层≤100引用；只排除准确已知附件标记。提交复核附件、节点引用和目标：当前项目 READY 或精确节点唯一可用结果，保顺序/重复/来源。复制重绑须有 save 读回证据，不能按名称/数量/“最新”猜；历史 retry 仅合法、可重试 FAILED 的最后 USER 消息。Holy 目标只从服务 cardJson 中明确的 capabilities 与 targetNodeId 恢复，核对其在当前保存图内且为 Holy 节点；输出 source_target_node_id，参数恢复 node_id。缺目标仍返回 retry_holy_molly_target_unknown、ready:false；格式/能力不符或目标缺失/变型拒绝，不从附件、正文、临时字段或现存节点猜补，也不接受调用方覆盖。原本地 job 恢复不受影响；准确本地终态 job 的 redo 是新创作，不能当只读恢复。合法 FAILED 已有线上正例：准确 USER 目标恢复→新回合→新 run/节点/HTML，原件下载、原附件 SHA、依赖加载、方向键、收集阈值、暂停/恢复及 Restart 归零通过，该新运行已 SETTLED；这不等于原生节点 Retry 已验收。 |
| 答案与 Skip | `answer-plan` 按真实卡片/题目/选项/部件准备，不提交。准备结果保留已识别卡片的标题、说明、计划组、需求和问题，供调用方审阅；卡片估价是展示信息，不替代报价或费用同意。Other≤500码点，部件1–12项、每项≤200且非空不重复；单/多题与 Skip 按卡片语义，不把标签当特殊值。过期、已答、变更卡片或不可用素材拒绝；Skip 可能继续收费，取消用 `turn-cancel`。真实双题 Other/逐题 Skip→单选确认→原回合生图、原件和网页展示已通过；普通 confirmation/gate 在准备层省略 selectedOptionIds，低层续答采用空 selected_option_ids，不能照原卡按钮 ID 当选择卡提交。新增真实 confirmation/plan→Detect→parts 确认链已通过，改名回显、两个新拆件原件及网页展示一致。真实候选 selection→plan 确认→有纹理 HD 模型已通过：选中的头部参考与服务输入对象精确一致，原件贴图、几何及网页正侧视均验收；不能从选项编号推断资产身份。Holy 推荐卡为 selection，真实 confirm 请求与 CLI 参数一致；该样本随后只返回计划文字并 FAILED，因此不算游戏交付通过。其它卡片和提示语仍须分别验收。 |
| 准备与提交间隔 | ready/binding 是读取快照，不是原子锁，低层提交不自动消费全部准备摘要。ContinueTurn 提交前要求准确原回合仍为 WAITING_FOR_USER；保存、回答、消息和 Lab 是独立意图，须显式接受可变费用。本地 `--request-id` 与网页 `--remote-request-id` 不同，后者默认由持久 job UUID 生成，不复用原 turn requestId 触发静默去重；恢复不新建 turn/Lab。 |
| Lab 说明与历史 | `canvas lab-inputs/lab-plan/lab-instructions/lab-jobs/lab-job-get/lab-job-cancel/bind-lab`、`studio canvas-lab`；当前网页说明面板只有 Copy/Reuse；说明由服务自动保存，GetLabTaskInstructions 读取状态，SaveCanvas 携带的 taskInstructions 只是画布镜像，不是独立手工保存说明接口。lab-instructions 保留服务数据并返回 validation/cli_support；未知或异常保存状态不能继续复用。`run_again` 保终态历史原 prompt/inputs，缺 inputs 不等于空；`reuse_instructions` 用已存说明和全部当前可用上游，说明可能是归纳，普通 lab-inputs 去重规则不同。只有保存基线才能确认上游变化，限额内未找到不算不存在。 |
| Lab 输入 | prompt trim后≤200,000码点；网页 reuse 特殊分支无相同检查，CLI仍保此上限。视频是明确 Lab 附件，不冒充图片节点。已应用动画要求完成 run、CURRENT模型和 applied 标记，独立动作须完整解码，静态骨架不算动作。 |
| 元素拆分与贴图参考 | `canvas extraction-plan/texture-reference` 只准备图动作/运行参数，另行编辑/save/run。父 detect/generate/retry 与单子图 CreateRun 不同；部件1–12项不重复、每项≤200码点，数量/模式/parts组合不静默忽略。换源清旧参数/检测清单，只有匹配新 Detect 回执、指纹和 revision 才解除失效；丢记录不冒认旧清单有效，显示0不证明免费。Canvas拆图图片不等于 SmartSegment的GLB/mask/标签。 |
| 分割最终模型 | quick_cap省略/true走分割→mesh_fill，交付唯一冻结最终件，原task只指中间件。false为服务未封口分支，不是当前网页关闭控件；保旧中间件，来源不唯一则 needs_attention。单最终模型可继续处理，多模型须选准确来源，不随节点重跑漂移。 |
| HolyMolly 游戏 | `canvas get/graph-edit/save` 支持节点/分组及 `html`→HolyMolly `html`、`html`→Lab `input`。Agent 请求显式 `capabilities:["holy_molly"]`，素材走 refs/attachment_ids，修改已有游戏用准确目标 node_id；`turn-plan` 对应字段为 nodeId。空正文仅允许显式能力、已保存 Holy 目标且无普通附件，低层须传 `text:""`；新建游戏不能仅选能力就提交空消息。`answer-plan` 保留推荐卡说明。`canvas-run` 和新增/复制 materials 图边拒绝，已有图保留；已测 html→materials 返回5415。新游戏已验证使用与原附件 SHA-256 一致的图片；定向修改的目标身份、颜色和收集阈值已有实测。服务保留原节点并生成新版本节点，验收沿本轮 turn/run/新节点/资产核对，不要求覆盖原节点。 |
| Holy 节点停止与重试 | 0.1.10 的 `studio canvas-node-stop/canvas-node-retry` 映射网页 StopNodeExecution/RetryNodeExecution，仅已保存 Holy 节点；必需 canvas_id/node_id/expected_run_id 和十进制字符串 revision。stop 要求原节点/运行活跃，不索新生成预算，原账单独立。已适配真实 Stop 的准确原 runId + status=accepted 回执，保存 accepted_run 并查询原 run；独立 turn 回执另行核验，冲突身份拒绝。只以准确原 nodeRun 的停止/取消状态确认，旧状态被替换则 STOP_STATE_UNAVAILABLE。真实早停出现 stopRequestedTime/stopping 后最终 FAILED；再次实测的新请求正确保存 accepted_run，但节点仍完成为 DONE/SUCCEEDED。网页原生节点 Stop 也复现服务记录 stopRequestedTime 后最终 SUCCEEDED；这类结果均保留 STOP_NOT_CONFIRMED，不能把受理、助手 stopped 文案当停止。retry 要求原节点/运行终态、retryable=true 和 accept_variable_cost=true，目前没有 eligible 线上正例。本轮更早的 analysing 阶段单次Stop也被准确受理，最终原node/run/step为FAILED，网页显示生成失败，不能算STOPPED。先持久化 job 再提交；预检非原子，既有 outcome_unknown 不补绑或重提，不按最新 run 补认。停止成功及原生节点 Retry 验收仍待补齐。 |
| Holy 原件、试玩与账单 | `canvas audit` 支持 expect.kind=html；优先识别当前结果 URL 路径后缀，路径无后缀时才取 filename，查询参数不参与判定。分类不是字节或玩法检查。entry_url 是移除查询参数的诊断线索，不是原件下载地址；试玩、分享与下载分开。新游戏已通过 HTML 原件下载、画布内 Play、原生方向键收集、胜利及 Restart 验证；修改版本已实测新阈值、Space 暂停、Pause/Resume 按钮和 P 快捷键；暂停时角色位置不变，恢复可移动，Restart 恢复起点与零分。已核对应 HTML 和脚本原件；渲染循环仍更新不表示游戏未暂停。其它产物仍须分别检查依赖和玩法，图片/模型检查器不能验游戏。game.credits 来自节点运行，PENDING/未知不等于零，任务终态不证明 SETTLED。费用归属独立核准确 run/turn/node/step，attribution_scope=node_run_record；ledger_attribution=not_checked 表示未做账号流水匹配，不能按类型、时间或金额猜绑。修改版本已有 SETTLED 正例，首次生成仍为 PENDING，不能把整个创作链视为已结算。 |
| 聊天后画布审计 | `canvas audit` 只读准确画布、可选会话/回合、目标节点与资产，前后复核快照；expect核类型、数量和精确资产。单次≤100节点/1,000资产身份，超限缩小范围。artifact_ready/met可为null，跨图挂载可下载不证明READY；仅报告运行/等待/阻塞/待审，`requirements_met=null`。分别报告 run_attribution、current_selection_association 与 turn_attribution：当前选中资产可来自旧运行，生成归属还须匹配可信原件路径中的准确任务/步骤身份。已证生图、HD 基础/有纹理模型、贴图模型与 Holy HTML 的受限路径；有纹理 HD 的原件目录和文件名内任务 ID 均须匹配准确步骤，不接任意同目录文件名；新增完整、一对一的多节点 run 支持，真实 CHAT 双图、双步骤生成归属已通过。Smart Mesh、拓扑、绑定、PBR 与 Smart UV 增加已取证 task→原件目录合同，但既有样本来自 CANVAS run、无 turnId，不能算聊天归属已实测。同节点多步骤可用唯一准确 `currentStepId`，须全部run节点覆盖且step/task身份无歧义，不能按时间、序号或retryNo选最新；真实SemanticSplit三节点四步骤的运行与当前选择已通过，内部task到原图UUID仍缺证据，因此生成归属保留unknown。scope 只汇总所选产物，不证明整图、原件字节、视觉或账单流水；历史完整性另验。 |
| 原件与目标验收 | `studio artifact-inspect` 解码PNG/JPEG/WebP及自包含GLB/glTF，以下载回执SHA绑定原件，画布指纹不能代替。`requirements_status:failed`是正常未通过报告，不能只看退出码；无条件仅报告事实，条件通过不证明用户目标。Agent须实际看图或按需用本地snapshot审视角/动作，缺证据保留未检查。 |
| 检查器范围 | 单文件≤150MiB，图片≤16帧/总4,000万解码像素；模型统计默认场景节点实例几何，不含未使用场景，包围盒不应用蒙皮/morph。独立无几何动画、Draco及未支持材质扩展纹理不能冒称通过；可下载格式不等于本地检查器已覆盖。 |
| REVIEW 批准 | `canvas review` 批准/撤销网页节点，会写远端；审计与原件检查不会批准或生成。文件有效、外观和用户目标分别验收，不能以只读验收自动批准或执行。 |

## 剩余工作与验收顺序

以下是继续实施的清单，不是完成声明。先追当前网页代码和真实请求，再核原件、网页效果与结算；条件不成立时记录原因，不重放未知写入。已完成的有限正例用于回归，不代替未验分支。

| 顺序 | 尚未完成或需扩大验证的项目 | 当前原因 | 下一步与验收标准 |
| --- | --- | --- | --- |
| P0 | Holy Stop 的真实停止结果 | CLI 与网页原生节点 Stop 均已记录准确停止请求，但 Holy 服务仍可能 DONE/FAILED；普通 Agent 的 CancelTurn→StopRun 已有 STOPPED 正例，不能替代 Holy 节点验收 | 只在新的明确测试意图出现有效停止样本时核对；须原 nodeRun 有停止/取消终态。不能把受理、stopping 或助手文案当完成。 |
| P0 | Holy 原生节点 Retry | Studio Free Retry 已完成合法样本的提交、生成、原件和网页加载；Holy 样本仍不满足 retryable=true | 遇到服务给出的合资格原节点才单次提交，核准确新运行、原件和费用；不改字段制造资格，Free Retry 不能替代 Holy Retry。 |
| P1 | 价格快照持续维护 | 0.1.10 内置重新核对的43个网页常量、5个派生数值及3项无预报价声明，7份当前来源已联网校验；内置快照于2026-12-01 14:06:51 UTC到期。历史包和旧Release快照不变 | 按 `pricing status` 的实际期限重新取证，发布新快照及固定来源摘要；不简单延期旧表、不把缺价写0。无预报价仍需显式同意且省略数字预算，过期继续阻止新提交。 |
| P1 | 待结算及缺唯一归属的费用 | 首次 Holy 运行仍 PENDING；稳定完整分页账单仍含无法关联的全零 operator，部分图片、导入和 Free Retry 无准确匹配。两个准确旧停止模型账单已补证 cancelled | 继续以准确 run/node/operator 对账；已结算节点与 fulfilled 流水有重叠，不重复累加。缺记录不记0，cancelled 不宣称整回合免费或已退款。 |
| P1 | 稀有卡型、超长历史与内部生成归属 | 已补数字5计划卡、六状态历史读取和 currentStepId 多步骤归属；三个真实会话59消息/15回合一致，Parts三节点四步骤的运行与当前选择通过。内部 task→原图UUID仍缺证据，服务器历史截断与全部罕见卡型仍未穷尽 | 仅按新准确证据扩大生成归属；不按时间/序号选“最新”。真实历史与离线大样本分开，history_complete 保持 null；未知卡或内部产物不补造身份。 |
| P2 | 官方效果差异 E23-01…E23-14 | Gaussian、图片参数、自动尺度/对齐、算法版本、复杂分割/变换、贴图/UV/动画等尚有未等价范围 | 按上方官方差异矩阵逐项寻找效果相同的网页链；每项须请求、原件及效果证明。网页前端计算可提供已披露的本地对应，不能换 API 钱包或悄悄忽略参数。 |
| P2 | 网页和环境边界 W23-01…W23-12 | 全菜单条件、特殊格式、DCC/宿主/原生系统及任意输入不能由当前样本覆盖 | 用实际入口、所需权限、准确输入和原生环境复验；缺设备/权限/可用样本或服务拒绝分别记录，不以目录和离线测试充作现场通过。 |

本轮新增闭环包括：有效审阅价格与无预报价同意合同、完整UV四步压缩链及网页对照、独立Studio Free Retry生成/原件/网页加载、真实会话逐消息一致性和多步骤准确运行归属。Holy更早停止仍为FAILED，生成语义、内部图片来源和未结算费用继续独立记录。高级差异逐项复核了当前网页代码；缺新原生合同、合资格状态、原件或目标环境的项目没有改成已完成。上述新增能力纳入0.1.10；不同入口、平台和输入范围仍按各自证据验收，未通过项不会因发布而变为完成。

## 本地对应、交接与恢复

| 能力 | 限制 |
| --- | --- |
| 笔刷 | 自包含带 UV0/基础贴图 GLB、底图≤4K，无 texture-transform；球刷/投影按基础位置与节点矩阵，不采样任意动画。填桶是整部件 UV 覆盖，erase 恢复本地历史原贴图，不是透明洞或远端撤销。≤128 动作/笔画 1000 点；GPU 边缘差异不保证逐像素，保存可转 JPEG 并收费，AI 预览仍拒绝 ultra/segmented。 |
| 视口、分享、视频 | Blender本地对应，视频另需FFmpeg；shader/骨架叠加/explode不逐字复制网页，`preview.pixel_equivalent=false`。相机自动取景/视频有限姿态采样不保证任意动画全程框内；unlit/toon需底图，骨架需skin。HDR/艺术资源按需取得不随包分发，许可见[第三方声明](../THIRD_PARTY_NOTICES.md)。 |
| DCC Bridge | 需目标软件官方插件，默认回环连接；GLB/FBX/OBJ/ZIP≤150MiB、5MiB分块。`transferred`只表示传输，`imported`才为插件导入；不等待时 imported=null。断线/未知不自动重发，file_id不保证远端去重。完整导入验收限Blender Bridge 1.1.0＋Blender4.5的GLB/FBX，其他目标未全验。 |
| 打印与精修 | 打印计划/未execute不下载、不启动或导出；只消费当前账号成功导出，多产物须选，ZIP不冒充3MF。切片器交接不保证可打印或实体结果，OBJ未请求顶点色不算多彩打印。shop不自动改可见性、下单或付款；人工精修须有实际完工结果。 |
| 原请求与批量 | 相同 request_id复用冻结意图/来源；`@last`等自动引用首次绑定后不漂移，改参数或别名来源冲突。相同batch manifest可补下载，`--fresh`/redo为新生成意图。旧请求使用原步骤/策略，不补造新义务或因新路线可用改写失败。 |
| 对账 | `ai_modeling_job_reconcile` 只接可验证的原回执；Canvas Agent、续答、Lab 及 Holy 节点 stop/retry 的未知创作回执返回 `RECONCILE_UNVERIFIABLE`，不接受手填 Turn/Lab ID 猜绑。已有 ID、同画布、余额/时间或相似内容均不足以证明原请求归属。batch按原项目顺序合并，拒无关、重复及替换已确认项，并保护并发确认。下载接口只返回URL时，不虚称额外服务身份回显。 |
| 多目录与缓存 | 已登记文件须匹配来源、证明、摘要及实际文件/父目录身份；同字节陌生副本不获覆盖权。旧丢失登记目录不从日志追认，选择新空路径，保留旧文件。缓存缺失、损坏或原来源证据不足明确失败，不新生成补救。 |

所有新条件仍需合法输入、完整请求链及相应产物检查。未验证项继续明确保留；使用和贡献中的账号、隐私与公开证据边界见[安全说明](../SECURITY.md)及[贡献指南](../CONTRIBUTING.md)。
