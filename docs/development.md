# 开发、验证与分发

本文面向贡献者和分发维护者。安装、配置与用户流程见[使用指南](usage.md)，功能状态和条件限制集中在[兼容范围](compatibility.md)，参数以[命令目录](commands.md)为准。

## 架构与依赖方向

依赖方向固定为 `mcp/` → `cli/` → `studio/`。MCP 通过同包 CLI 的 `tools` 获取定义，通过 `call ... --input-stdin` 执行业务；CLI 统一负责参数校验、凭据、任务编排和恢复。Agent 选择 MCP 后仍通过 MCP 工具执行，Skill 渐进加载说明、示例和可组合流程，不建立另一套引擎。

| 目录 | 责任 |
| --- | --- |
| `studio/` | 网页鉴权、HTTP/RPC、上传、接口契约、价格与错误分类 |
| `cli/` | 命令、任务编排、SQLite 状态、素材缓存、下载与本地处理 |
| `mcp/` | stdio MCP 协议、CLI 子进程调用与结构化结果转换 |
| `tests/` | 命令合同、状态机、安全边界与产物验证 |
| `scripts/` | 构建、文档检查、包清单与发布维护 |
| `skills/ai-modeling/` | Agent 指导及参考资料，沿用用户选定的执行入口 |

优先使用经验证的 Studio 接口；网页前端计算可以提供明确标注的本地对应实现。追踪上传、授权、准备、提交和查询的完整链路，不能仅凭字段同名或请求成功判断效果等价。未支持组合明确报告，不切换开发者 API 钱包或其它提供商。

npm 包为 `@seekskyworld/ai-modeling`，唯一可执行入口和 Skill 为 `ai-modeling`；MCP 使用 `ai-modeling mcp`，配置为 `AI_MODELING_*`，工具为 `ai_modeling_*`。不增加旧名称别名或状态回退，保留提供商域名、模型 ID 和第三方署名。

指南只有一份内容源：CLI `guides list/templates/read` 与 MCP `ai-modeling://guides/{usage,commands,pipelines}` 共用它。`usage`、`pipelines` 读取 Skill 的同名参考文件，`commands` 读取命令文档；命令索引及 `commands/{+command}` 模板由当前命令树生成。发现和读取指南不得初始化任务库、读取凭据或提前加载图像原生模块。

