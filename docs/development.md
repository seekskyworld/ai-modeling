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

凭据使用 `JsonStore` / `JsonEntry` 保存于 OS 用户主目录的私有 JSON 文件，产物链接使用 `JsonLinks`；会话、上传引用和独立 LLM 密钥也遵守同一存储边界。认证根是 `userInfo().homedir/.ai-modeling-auth`，条目为 `credentials/<sha256(service)>/<sha256(account)>.json`，使用 `schema_version: 1` envelope。业务 `dataDir`、`HOME`/`TMPDIR` 环境变化不能分裂同 OS 用户/profile 的认证与撤销作用域，生产没有认证根重定位配置。

POSIX 使用目录 `0700`、文件 `0600`，读取验证大小、结构、所有者及 no-follow 文件身份；写入采用同目录临时文件、fsync 和原子 rename。Windows 通过有界 PowerShell 调用验证/设置受保护 DACL，仅允许当前用户 SID 与 SYSTEM，拒绝 reparse point 或额外 allow ACE，不能用 chmod 当作等价验证。应用自有认证控制目录及登录状态文件在验证归属、非 reparse 和文件身份后，可按需收紧旧 ACL；已私有的 ACL 不重写，登录状态内容、nonce 和撤销信息保持不变。凭据 JSON 条目和外部导入文件的读取只验证、不修复 ACL。权限或文件验证失败保留 `CREDENTIAL_STORE_UNAVAILABLE` / `AUTH_DIRECTORY_INVALID`，锁竞争使用 `CREDENTIAL_STORE_BUSY`；保留读失败与写结果未知的差异。

JSON 内含未额外加密的凭据值，只进入私有文件；SQLite、MCP 参数、公开文档和日志不得复制其秘密内容。静态帮助、Skill 管理和 MCP 发现不读取凭据或提前加载图像原生模块。可见浏览器登录先验证账号再保存会话；CDP 只接受调用方显式指定的回环地址，只清理工具自己创建的页面或连接。旧钥匙串不会自动读取、迁移或删除。

登录协调器按 OS 用户和 profile 共享，独立于业务数据目录。取消、退出、迟到验证和凭据更新受锁及版本检查约束。交互 CLI 可在安全请求边界等待登录；非交互 CLI/MCP 返回可处理的登录状态。

提交前固定请求意图、账号、输入身份和 `request_id`。新提交前核对账号、输入及有效报价；恢复保持原账号、请求和来源身份并查询原回执，不重新执行新任务的前置条件，修改意图应报告 `IDEMPOTENCY_CONFLICT`。认证失败、锁过期或响应丢失都不能成为重放已发送写请求的依据，结果未知时先核对原回执。

SQLite 迁移保留一致备份，CLI 与 MCP 一同升级。缓存与下载绑定来源、账号、摘要和文件身份；先验证临时下载，再写入目标位置，不覆盖无关文件。产物不符合要求时保留原回执与 `needs_attention` 状态，不自动再次付费生成。

## 开发与本地检查

使用 Node.js **24+** 和 npm。`npm ci` 安装锁定依赖；自动测试使用隔离夹具与合成数据，不要求 Studio 账号或真实用户凭据。

```sh
npm ci
npm run check
npm run package:check
```

`check` 依次执行版本一致性、离线工作流合同检查、TypeScript、ESLint、Prettier、文档检查、Node.js 测试和构建。按变更范围也可单独运行 `workflow:check`、`typecheck`、`lint`、`format:check`、`test` 或 `build` 脚本。

`npm run workflow:check` 解析仓库中的 workflow，检查权限、触发条件、归档门禁、提交占位与版本推进的编排合同，不下载工具。GitHub Actions 的语法与表达式另由 actionlint 检查；在 Linux/macOS 的 x64 或 arm64 环境显式执行：

```sh
node scripts/actionlint.ts
```

该命令会联网下载固定版本 actionlint，先核对仓库中固定的 SHA-256，再解压执行，结束后清理临时目录。它不属于离线 `check` 链，在 CI 中独立运行；没有联网条件时应记录未执行，不能把合同检查当作 actionlint 已通过。

