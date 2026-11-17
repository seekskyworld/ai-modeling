# 开发、验证与分发

本文面向源码贡献者和分发维护者。安装与配置见[使用指南](usage.md)，功能范围见[命令目录](commands.md)和[兼容限制](compatibility.md)。

## 架构与依赖方向

依赖方向固定为 `mcp/` → `cli/` → `studio/`。MCP 通过同包 CLI 的 `tools` 获取定义，通过 `call ... --input-stdin` 执行业务；参数校验、凭据访问与任务恢复由 CLI 统一组织。

| 目录 | 责任 |
| --- | --- |
| `studio/` | 网页鉴权、HTTP/RPC、上传、接口契约、价格与错误分类 |
| `cli/` | 命令、任务编排、SQLite 状态、素材缓存、下载与本地处理 |
| `mcp/` | stdio MCP 协议、CLI 子进程调用与结构化结果转换 |
| `tests/` | 命令合同、状态机、安全边界与产物验证 |
| `scripts/` | 构建、文档检查、包清单与维护工具 |
| `skills/ai-modeling/` | 分发给 Agent 的操作说明和参考资料，调用同一 CLI |

优先使用已验证的 Studio 接口。网页自身的前端计算可提供明确标注的本地对应实现；需要追踪上传、授权、准备、提交和查询的完整链路，不能仅凭字段同名判断等价。未支持的组合应报告限制，不静默切换到开发者 API 钱包或其他服务。

CLI 是唯一底层执行接口，MCP 提供指导资源并通过薄工具适配层向 Agent 暴露能力，调用链为 `Agent → MCP → CLI → Studio`。Skills 渐进加载说明、示例和流程指导，沿用用户选定的入口；MCP 用户不绕过工具改跑 shell。npm 包名为 `@seekskyworld/ai-modeling`，唯一可执行入口为 `ai-modeling`。MCP 使用 `ai-modeling mcp` 启动默认集，需要网页扩展时显式选择 `--toolset studio`。

`guides list/templates/read` 是 CLI 的离线 JSON 入口；MCP 的 `ai-modeling://guides/{usage,commands,pipelines}` 提供同源内容。工具发现与指南读取只访问元数据，不创建任务状态或读取账号/凭据。另有命令索引 `ai-modeling://guides/commands/index` 与模板 `ai-modeling://guides/commands/{+command}`，从当前命令树生成具体帮助和 Studio 限制。`usage` / `pipelines` 分别读取 Skill 的 `references/usage.md` / `references/pipelines.md`，`commands` 读取 `docs/commands.md`，不维护重复说明或第二套执行逻辑。Skill ZIP 只携带其目录内所需参考资料，运行包携带完整 CLI/MCP 与指南。