Skill 安装管理依据客户端目标元数据和管理记录运行，保留用户改动及未管理文件；不隐式绑定 Codex，也不修改 MCP 配置。Golutra Agent 的离线适配器从 `toolMetadata` 投影清单，每包最多 64 工具，保持 schema 与环境变量名称合同，只导出而不注册插件。宿主限制集中在[兼容范围](compatibility.md#基本合同)；清单验证不能替代真实宿主发现及调用验收。

## 认证、身份与恢复

凭据、会话、上传引用及独立 LLM 密钥使用私有 JSON 存储；`JsonStore` / `JsonEntry` 管理凭据，`JsonLinks` 管理产物链接。认证根固定为 `userInfo().homedir/.ai-modeling-auth`，条目使用 `credentials/<sha256(service)>/<sha256(account)>.json` 和 `schema_version: 1` envelope。业务目录或 `HOME`/`TMPDIR` 变化不能分裂同 OS 用户/profile 的认证与撤销作用域；生产不提供认证根重定位。

| 边界 | 必须保持的合同 |
| --- | --- |
| POSIX 文件 | 目录 `0700`、文件 `0600`；读取验证大小、结构、所有者及 no-follow 文件身份，写入采用同目录临时文件、fsync、原子 rename。 |
| Windows 文件 | 有界 PowerShell 验证受保护 DACL，仅当前用户 SID 与 SYSTEM；拒绝 reparse point 和额外 allow ACE。chmod 不代替 ACL 验证。 |
| ACL 修复 | 仅应用自有认证控制目录/登录状态可在归属、非 reparse 与文件身份验证后收紧；不改内容、nonce 或撤销信息。私有 ACL 不重写，凭据条目和外部导入文件只验证、不修复。 |
| 失败分类 | 保留 `CREDENTIAL_STORE_UNAVAILABLE`、`AUTH_DIRECTORY_INVALID`、`CREDENTIAL_STORE_BUSY`，区分读取失败与写入结果未知。 |
| 秘密与浏览器 | JSON 值未额外加密，不复制到 SQLite、MCP 参数或日志；浏览器会话验证后才能保存。CDP 仅接受显式回环地址，只清理工具自建资源，不自动访问旧钥匙串。 |

登录协调器按 OS 用户/profile 共享，取消、退出、迟到验证和凭据更新受锁与版本检查约束。交互 CLI 可在安全边界等待登录；非交互 CLI/MCP 返回可恢复状态，不能无限等待或重放已发送写入。

提交前冻结意图、账号、输入身份与 `request_id`，核对报价；上传或登录等待后，在实际远端写入前再次验证固定报价期限。恢复原账号、来源和回执，不能按新任务重跑准备步骤；修改意图返回 `IDEMPOTENCY_CONFLICT`。锁过期、认证失败或响应丢失不证明写入未执行，未知提交先对账，不自动重发。

SQLite 迁移保留一致备份，CLI/MCP 一同升级。下载和缓存绑定来源、账号、摘要及文件身份；验证临时字节后交付，不覆盖无关文件。产物不符合要求时保留回执与 `needs_attention`，不再次付费生成。

## Canvas Agent 验收方案

验收能力保持可组合，区分远端执行结束、资产可用、机器条件通过和用户目标达成。具体入口和限制见[Canvas 兼容表](compatibility.md#canvaslab-会话与模板)，使用示例见[Canvas 验收流程](usage.md#canvas-agent-聊天后的验收)。

| 契约 | 实现与验收要求 |
| --- | --- |
| 快照与归属 | `canvas audit` 只读精确画布、会话/回合、节点和预期资产，GetRun 也纳入前后快照。运行归属、当前选择关联和产物生成归属分别判断；选择旧资产可保留新 run，不能据 selectedAssetId 推断生成来源。支持的生成证明还须核对可信原件命名空间中的准确 task/step 身份。缺证据保留 unknown，身份冲突和读取错误不可吞掉。 |
| 历史核对 | `canvas session-history` 显式读取六种已知回合状态，以两次稳定快照比对会话与回合消息。服务器截断/留存完整性仍未知；发现分页或本地超限返回 incomplete，不凭两端相等推断全量历史。 |
| 原件与机器条件 | 下载绑定准确来源；`artifact-inspect` 解码原件并核摘要、文件身份及显式条件。损坏、空几何、条件失败或读取中替换不能通过，缩略图不能替代原件。 |
| 语义验收 | 机器条件通过不等于用户目标达成；Agent 只有实际查看图片或必要模型视角/动作证据后才能给视觉结论。文件检查报告失败是正常业务结果，调用成功不能充作验收成功。 |
| 停止准备 | `turn-stop-plan` 只读发现准确回合、计划节点和当前运行，逐个核对 GetRun，并比较两次快照。回合取消确认后才给出准确活动运行的停止参数；缺失身份、超限、分页或变化阻止准备。历史完整性保持未知，未知写回执不重放。 |
| 写入与恢复 | 审计不复用 `canvas review` 的批准写接口，也不自动运行下游；下载失败恢复原件，未知写入查询原回执，新增创作遵守原授权。 |
| 编辑与发现 | 查询 JSON 导入保持 Canvas/project/revision，编辑与远端 save/run 分离；局部参数修改不清空无关键。服务目录、图可编辑、可创建和执行映射分别表达，未知目录不算全支持；本地解析上限不等于远端容量。 |

指南由 CLI 与 MCP 读取同源文件。回归覆盖真实进程边界、运行/等待/失败状态、身份不匹配、快照变化、准确产物选择、损坏原件、机器条件差异及原请求恢复；功能细节和未验范围只维护在兼容表。

## 开发与本地检查

使用 Node.js **24+** 和 npm。自动测试使用合成数据及隔离状态，不要求 Studio 账号。

```sh
npm ci
npm run check
npm run package:check
```

| 检查 | 范围 |
| --- | --- |
| `check` | 依次执行版本、离线工作流合同、TypeScript、ESLint、Prettier、文档、测试及构建；可按改动单独执行对应脚本。 |
| `workflow:check` | 离线检查权限、触发条件、归档门禁、提交占位与版本推进，不代替 actionlint。 |
| `node scripts/actionlint.ts` | Linux/macOS x64/arm64 下载固定版本并验证 SHA-256，执行后清理；联网检查独立于 `check`，未执行须如实记录。 |
| `docs:check` | 检查本地链接、标题锚点与 JSON 示例，不验证外部网站在线状态。 |
| `package:check` | 已构建后检查 `npm pack --dry-run --ignore-scripts --json` 的实际清单、许可、私有标记和包内链接，不打包或发布。 |
| `npm run --silent capabilities` | 从命令树、四种工具集配置和模型注册表生成来源清单；不接触账号。`--out` 只接受源码外、父目录已存在的新文件，不加入标准六产物。 |

测试统一经过 `scripts/run-tests.ts`，例如 `node scripts/run-tests.ts tests/guides.test.ts` 或 `npm test -- tests/guides.test.ts`。该入口合成 OS home、会话/私有存储和 profile/state，并将测试网络限制到回环；不修改用户 HOME、不添加生产测试开关。默认最多四路，可传 `--test-concurrency=2`；不能绕过入口直接运行测试文件。

部分几何集成测试需要 Blender **4.5+**，用 `AI_MODELING_TEST_BLENDER` 或 `AI_MODELING_BLENDER` 指定；未设置的相关用例会跳过。视频另需带 libx264 的 FFmpeg。报告保留通过、失败和跳过的区别。

## 验证范围与报告

| 验证层次 | 应记录的证据 |
| --- | --- |
| 离线 | CLI/MCP 合同、状态机、并发、文件和数据库边界；替代凭据、浏览器及服务不算线上验证。 |
| 原生环境 | 操作系统/浏览器版本、私有目录权限、会话验证和命令接续；模拟 Windows 分支不算原生 DACL 验收。 |
| 真实请求 | 授权范围、实际积分消耗、完整请求链、原身份及远端状态；首次密码、验证码、2FA 和身份提供商交互由用户完成。 |
| 产物与网页 | 几何、尺寸、纹理、材质、动画和实际操作效果；请求成功不代表文件正确或效果等价。 |

认证改动覆盖空/失效会话、Host/Origin、JSON 损坏/超限、符号链接/权限、原子替换、并发更新、账号切换、跨数据目录撤销和资源清理。只公开合成/脱敏证据，原账号数据、签名链接和现场日志不入公开文档。测试源码路径、有限样本和配置文件均不是已通过的运行记录。

## CI 配置

| 工作流 | 配置与权限 |
| --- | --- |
| `check.yml` | 分支 push/PR 执行 Linux/Node.js 24 检查、构建、包清单和独立生产依赖审计/actionlint；安装矩阵覆盖 Ubuntu 24.04、macOS 15、Windows 2025。 |
| `package.yml` | 手动候选检查及标准导出，三系统验证同一 TGZ，汇总两类平台报告、readiness 和候选说明；归档保留 90 天。 |
| `release.yml` | 版本标签触发正式发布；手动 dispatch 只对所选 ref 完整预演，不进入发布状态协调器或写入 npm/Release。 |

普通检查和候选仅 `contents: read`；正式 publish/promote job 使用最小 `contents: write`、`id-token: write` 和 `npm` environment。第三方 Actions 固定完整提交 SHA，升级审阅注释及离线合同；合成发布回归不代替托管验收。公开 `SECURITY_CONTACT_URL` 应指向已启用的[私密报告入口](https://github.com/seekskyworld/ai-modeling/security/advisories/new)，缺项阻塞候选。

安装矩阵分别执行平台路径、JSON 凭据和撤销回归；Windows DACL 用例在其它系统跳过。矩阵是配置，不是成功记录；实际报告只证明对应检查，不外推浏览器登录、Blender/FFmpeg、宿主调用或全部 Studio 业务。临时 workflow artifacts 有期限，不作为稳定下载或唯一发布凭据。

## 准备版本

`package.json` 是唯一手工维护的程序版本来源，`version.ts` 供源码、CLI 与 MCP 共用。使用 `npm version patch --no-git-tag-version` 同步锁文件，再运行 `npm run version:check`；不要手改生成的 `dist/`。审阅 [CHANGELOG.md](../CHANGELOG.md) 和公开说明，只有真正发布时才把 Unreleased 条目移入有日期的版本。相同版本号下的源码修改不会改变已发布归档。0.1.5 的手动 npm 发布不等于 GitHub OIDC 发布验证；在非 Windows 环境跳过 Windows 专属测试时，原生 Windows 验收仍须单独完成。

## 打包与分发

一个 `@seekskyworld/ai-modeling` 运行包提供 CLI、MCP 和 Skill 指导，无需分别发布引擎。检查、审计通过后创建标准候选：

```sh
npm run check
npm run package:check
npm audit --omit=dev
npm run export -- --out ../ai-modeling-export --target all
```

导出目标须在源码外、父目录已存在且目标不存在；校验软链接，先在同级临时目录准备，成功后发布且不覆盖。单目标导出见[使用指南](usage.md#从源码导出或运行)。

| `all` 产物 | 用途 |
| --- | --- |
| `ai-modeling-skill-VERSION.zip` | Skill、参考资料和许可，仍需运行包 |
| `ai-modeling-VERSION.tgz` | scoped npm 包的 CLI/MCP 归档 |
| `mcp.json` | 已安装命令的 MCP 配置，不含机器路径或凭据 |
| `INSTALL.md` | 安装指导 |
| `manifest.json` | 版本、摘要、来源提交/状态、工具链与依赖溯源 |
| `SHA256SUMS` | 校验和 |

实际 npm 清单须包含运行资源、Skill、五份核心文档、公开根文档、示例及许可，排除会话、浏览器状态、数据库、调查记录、旧包和用户素材；`.gitignore` 不代替 TGZ 清单检查。归档文件名不带 scope，包内元数据和 registry 地址使用 scoped 名称。

源码锁文件锁定开发依赖；标准导出依据审阅后的生产 shrinkwrap 在临时目录锁定安装，绑定可移植生产依赖及许可，不复制开发 `node_modules`。原生入口及精确版本的平台可选依赖交由 npm 安装，不能将外置依赖悬挂在绑定的原生入口下。验收比较实际依赖树及字节，并验证真实全局安装；锁文件存在或本地 npm 的自动提升不证明全局可用。直接 `npm pack` 不替代标准导出。

不分发无权再分发的网页素材、浏览器、Blender、FFmpeg 或外部转换引擎，保留[第三方声明](../THIRD_PARTY_NOTICES.md)。候选来源、摘要和验收材料须对应当前原件，不沿用旧包报告。

## 安装验证与发布候选

```sh
npm run package:smoke -- --archive ../ai-modeling-export/ai-modeling-VERSION.tgz
npm run package:consumer-smoke -- --archive ../ai-modeling-export/ai-modeling-VERSION.tgz --require-locked
npm run release:check
```

`package:smoke` 解包、锁定安装并链接临时全局入口，验证 CLI/MCP、唯一 bin、版本、指南及依赖。`package:consumer-smoke` 分别检查本地 npm、真实全局 npm、npm exec/npx、Skill 管理、MCP 发现及原生模块加载，功能与依赖版本/完整性分别记录。`--require-locked` 将漂移作为失败；这些临时配置检查不登录或生成素材，也不代替公共 registry 安装。

Linux、macOS、Windows 的 `smoke-{platform}.json` 和 `consumer-{platform}.json` 必须绑定同一 TGZ。缺报告或 `CONSUMER_DEPENDENCY_DRIFT` 阻塞发布就绪，功能通过不能抵消依赖漂移；没有原生成功回执的平台保留未验收。

`release:check` 核源码元数据、可追溯且干净的提交和价格期限，默认至少剩余 24 小时；不联网验证联系人/价格、不自动续期，`scope: source` 的 ready 只表示源码前置条件。候选汇总使用：

```sh
npm run release:prepare -- --distribution ../ai-modeling-export \
  --smoke-dir ../ai-modeling-smoke-reports --out ../ai-modeling-candidate \
  --repository https://github.com/seekskyworld/ai-modeling \
  --security-contact https://github.com/seekskyworld/ai-modeling/security/advisories/new \
  --require-ready
```

生成 `RELEASE.md`、`readiness.json` 和验收材料，不写远端 Release/npm；缺项保留 blocker，`--require-ready` 非零退出。发布前以最终提交和原产物重核，避免复用已过期价格或变更后的候选状态。

## 自动 npm 发布

版本标签必须匹配包版本，并绑定解析出的完整来源提交。正式工作流固定 Node.js **24** / npm **11.17.0**；分支推送和手动 dispatch 不发布。npm 版本不可覆盖，不移动已发布标签，也不以重复推标签或上传处理索引延迟。

### Trusted Publisher 前提

npm 包配置应绑定 `seekskyworld/ai-modeling`、`release.yml`、GitHub `npm` environment，后者仅允许 `v*` 标签。核对仓库、工作流、环境、包权限及实际账号，不能仅配置本地 `.npmrc` 或按相似仓库名推定授权。

```sh
npm trust github @seekskyworld/ai-modeling --file release.yml --repo seekskyworld/ai-modeling --env npm --allow-publish
```

在 npm **Settings → Trusted Publisher → Edit → Allowed actions** 同时允许 **npm publish** 和 **npm dist-tag**；npm 11.17.0 的 trust CLI 未暴露后者。登录、2FA 和身份确认由维护者完成。实际核对远端配置后才设置 `NPM_TRUSTED_PUBLISHER_CONFIGURED=true`；变量、GitHub environment 或打开设置页都不是授权证明，403 不静默换账号。

发布使用 OIDC，不回退本机登录或长期 Token。npm publish 执行 OIDC 交换，dist-tag 不自动交换，所以 promote 使用受限仓库/标签/工作流/environment 身份取得包级短时令牌，仅存内存。首次真实交换、渠道写入和读回各自验收；配置和离线测试不代表已成功。

### 同一归档、三平台门禁

完整检查、生产审计和标准导出后冻结六产物；三平台对同一 TGZ 执行 archive 与带 `--require-locked` 的 consumer 检查，再通过 `release:prepare --require-ready`。各平台重新打包、缺少 Windows 回执或仅本地 npm 成功都不满足门禁。

提交与恢复始终使用已验原件，不临时重构建/压包。固定身份、原资产与状态保存在版本 Release；workflow artifacts 只负责临时传递。相同版本正式发布串行，不能取消已进入提交阶段的运行来重获上传许可。

### 持久状态与恢复

`scripts/npm-publication.ts` 绑定仓库、标签、来源提交和 TGZ 摘要。先持久化冻结身份，原资产和验收齐备后记 prepared；提交前必须写入并读回唯一占位。只有首次取得占位者可以调用一次 npm，即使同 run ID 也不能重复取得许可。

| 状态或证据 | 允许动作 |
| --- | --- |
| 无历史 Release/提交，精确版本不存在 | 创建候选并通过完整门禁；网络失败不算不存在。 |
| 已有 Release、无当前状态 | `import_required`：核对并导入历史事实，不据 registry 404 重建/发布。 |
| 已冻结但资产不全 | 补回冻结摘要的原字节，不换包。 |
| prepared | 核身份/验收，取得持久占位后最多提交一次。 |
| submitting/submitted，accepted 或 unknown | 只核原提交；404、超时、进程退出、记录失败均不释放重发许可。 |
| published | 精确版本 metadata 与实际 npm TGZ 字节匹配原身份及摘要，保留证据。 |

npm 退出码 0 只代表受理。实际完成需下载精确 `dist.tarball`，核 SHA-256、SHA-512 与 registry 摘要后才公开草稿 Release；metadata 200 或另一个版本存在不替代字节验证。公共干净安装和授权业务验收另行记录。

上传先使用版本专属 `release-vVERSION` 标签，不改 latest/next。跨版本串行 promote 扫描整个持久 published 待办集合，补公开 Release，再按语义版本单调提升 `latest`/`next`；GitHub 排队任务可能被替换，不能只处理触发项。草稿先以 `make_latest:false` 公开，确认 npm latest 后再推进 GitHub Latest。每次写前重读，已是同版/更高版则跳过；响应不明读回核对，不重新上传。坏候选保留失败并继续其它候选，渠道读取失败不猜版本；人工改标签须避免与协调器并发。

发布说明由 `scripts/publication-notes.ts` 读取真实非 dry-run published 记录和原 TGZ，再核包名、版本、大小、摘要及价格 JSON。价格摘要取原来源文件字节而非编译/规范化 JSON，说明带固定提交 URL、审核/到期时间及更新命令，不增加标准分发文件。

```sh
node scripts/publication-notes.ts --verification ../npm-verified.json \
  --archive ../frozen/distribution/ai-modeling-VERSION.tgz \
  --source-dir . --out ../publication-notes.md
node scripts/npm-publication.ts check --repository seekskyworld/ai-modeling \
  --tag vVERSION --source FULL_TAG_COMMIT_SHA --out ../npm-check.json
node scripts/npm-publication.ts verify --repository seekskyworld/ai-modeling \
  --tag vVERSION --source FULL_TAG_COMMIT_SHA --out ../npm-verify.json --dry-run
```

说明生成器从原 Git 提交读取，忽略当前工作树和 replacement refs；省略 source-dir 则只读固定公共 raw URL，不携凭据、不跟重定向，JSON 限 1 MiB。失败不输出秘密、私有路径或子进程 stderr；输出位于源码外的新文件，恢复不延长原价格期限。

查询草稿需有权限的 `GITHUB_TOKEN`/`GH_TOKEN`，无权限不能当不存在。`check --restore NEW_DIR` 恢复原 distribution/candidate；`verify --dry-run` 仍读真实 TGZ，但不写状态或公开 Release，不能仅看 `action:published`。需环境代理时给进程设置 `NODE_USE_ENV_PROXY=1`，不泄露代理凭据。

历史受理/processing 提交用原回执导入 submitted/accepted，再查询原包；可用新协调器读取旧标签，但保持原提交/归档，不重推、重建或补造旧平台报告。staging 只有存在且匹配原提交的项才可审批，空列表不表示完成或允许重传。

### Maintainer workflow in English

Run the source checks and standard export, then verify the same TGZ on Linux, macOS and Windows with archive and locked npm-consumer checks. Prepare the candidate immediately before publication. The version-tag workflow requires the matching npm Trusted Publisher and environment; manual dispatch is a preview.

Retain the frozen archive and durable submission claim. Accepted or unknown uploads are reconciled, never repeated. Verify the actual public tarball before promoting channels, then test a clean public installation through the selected interface. Source changes under Unreleased do not update published versions; workflow configuration does not establish native-platform, OIDC or business acceptance.

## 价格来源维护

`studio/api/reviewed-prices.json` 是公开的单一审阅源，运行层从同文件导入。核当前网页常数、公式和工作流证据后记录真实审核时间、有限有效期及证据摘要；只改到期日不算审阅。

发布说明提供原文件 SHA-256、审核/到期时间和固定提交 URL。main 仅供发现，不是免摘要自动更新源；最终文件与公开固定 URL 字节须匹配。后续审阅可独立发布新提交/摘要，不要求账号会话。用户操作见[价格快照更新](usage.md#价格快照更新)，维护流程不得吞掉证据失败、未知或过期错误。

## npm 版本存在性与归档核对

```sh
npm run package:registry-check -- --archive ../ai-modeling-export/ai-modeling-VERSION.tgz --require-published
```

发布前可省略 require-published，发布后要求精确版本存在；`--report NEW.json` 保存结果。有 archive 时核 metadata 的 SHA-512 SRI（缺失则 SHA-1），不同即失败。此检查不下载远端 TGZ、不读 npm 凭据、不发布或证明包归属，不能替代上述实际字节核验和公共安装。

## 发布维护

只提交公开源码及文档；repository/bugs/homepage、[安全报告渠道](../SECURITY.md)与真实仓库一致，凭据不进源码、命令记录或产物。正式新版本使用标签工作流，人工恢复也遵守原身份和提交占位。

Release 附原六产物与状态证据；核公共版本、真实下载和安装说明后更新 CHANGELOG 的实际日期。保留失败和未验证范围，安装成功不等于全部官方或网页效果等价。