`npm run docs:check` 离线检查本地链接、标题锚点和 JSON 示例，不验证外部网站是否在线。`npm run package:check` 要求已有 `dist/`，读取 `npm pack --dry-run --ignore-scripts --json` 的实际清单，检查白名单、必需文件、许可、私有文件标记及包内链接；它不生成安装包或发布。

`npm run --silent capabilities` 从当前命令树、四种工具集配置和模型注册表生成机器清单；`--out` 只接受源码之外、父目录已存在的新文件。它不接触账号或任务库。映射、支持条件和证据引用用于定位实现，未执行条目保留 `not_verified`；不要将测试文件路径当作已经通过的运行证据。该清单按需生成，不增加普通导出的六个文件。

`npm test` 使用 `scripts/run-tests.ts`，为测试合成 OS home、内存会话或临时 JSON 存储、独立 profile/state，并将测试网络限制到回环地址；不修改用户 HOME，也不添加生产测试开关。定向用例用 `node scripts/run-tests.ts tests/guides.test.ts`，或 `npm test -- tests/guides.test.ts`，不要绕过该入口直接执行测试文件。

测试文件默认最多 4 路并行，减少大量 CLI/MCP 子进程争抢资源造成的启动超时；单项超时与断言保持不变。需要调整时可显式传入 `npm test -- --test-concurrency=2`。

部分几何集成测试需要 Blender **4.5+**，通过 `AI_MODELING_TEST_BLENDER` 或 `AI_MODELING_BLENDER` 指定。未设置时相关真实 Blender 用例会跳过，报告必须区分通过和跳过。涉及视频的本地处理另需带 libx264 的 FFmpeg。

```sh
AI_MODELING_TEST_BLENDER=/path/to/blender npm test
```

## 验证范围与报告

| 验证层次 | 应记录的证据与边界 |
| --- | --- |
| 离线测试 | CLI/MCP 子进程合同、登录状态机、撤销与并发、文件和数据库边界；凭据、浏览器与服务使用替代接口 |
| 真实浏览器登录 | 实际浏览器、私有 JSON 目录权限、会话验证和保存、窗口归属及命令接续；注明操作系统和浏览器版本 |
| 真实 Studio 请求 | 授权账号、输入、预算、完整请求链、远端状态与原始请求身份；不以离线断言替代服务验证 |
| 产物与网页对比 | 几何、尺寸、纹理、材质、动画及实际网页操作效果；任务成功不等于产物正确或网页效果等价 |

认证变更应覆盖空会话、失效与拒绝、Host/Origin 校验、JSON 损坏/超大/符号链接/权限拒绝、原子替换、凭据并发更新、账号切换、跨数据目录撤销及资源清理。POSIX 模式和 Windows SID/DACL 的实际验证分别报告；在另一操作系统模拟平台分支不等于原生通过。已发送写入和未知提交不得因重新登录而自动重放；MCP 不应无限等待用户登录。

真实测试需要操作人的授权和明确积分预算。首次密码输入、验证码、双重验证及第三方身份提供商交互由用户完成；已有会话复用不能证明所有首次登录方式可用。只公开合成或脱敏证据，原始账号数据、会话、签名链接和现场日志留在本地。

## CI 配置