`skill targets` 列出支持的客户端目标；`skill install/status/uninstall` 管理运行包附带的同版本指导文件，在 CLI 本地执行，不初始化账号或业务任务库。调用方必须显式选择客户端目标或技能父目录，不隐式绑定 Codex。命名目标区分用户和项目范围；安装、更新和卸载必须核对管理记录及原文件，保留用户改动和未管理内容。npm 安装运行包不会自动写入客户端的 Skill 目录，安装 Skill 也不修改 MCP 配置；独立 Skill ZIP 仍供手动导入。使用方法见[Skill 安装管理](usage.md#安装-skill)。

`mcp export --target golutra-agent` 是离线客户端适配器：从同包 `toolMetadata` 投影原生插件清单，遵守每包 64 工具、schema 精确对照和 env 名称列表合同，不静态维护另一份工具接口。它只导出到调用者选择的新目录，不注册或启用插件。CLI/MCP 的业务依赖方向保持不变。Golutra Agent 的 Skill 目标仅支持项目范围，默认值由目标元数据声明。

Golutra Agent 0.3.9 原生插件注册已实测通过，但客户端的 provider 工具白名单过滤 MCP 名称，实际模型无法发现或调用这些工具。导出器通过 `host_compatibility` 与生成的 README 保留这一阻塞；不得以清单校验或独立 MCP SDK 测试替代宿主调用验收。宿主修复后需重新验证真实工具列表及调用结果。

## 认证、身份与恢复

凭据保存于系统凭据库，SQLite、MCP 参数和日志只保留脱敏状态。可见浏览器登录先验证账号再保存会话；CDP 只接受调用方显式指定的回环地址，只清理工具自己创建的页面或连接。

登录协调器按 OS 用户和 profile 共享，独立于业务数据目录。取消、退出、迟到验证和凭据更新受锁及版本检查约束。交互 CLI 可在安全请求边界等待登录；非交互 CLI/MCP 返回可处理的登录状态。

提交前固定请求意图、账号、输入身份和 `request_id`。新提交前核对账号、输入及有效报价；恢复保持原账号、请求和来源身份并查询原回执，不重新执行新任务的前置条件，修改意图应报告 `IDEMPOTENCY_CONFLICT`。认证失败、锁过期或响应丢失都不能成为重放已发送写请求的依据，结果未知时先核对原回执。

SQLite 迁移保留一致备份，CLI 与 MCP 一同升级。缓存与下载绑定来源、账号、摘要和文件身份；先验证临时下载，再写入目标位置，不覆盖无关文件。产物不符合要求时保留原回执与 `needs_attention` 状态，不自动再次付费生成。

## 开发与本地检查

使用 Node.js **24+** 和 npm。`npm ci` 安装锁定依赖；自动测试使用隔离夹具与合成数据，不要求 Studio 账号或真实系统凭据。

```sh
npm ci
npm run check
npm run package:check
```

`check` 依次执行版本一致性、TypeScript、ESLint、Prettier、文档检查、Node.js 测试和构建。按变更范围也可单独运行 `typecheck`、`lint`、`format:check`、`test` 或 `build` 脚本。

`npm run docs:check` 离线检查本地链接、标题锚点和 JSON 示例，不验证外部网站是否在线。`npm run package:check` 要求已有 `dist/`，读取 `npm pack --dry-run --ignore-scripts --json` 的实际清单，检查白名单、必需文件、许可、私有文件标记及包内链接；它不生成安装包或发布。

`npm run --silent capabilities` 从当前命令树、四种工具集配置和模型注册表生成机器清单；`--out` 只接受源码之外、父目录已存在的新文件。它不接触账号或任务库。映射、支持条件和证据引用用于定位实现，未执行条目保留 `not_verified`；不要将测试文件路径当作已经通过的运行证据。该清单按需生成，不增加普通导出的六个文件。

`npm test` 使用 `scripts/run-tests.ts`，为测试合成 OS home、内存凭据服务、临时 profile/state，并将测试网络限制到回环地址；不修改用户 HOME，也不添加生产测试开关。定向用例用 `node scripts/run-tests.ts tests/guides.test.ts`，或 `npm test -- tests/guides.test.ts`，不要绕过该入口直接执行测试文件。

部分几何集成测试需要 Blender **4.5+**，通过 `AI_MODELING_TEST_BLENDER` 或 `AI_MODELING_BLENDER` 指定。未设置时相关真实 Blender 用例会跳过，报告必须区分通过和跳过。涉及视频的本地处理另需带 libx264 的 FFmpeg。

```sh
AI_MODELING_TEST_BLENDER=/path/to/blender npm test
```

## 验证范围与报告

| 验证层次 | 应记录的证据与边界 |
| --- | --- |
| 离线测试 | CLI/MCP 子进程合同、登录状态机、撤销与并发、文件和数据库边界；凭据、浏览器与服务使用替代接口 |
| 真实浏览器登录 | 实际浏览器与系统凭据库、会话验证和保存、窗口归属及命令接续；注明操作系统和浏览器版本 |
| 真实 Studio 请求 | 授权账号、输入、预算、完整请求链、远端状态与原始请求身份；不以离线断言替代服务验证 |
| 产物与网页对比 | 几何、尺寸、纹理、材质、动画及实际网页操作效果；任务成功不等于产物正确或网页效果等价 |

认证变更应覆盖空会话、失效与拒绝、超时、Host/Origin 校验、凭据并发更新、账号切换、跨数据目录撤销及资源清理。已发送写入和未知提交不得因重新登录而自动重放；MCP 不应无限等待用户登录。

真实测试需要操作人的授权和明确积分预算。首次密码输入、验证码、双重验证及第三方身份提供商交互由用户完成；已有会话复用不能证明所有首次登录方式可用。只公开合成或脱敏证据，原始账号数据、会话、签名链接和现场日志留在本地。

## CI 配置

- `check` 在 push / pull request 上执行 Linux/Node.js 24 完整检查、构建与包清单验证；生产依赖审计单独执行 `npm audit --omit=dev`。
- 安装冒烟矩阵覆盖 Ubuntu 24.04、macOS 15、Windows 2025 / Node.js 24。每个平台构建并解包 TGZ，在解包目录运行 `npm ci --omit=dev`，再用 `npm link --omit=dev --ignore-scripts` 链接到临时 npm prefix；验证唯一 bin、版本、CLI/MCP 帮助与指南、四种工具集配置和生产锁依赖。严格安装检查之后，对同一 TGZ 执行 `package:consumer-smoke`，检查 npm 消费端安装和执行路径，将依赖漂移单独记录。工具/指南发现还断言不创建任务状态。
- `release-candidate`（`package.yml`）仅接受手动 `workflow_dispatch`。完成全检查、审计和六文件导出后，三个系统验证同一个 TGZ，分别保存 `smoke-{platform}.json` 与 `consumer-{platform}.json`。最后汇总 release notes、readiness 和带归档摘要的两类报告，保留 90 天。
- 候选工作流从实际 GitHub 仓库上下文取得 repository。公开仓库变量 `SECURITY_CONTACT_URL` 使用 `https://github.com/seekskyworld/ai-modeling/security/advisories/new`；发布前确认私密报告入口启用且可用。缺项会记录为 blocker。
- 工作流只有 `contents: read`，不创建 Release、不推标签、不发布 npm，也不使用 Studio 会话。Dependabot 更新仍需验证与审阅。

这里说明的是配置，不能代替对应提交的托管运行记录。三平台矩阵只证明安装和离线入口，不证明真实凭据库、浏览器登录、Blender/FFmpeg 或全部 Studio 业务已验收。候选产物有保留期限，不是稳定下载地址。

## 准备版本

`package.json` 是唯一手工维护的程序版本来源。根 `version.ts` 在源码和构建包中读取对应包元数据；CLI 版本/update 与 MCP 入口/握手均使用它，不再维护四份硬编码版本。

```sh
npm version patch --no-git-tag-version
npm run version:check
```

版本命令同步 `package-lock.json` 顶层与根包版本；`version:check` 拒绝元数据漂移。不要直接改生成的 `dist/`。另外审阅 [CHANGELOG.md](../CHANGELOG.md) 和公开说明；只有真正发布时才将 Unreleased 条目移入有日期的版本章节。

```sh
node dist/cli/main.js --version
node dist/cli/main.js mcp --help
```

## 打包与分发

公开源码仓库为 [seekskyworld/ai-modeling](https://github.com/seekskyworld/ai-modeling)，npm 包名为 **`@seekskyworld/ai-modeling`**，唯一 bin 为 **`ai-modeling`**。包元数据允许公开 scoped 发布，运行包同时包含 CLI、MCP 与 Skill 指导；Skill 名称和目录仍为 `ai-modeling`。无需为三个入口分别发布运行引擎。

先完成检查、包清单与依赖审计，再使用标准导出器创建候选：

```sh
npm ci
npm run check
npm run package:check
npm audit --omit=dev
npm run export -- --out ../ai-modeling-export --target all
```

`--out` 必须位于源码仓库之外，父目录已存在且目标目录不存在。位置检查解析软链接；导出器先在同级临时目录准备，成功后再发布到指定位置，不覆盖已有输出。源码、测试依赖和导出包保持分开。

| `all` 产物 | 用途 |
| --- | --- |
| `ai-modeling-skill-VERSION.zip` | 独立 Skill 操作说明、参考资料与许可，仍需要运行包 |
| `ai-modeling-VERSION.tgz` | npm 包 `@seekskyworld/ai-modeling` 的 CLI/MCP 运行归档 |
| `mcp.json` | 已安装 `ai-modeling` 命令的 MCP 配置，不含机器路径或凭据 |
| `INSTALL.md` | 安装 Skill、MCP 或直接 CLI 的说明 |
| `manifest.json` | 版本、归档摘要、来源提交/状态、Node/npm 工具链与依赖溯源 |
| `SHA256SUMS` | 产物校验和 |

单目标入口为 `npm run export:skill -- --out DIR` 和 `npm run export:mcp -- --out DIR`。归档文件名不带 npm scope；包内元数据和 npm 发布地址必须使用 scoped 名称。检查当前产物和摘要，不沿用旧候选的文件数、哈希或验收报告。

包内容由 `package.json.files` 与 npm 必需元数据决定。应包含 `dist/`、程序所需资源、Skill、五份核心文档、公开根文档、示例和许可；排除真实 `.env`、MCP 本机配置、凭据、浏览器状态、数据库、调查记录、网页缓存、旧归档和用户资产。`.gitignore` 不能替代实际 TGZ 清单检查。

源码 `package-lock.json` 锁定开发依赖。标准导出从已审阅的生产 shrinkwrap 在临时目录执行锁定安装，随 TGZ 绑定可移植生产依赖，并保留其许可证；不从可能被修改的开发 node_modules 复制发行依赖。原生平台与其它可选包不跨平台硬打包，以锁中的精确版本声明交给 npm 按当前平台安装。归档仍包含生产 `npm-shrinkwrap.json` 与来源记录。安装验收必须比较真实依赖树和随包依赖字节，不能只看到锁文件就断言 npm 按锁安装。直接 `npm pack` 不等于标准导出，不应跳过生产依赖和分发验证就用于发布。项目不分发无权再分发的 Studio 网页素材、浏览器、Blender、FFmpeg 或外部转换运行时；保留第三方许可声明。

## 安装验证与发布候选

```sh
npm run package:smoke -- --archive ../ai-modeling-export/ai-modeling-VERSION.tgz
npm run package:consumer-smoke -- --archive ../ai-modeling-export/ai-modeling-VERSION.tgz --require-locked
npm run release:check
```

`package:smoke` 解包归档、运行 `npm ci --omit=dev` 并链接全局入口，再启动 CLI/MCP，核对唯一 bin、版本、工具/指南与生产依赖。`package:consumer-smoke` 验证 npm 安装、npm exec/npx、MCP 发现和 Skill 管理，并比较实际依赖的名称、版本与完整性；功能和依赖锁结果分别记录，发布验收使用 `--require-locked` 将偏离审阅版本或完整性的情况视为失败。这些检查用临时配置与缓存，不登录账号或生成素材；不能代替发布后从公共 registry 的安装验证。

Linux、macOS、Windows 报告分别为 `smoke-{platform}.json` 与 `consumer-{platform}.json`，须对应同一 TGZ。缺少某平台或消费端功能报告，不能称候选通过三平台验收；消费端依赖偏离锁定版本或完整性会产生 `CONSUMER_DEPENDENCY_DRIFT` 阻塞，功能通过不能抵消它。三平台安装成功也不意味着全部浏览器、OS 凭据库、AI 宿主和真实业务都已验收。

`release:check` 检查源码元数据、可追溯且干净的 Git 提交以及内置价格有效期；默认要求价格至少剩余24小时。它不访问账号、不自动续期，也不联网验证联系人或价格证据。`scope: source` 的 ready 仅表示源码前置条件满足。

使用已确认的仓库与安全报告入口生成候选记录：

```sh
npm run release:prepare -- --distribution ../ai-modeling-export \
  --smoke-dir ../ai-modeling-smoke-reports --out ../ai-modeling-candidate \
  --repository https://github.com/seekskyworld/ai-modeling \
  --security-contact https://github.com/seekskyworld/ai-modeling/security/advisories/new \
  --require-ready
```

它检查导出文件、摘要、版本、依赖来源及同包平台报告，输出 `RELEASE.md`、`readiness.json` 和验收材料，不创建远端 Release、不发布 npm。缺项保留 blocker，`--require-ready` 会以非零状态退出。发布前用最终提交与原产物重新核验，避免价格过期或包内容变化后沿用旧通过状态。

### Maintainer workflow in English

The npm package is `@seekskyworld/ai-modeling`; its executable and Skill remain `ai-modeling`. Source and releases live at [seekskyworld/ai-modeling](https://github.com/seekskyworld/ai-modeling). `package.json` is the program-version source; `npm version ... --no-git-tag-version` updates the source lock, and `version:check` detects drift.

Run full checks, the production audit, and standard export. Validate the same TGZ on Linux, macOS and Windows with both archive and npm consumer checks; inspect actual dependency versions/integrity as well as functional results. Prepare the candidate with `release:prepare --require-ready` immediately before publishing. Source metadata, price freshness and offline MCP discovery do not establish real-account or host-client compatibility.

Publish the reviewed runtime archive to npm with public access and attach the original distribution files and checksums to the matching GitHub Release. Do not rebuild between verification and publication. After publication, check registry integrity and install that exact public version in a clean environment. Verify Skill loading or MCP discovery, login recovery, and authorized image/model workflows through the chosen entry point. Fixes to an already-published npm version require a new version; never imply the immutable published version contains later source changes.

## 价格来源维护

`studio/api/reviewed-prices.json` 是可公开下载的单一审阅源，TypeScript 运行层从同一文件导入。维护者核对当前网页常数、公式和相关工作流证据后更新 JSON，记录真实审核时间、有限有效期及每份证据的 SHA-256；只改到期日不构成重新审阅。

发布说明同时记录该 JSON 的文件 SHA-256、审核时间、到期时间和固定提交或标签 URL：`https://raw.githubusercontent.com/seekskyworld/ai-modeling/COMMIT/studio/api/reviewed-prices.json`。main 地址用于发现最新审核版本，不作为免摘要的自动更新通道。发布前从最终文件重新计算摘要，并验证公开固定URL返回的字节与其一致；后续更新可独立提供新的审阅提交和摘要，不要求用户复制账号会话。

用户通过 `pricing update HTTPS_URL --sha256 SHA256` 或本地 `verify/import` 更新，见[使用说明](usage.md#价格快照更新)。保留证据失败、未知价格与到期错误，不能用发布流程自动延长期限。

## npm 版本存在性与归档核对

从源码运行只读检查，查询公共 npm registry 中当前 scoped 包名与版本：

```sh
npm run package:registry-check -- --archive ../ai-modeling-export/ai-modeling-VERSION.tgz --require-published
```

发布前候选核查省略 `--require-published`；该选项用于发布后将版本缺失视为失败。可加 `--report NEW.json` 保存结果。提供 `--archive` 时比较本地 TGZ 与 registry 的 SHA-512 SRI，缺少时使用 SHA-1 shasum；摘要不同失败。检查不下载远端 TGZ、不读取 npm 凭据，也不发布或证明包归属。

Public registry integrity checks complement, rather than replace, actual installation of the published `@seekskyworld/ai-modeling` version and its Skill/MCP workflow tests.

## 首次建仓与人工发布

确认 `.gitignore` 和实际公开文件清单，只提交公开源码与文档。仓库 `repository`、`bugs`、`homepage` 指向上述真实 GitHub 仓库；私密漏洞报告入口与 [SECURITY.md](../SECURITY.md) 保持一致。CI 使用最小所需权限，npm 凭据不进入源码、命令记录或产物。

维护者授权发布后，使用经过同包验收的归档，例如：

```sh
npm publish ../ai-modeling-export/ai-modeling-VERSION.tgz --access public
```

再验证 npm 版本、公开下载、摘要及 README 安装命令。GitHub Release 附上原 Skill ZIP、运行 TGZ、配置、安装说明、manifest 和校验和；候选工作流本身不会替维护者发布。更新 [CHANGELOG.md](../CHANGELOG.md) 的实际版本与发布日期，保留失败和未验证范围，不能以首次安装成功宣称全部网页效果等价。