- `check` 在分支 push / pull request 上执行 Linux/Node.js 24 完整检查、构建与包清单验证；标签推送由 `release.yml` 执行发布所需检查。生产依赖审计单独执行 `npm audit --omit=dev`。
- `check` 的独立 `workflows` job 执行 actionlint；各 workflow 的第三方 Actions 固定完整提交 SHA，升级时同步审阅版本注释和离线合同。合成发布回归覆盖版本排序、被替换的待执行任务、未知写入结果及恢复，不能替代托管发布验收。
- 安装矩阵还会在各自操作系统执行 JSON 凭据、路径、受限文件导入及登录撤销回归；Windows 原生 DACL 用例只在 Windows 执行，其它系统明确跳过，不把模拟检查当作原生验收。
- 安装冒烟矩阵覆盖 Ubuntu 24.04、macOS 15、Windows 2025 / Node.js 24。每个平台构建并解包 TGZ，在解包目录运行 `npm ci --omit=dev`，再用 `npm link --omit=dev --ignore-scripts` 链接到临时 npm prefix；验证唯一 bin、版本、CLI/MCP 帮助与指南、四种工具集配置和生产锁依赖。严格安装检查之后，对同一 TGZ 执行 `package:consumer-smoke`，分别检查本地 npm、真实全局 npm 安装、npm exec/npx 执行路径，并校验平台原生模块可加载；将依赖漂移单独记录。工具/指南发现还断言不创建任务状态。
- `release-candidate`（`package.yml`）仅接受手动 `workflow_dispatch`。完成全检查、审计和六文件导出后，三个系统验证同一个 TGZ，分别保存 `smoke-{platform}.json` 与 `consumer-{platform}.json`。最后汇总 release notes、readiness 和带归档摘要的两类报告，保留 90 天。
- 候选工作流从实际 GitHub 仓库上下文取得 repository。公开仓库变量 `SECURITY_CONTACT_URL` 使用 `https://github.com/seekskyworld/ai-modeling/security/advisories/new`；发布前确认私密报告入口启用且可用。缺项会记录为 blocker。
- `check` 和 `release-candidate` 只有 `contents: read`，不创建 Release、不推标签、不发布 npm，也不使用 Studio 会话。另一个 `release.yml` 工作流响应版本标签；只有其正式 `publish` 与 `promote` job 获得 `contents: write` 与 `id-token: write`，详见[自动 npm 发布](#自动-npm-发布)。`workflow_dispatch` 只运行检查与预演，不进入这两个 job。Dependabot 更新仍需验证与审阅。

这里说明的是配置，不能代替对应提交的托管运行记录。三平台矩阵只证明安装和离线入口，不证明私有 JSON 在所有系统上的真实 ACL 行为、浏览器登录、Blender/FFmpeg 或全部 Studio 业务已验收。候选产物有保留期限，不是稳定下载地址。

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

源码 `package-lock.json` 锁定开发依赖。标准导出从已审阅的生产 shrinkwrap 在临时目录执行锁定安装，随 TGZ 绑定可移植生产依赖，并保留其许可证；不从可能被修改的开发 node_modules 复制发行依赖。原生入口包及其平台可选依赖交由 npm 安装，不把外置平台依赖悬挂在已绑定的原生入口包下。平台包以精确版本声明，并在真实全局安装中核对模块可加载；不能以本地 npm 自动提升依赖后可运行的结果代替全局验证。归档仍包含生产 `npm-shrinkwrap.json` 与来源记录。安装验收必须比较真实依赖树和随包依赖字节，不能只看到锁文件就断言 npm 按锁安装。直接 `npm pack` 不等于标准导出，不应跳过生产依赖和分发验证就用于发布。项目不分发无权再分发的 Studio 网页素材、浏览器、Blender、FFmpeg 或外部转换运行时；保留第三方许可声明。

## 安装验证与发布候选

```sh
npm run package:smoke -- --archive ../ai-modeling-export/ai-modeling-VERSION.tgz
npm run package:consumer-smoke -- --archive ../ai-modeling-export/ai-modeling-VERSION.tgz --require-locked
npm run release:check
```

`package:smoke` 解包归档、运行 `npm ci --omit=dev` 并链接全局入口，再启动 CLI/MCP，核对唯一 bin、版本、工具/指南与生产依赖。`package:consumer-smoke` 分别验证本地 npm 安装、真实全局 npm 安装、npm exec/npx、MCP 发现和 Skill 管理，并比较实际依赖的名称、版本与完整性；功能和依赖锁结果分别记录，发布验收使用 `--require-locked` 将偏离审阅版本或完整性的情况视为失败。这些检查用临时配置与缓存，不登录账号或生成素材；不能代替发布后从公共 registry 的安装验证。

Linux、macOS、Windows 报告分别为 `smoke-{platform}.json` 与 `consumer-{platform}.json`，须对应同一 TGZ。缺少某平台或消费端功能报告，不能称候选通过三平台验收；消费端依赖偏离锁定版本或完整性会产生 `CONSUMER_DEPENDENCY_DRIFT` 阻塞，功能通过不能抵消它。本地已通过的报告与尚未执行的平台分别记录；Windows 等平台没有成功回执时保留未验收，不能称三平台全部通过。即使三平台安装成功，也不意味着全部浏览器、私有文件/ACL、AI 宿主和真实业务都已验收。

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

## 自动 npm 发布

`.github/workflows/release.yml` 对推送的版本标签执行发布流程。标签必须与 `package.json` 的版本一致，来源必须是该标签解析到的完整提交 SHA。发布使用 Node.js **24** 和 npm **11.17.0**，不是仅依赖 runner 预装的 npm。普通分支 push 不发布；手动 `workflow_dispatch` 对任意所选 ref 执行独立完整预演，不调用发布状态协调器。即使选择版本标签也不提交 npm、不写发布状态或创建公开 Release。预演报告不能当作真实 OIDC 上传回执。

维护者先完成新版本的元数据、锁文件和 CHANGELOG 更新，再推送对应 `vVERSION` 标签。npm 版本不可覆盖，不移动已发布标签；不要用重复推送、删除标签或重跑发布命令来处理索引延迟。安装示例与发布版本保持一致，并在新版本公开后实际验证 registry 安装。0.1.4 按维护者明确授权从本机手动发布；Windows 原生验收与首次 GitHub OIDC 上传仍未验证，不能把本次手动发布当作三平台工作流通过。标准自动发布门禁保持不变。

### Trusted Publisher 前提

在 npm 的 `@seekskyworld/ai-modeling` 包上配置 GitHub Actions Trusted Publisher：仓库所有者为 `seekskyworld`，仓库名为 `ai-modeling`，工作流文件名为 `release.yml`，environment 为 `npm`。GitHub 侧同名 environment 限制为 `v*` 标签，发布 job 和 npm 配置中的环境名称必须完全一致。配置项引用的是实际仓库、工作流和环境身份，不能只配置本地 `.npmrc` 或依赖仓库名相似的 fork。

npm 11.17.0 支持原生配置命令，也可在 npm 网站的包设置中完成。由具有该包管理权限的账号执行：

```sh
npm trust github @seekskyworld/ai-modeling --file release.yml --repo seekskyworld/ai-modeling --env npm --allow-publish
```

本工作流还需要管理 `latest` / `next`。在 npm 包的 **Settings → Trusted Publisher → Edit → Allowed actions** 中启用 **Allow npm dist-tag** 并保存；**Allow npm publish** 也需开启。npm 11.17.0 的 `trust` 命令没有暴露这个 dist-tag 选项，需要通过网页配置。已有连接可以直接编辑权限，无需重新创建仓库、工作流或环境绑定。

首次配置所需的登录、2FA 和身份确认由维护者本人完成。先核对当前 npm 账号和包权限；读取信任设置返回 403，或浏览器登录为另一个账号时，不代表 Trusted Publisher 已配置成功，也不能静默换身份继续。

只有实际核验 npm 侧的仓库、工作流、environment 与发布许可均正确后，才将 GitHub 仓库变量 `NPM_TRUSTED_PUBLISHER_CONFIGURED` 设为 `true`。该变量是正式 npm 提交的显式开关，不是配置证明本身；创建 GitHub environment、打开 npm 设置页或运行失败的 trust 命令都不足以开启它。变量未确认时保留发布阻塞，不提交 npm。

发布 job 使用 GitHub OIDC 与最小所需权限，不将长期 npm Token 写入仓库、工作流、状态资产或日志。Trusted Publisher 必须由有权限的维护者在 npm 侧完成配置；新增 workflow 文件并不代表远端授权已经完成。缺少授权或 OIDC 上传尚未跑通时，应保留具体阻塞和原提交状态，不能自动退回其他身份或重复上传。

npm 11.17.0 的 `publish` 会进行 OIDC 交换，`dist-tag` 不会自动完成这一步。独立 `promote` job 因此通过受限的 GitHub OIDC → npm 包级短时令牌交换来更新固定包的 `latest` / `next`，凭据只在内存中使用。该路径校验仓库、版本标签、工作流和 `npm` environment 身份，不读取本机 npm 登录或回退长期 Token。网页的 **Allow npm dist-tag** 授权和运行时的 OIDC 交换都必须具备；首次真实推进仍需分别验收交换、写入与读回。

### 同一归档、三平台门禁

新版本依次执行完整检查、生产依赖审计与标准 `export --target all`，冻结六个分发文件。Linux、macOS、Windows 对**同一个 TGZ**分别执行 `package:smoke` 和带 `--require-locked` 的 `package:consumer-smoke`；汇总通过 `release:prepare --require-ready` 后才能进入发布。只验证平台各自重新打的包、缺少 Windows 回执或只通过本地 npm 安装，都不能满足该门禁。

发布前后沿用已验收的原 TGZ、Skill ZIP、manifest、校验和及报告，不在提交前重新构建或重新压包。GitHub Actions 临时产物只用于传递与查看；跨 runner 的发布恢复依赖版本 Release 上保存的固定身份、原资产及发布状态，不能把有保留期限的 workflow artifact 当成唯一提交凭据。相同版本的正式发布串行执行，不能取消已进入提交阶段的运行再启动一次上传。

### 持久状态与恢复

`scripts/npm-publication.ts` 将提交身份绑定到仓库、标签、来源提交和原 TGZ 摘要。状态资产使用固定名称，不覆盖已有提交事实；冻结身份先持久化，原资产齐全并完成验收后才记录 prepared。提交前必须先写入并读回远端提交占位，只有第一次成功取得该占位的调用才能执行一次 `npm publish`。即使 run ID 相同，重复调用也不能再次获得提交许可。

| 状态或证据 | 允许继续的动作 |
| --- | --- |
| 没有历史 Release/提交记录，精确版本也不存在 | 新建候选并执行完整门禁；网络错误不能冒充版本不存在 |
| 已有 Release，但没有当前发布状态 | 返回 `import_required`，先核对并导入历史事实；不能根据 registry 404 重新打包或发布 |
| 已冻结但资产不完整 | 补回已冻结摘要对应的原字节并核对；不能换新包或重新构建同版本 |
| prepared | 核对原身份与验收材料，取得持久提交占位后最多提交一次 |
| submitting / submitted，结果 accepted 或 unknown | 只查询和验证原提交；404、超时、进程退出或结果记录失败都不释放重发许可 |
| published | 已取得精确版本 metadata 和实际 npm TGZ 字节，且与原身份及摘要一致；保留验收时间和证据 |

`npm publish` 退出码 0 只代表受理，不能当作公开安装已经可用。上传超时或进程被中断时，保留 `unknown`；即使尚未查到精确版本，也不能证明服务端没有受理。后续重跑恢复原资产并继续核对，不再走 export 或 publish。npm 调用后的状态写入失败也保留提交前的持久占位，因此不会把一次未知上传误当成从未提交。

自动发布完成必须同时确认精确包名和版本的 metadata、下载真实 `dist.tarball`，并比较原 TGZ 的 SHA-256、SHA-512 与 registry 摘要。metadata 200、网页显示版本、npm CLI 成功提示或另一个版本存在，都不能替代实际归档验证。通过后才将对应草稿 Release 设为公开。公共 npm 的干净安装及授权业务验收仍应单独记录；离线门禁不证明每个 AI 宿主、Windows 登录或所有 Studio 工作流已实测。

首次上传使用各版本独立的 `release-vVERSION` 标签，上传本身不改动 `latest` / `next`。通过真实归档核验后，跨版本串行的 `promote` job 扫描持久 published 回执，补全待公开的 Release，再按语义版本提升默认渠道。GitHub 可能替换尚未执行的并发排队任务，所以每个获得执行机会的 job 都检查整个待办集合，不仅处理触发自己的版本。草稿先以 `make_latest: false` 公开，稳定版和预发布版分别对应 `latest` 与 `next`；确认 npm latest 后才推进 GitHub Latest。

每次渠道写入前重新读取当前版本，已有相同或更高版本就跳过。写入响应丢失时读取实际结果，无法确认则保留失败阶段供恢复，不重新上传 npm。一个候选核验失败会保留该项并继续其他已核验候选；渠道查询失败时不猜测当前版本。协调器的串行与单调推进约束适用于该受控工作流，维护者直接修改渠道仍需避免与它并发。

正式 Release 说明由 `scripts/publication-notes.ts` 生成，输入真实、非 dry-run 的 published 结果与恢复的原 TGZ。生成器再次核对包名、版本、归档大小和全部摘要，从该归档提取价格 JSON，并与原来源提交中的 JSON 全字段比较。TypeScript 编译可能改变 JSON 的排版，所以价格更新摘要始终取**原来源文件字节**，而非编译件或规范化对象的摘要。说明会包含固定提交 URL、原文件 SHA-256、审核/到期时间和可复制的 `pricing update` 命令；标准六文件分发不增加或替换文件。

```sh
node scripts/publication-notes.ts --verification ../npm-verified.json \
  --archive ../frozen/distribution/ai-modeling-VERSION.tgz \
  --source-dir . --out ../publication-notes.md
```

`--source-dir` 指有原提交对象的 Git 仓库；生成器从该提交读取文件，忽略当前工作树和 Git replacement refs，因此可用新协调器恢复旧版本。省略该参数时，只读原提交对应的公共 GitHub raw URL，不携带凭据、不跟随重定向，JSON 限制为 1 MiB。输入不匹配或读取失败时不生成说明；错误只保留固定诊断，不回显 JSON 内容、私有路径或子进程 stderr。输出必须是源码之外、父目录已存在的新文件。恢复旧发布不会延长原价格期限，已过期的快照仍明确保留原日期。

从源码查询现有发布时，将 `vVERSION` 和 `FULL_TAG_COMMIT_SHA` 换成原标签与其完整提交，输出文件必须位于源码外且尚不存在：

```sh
node scripts/npm-publication.ts check --repository seekskyworld/ai-modeling \
  --tag vVERSION --source FULL_TAG_COMMIT_SHA --out ../npm-check.json
node scripts/npm-publication.ts verify --repository seekskyworld/ai-modeling \
  --tag vVERSION --source FULL_TAG_COMMIT_SHA --out ../npm-verify.json --dry-run
```

查询草稿需要具备相应仓库权限的 `GITHUB_TOKEN` 或 `GH_TOKEN`，缺少授权会明确失败，不能把看不到草稿当作不存在。`check --restore NEW_DIR` 可把已冻结原件恢复到新目录下的 `distribution/` 和 `candidate/`。`verify --dry-run` 仍会下载并检查真实公共 TGZ；即使返回 `action: published`，也不会写发布状态或公开 Release，应同时核对 `dry_run` 与证据，不能仅凭 action 字段执行发布写入。

网络要求使用现有 `HTTP_PROXY` / `HTTPS_PROXY` 时，为运行这些命令的 Node.js 24 进程设置 `NODE_USE_ENV_PROXY=1`。无需改动系统代理；不要把代理凭据写进输出、状态或回执。

对于曾处于 processing 的历史提交（如 0.1.3），恢复时使用原受理记录和原归档，先导入同一身份的 submitted/accepted 状态，再核对原 npm 提交并保存结果。原 `v0.1.3` 不含新的状态协调器与标签工作流，应使用包含协调器的新源码执行 `check` / `verify`，同时始终传入原标签、原来源提交并核对原 TGZ；不重推旧标签。它不重建、不重新上传，也不借此补造历史 Windows 通过记录；旧版恢复与新版本三平台提交门禁分别处理。npm 侧迟迟不完成索引时，保留原版本、归档摘要和受理时间，由维护者核对平台状态，不能靠再发一版宣称旧提交已完成。npm 11.17.0 另有 `npm stage list`、`npm stage view` 与 `npm stage approve` 管理能力；只有实际存在并核对为该原提交的 staging 项才有审批对象，列表为空不能当作可批准、已完成或可以重传的证据。

### Maintainer workflow in English

The npm package is `@seekskyworld/ai-modeling`; its executable and Skill remain `ai-modeling`. Source and releases live at [seekskyworld/ai-modeling](https://github.com/seekskyworld/ai-modeling). `package.json` is the program-version source; `npm version ... --no-git-tag-version` updates the source lock, and `version:check` detects drift.

Run full checks, the production audit, and standard export. Validate the same TGZ on Linux, macOS and Windows with both archive and npm consumer checks; inspect actual dependency versions/integrity as well as functional results. Prepare the candidate with `release:prepare --require-ready` immediately before publishing. Source metadata, price freshness and offline MCP discovery do not establish real-account or host-client compatibility.

Push the matching version tag to use `release.yml`; manual dispatch runs a complete independent preview for the selected ref without invoking the publication coordinator. Configure the npm Trusted Publisher for this repository, `release.yml` and its matching environment before expecting OIDC publication. Release jobs use Node.js 24 and npm 11.17.0. The same standard-export TGZ must pass the three-platform archive and npm-consumer gates before a new submission.

Uploads use a version-specific `release-vVERSION` tag. A separate serialized promotion job drains durable published receipts across versions, verifies original public archives, and advances `latest`, `next` and GitHub Latest without downgrading an observed version. Enable **Allow npm publish** and **Allow npm dist-tag** on the existing connection in npm package **Settings → Trusted Publisher → Edit → Allowed actions**; npm 11.17.0's `trust` CLI does not expose the dist-tag permission. npm's `dist-tag` command does not perform OIDC exchange itself; the promoter explicitly obtains a package-scoped short-lived token and keeps it in memory. Verify the first real token exchange, channel write and read-back separately; a configured publishing connection or an offline test is not proof that this permission works.

The workflow persists the archive identity and a submission claim before invoking npm once. An accepted or unknown submission is only reconciled against the registry; missing metadata never authorizes a retry. Existing releases without state require an explicit history import. Recover legacy processing submissions, such as the original 0.1.3 submission, from their original receipt and archive without rebuilding or uploading again. Since the original tag has no coordinator, run `check` / `verify` from newer source while retaining the original tag, commit and TGZ identity; do not move or push the old tag again. If these Node.js 24 commands need the configured environment proxy, set `NODE_USE_ENV_PROXY=1` for their process without exposing proxy credentials.

Publication is verified only after downloading the exact public npm tarball and matching its bytes and registry digests to the frozen archive. Then check a clean public installation, Skill loading or MCP discovery, login recovery and authorized image/model workflows through the chosen entry point. Fixes to an already-published npm version require a new version; source changes under Unreleased do not modify 0.1.3. Workflow configuration and simulated tests do not establish successful OIDC publication or native Windows acceptance.

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

该命令仅检查 metadata，不能替代[自动发布](#自动-npm-发布)中的实际远端 TGZ 下载验证。Public registry integrity checks also do not replace actual installation of the published `@seekskyworld/ai-modeling` version and its Skill/MCP workflow tests.

## 发布维护

确认 `.gitignore` 和实际公开文件清单，只提交公开源码与文档。仓库 `repository`、`bugs`、`homepage` 指向上述真实 GitHub 仓库；私密漏洞报告入口与 [SECURITY.md](../SECURITY.md) 保持一致。CI 使用最小所需权限，npm 凭据不进入源码、命令记录或产物。

正式新版本使用上述标签工作流。人工恢复也必须沿用同一持久身份和提交占位；不得绕过状态检查直接重复 `npm publish`。GitHub Release 附上原 Skill ZIP、运行 TGZ、配置、安装说明、manifest、校验和及状态证据；手动候选工作流仍只提供预演材料。核对公共 npm 版本、真实下载字节和 README 安装命令后，再更新 [CHANGELOG.md](../CHANGELOG.md) 的实际版本与发布日期。保留失败和未验证范围，不能以首次安装成功宣称全部网页效果等价。
