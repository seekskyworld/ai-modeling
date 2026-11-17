# 使用与恢复

CLI 是底层执行接口，MCP 提供同源指导资源并通过工具适配调用 CLI。以下 shell 示例仅用于 CLI 入口；用户选择 MCP 时，读取对应资源和工具 schema，通过 MCP 完成同一操作，不绕过 MCP 执行 shell。

独立生图和图像编辑未指定模型时使用 GPT Image 2.5；显式模型选择优先。MCP 的 `default` 集已含 `ai_modeling_image_generate`，其网页配置参数与 `studio` 集相同；其它网页操作需当前客户端已配置相应工具集。Skill 本身不分轻量/扩展版本，也不因示例自动重配客户端。

## 运行依赖与程序来源

- 本 Skill 只有操作指导，不包含 CLI、Node.js、浏览器、运行依赖或用户会话。需要 Node.js 24+，以及已正确安装依赖的同版本 ai-modeling 运行包。
- npm 包名为 `@seekskyworld/ai-modeling`，唯一命令为 `ai-modeling`。MCP 使用 `ai-modeling mcp` 启动默认6工具集，含 GPT Image 2.5 独立生图；网页资产与编辑扩展另选 `--toolset studio`。官方源码为 [seekskyworld/ai-modeling](https://github.com/seekskyworld/ai-modeling)，归档仍为 `ai-modeling-VERSION.tgz`。
- 账号操作使用当前 OS 用户的私有 JSON 凭据文件，不需要系统钥匙串、Linux Secret Service 或 D-Bus。POSIX 使用目录 `0700`/文件 `0600`；Windows 通过系统 PowerShell 检查当前用户 SID 与 SYSTEM 的受保护 ACL。自动网页登录另需已安装、可见的 Chrome/Edge。离线发现和 Skill 安装管理不需要登录。
- 只在具体功能需要时检查 Blender 4.5+、FFmpeg 或固定网页转换运行时。未获用户相应授权时，不自动安装依赖、全局安装/升级程序或修改 MCP 配置；缺少条件时指出具体缺项。用户明确要求这些操作时，确认本项目来源后按授权执行。
- 使用用户已安装的本项目运行包；有多个版本时核对可执行文件目标与版本。配置使用 `AI_MODELING_*`，结构化工具使用 `ai_modeling_*`，认证资源为 `ai-modeling://auth/status`；旧项目名称不作为别名。已有有效 JSON 会话可复用；升级自旧钥匙串版本时按下文重新连接，不因 npm 包名带 scope 而更换 profile。
- 入口不明确时核对已安装版本与路径；源码入口为 `node /absolute/path/to/installation/dist/cli/main.js`。用户选择 npx 路线时，每次沿用同一完整、固定版本前缀，例如 `npx --yes --package @seekskyworld/ai-modeling@0.1.4 ai-modeling`，不能误用无 scope 的同名包或静默升级。

用户已授权安装时，使用 `npm install --global @seekskyworld/ai-modeling@0.1.4`，再核对 `ai-modeling --version`。可按用户选择使用同版本 npx 前缀，无需全局安装。保留平台可选依赖。npm 安装不会自动导入 Skill 或配置 MCP。发布版本与来源以 npm 和指定 GitHub 仓库为准，不使用无 scope 的 `ai-modeling` 包。

Windows PowerShell 若拒绝执行 `npm.ps1` / `npx.ps1`，可使用 `npm.cmd` / `npx.cmd`。MCP 宿主是否能直接启动 `.cmd` 取决于其实现；不支持时可由 `cmd.exe /d /c` 启动，或直接用 `node.exe` 加已安装包的 `dist/cli/main.js` 与 `mcp` 参数。选定 MCP 入口时保持客户端配置和工具调用，不因发现命令启动差异就替换为 shell 执行业务；按用户授权处理配置。

归档是独立替代路线：从同仓库 Releases 取得 `ai-modeling-VERSION.tgz` 并核对 `SHA256SUMS`，解包到选定的新持久目录，在其中执行 `npm ci --omit=dev --no-audit --no-fund`，再执行 `npm link --omit=dev --ignore-scripts`。链接仍依赖该目录及其依赖，不把它当临时文件清理。

只有用户要求安装管理时才使用以下入口，普通创作任务不重新安装 Skill：先用 `ai-modeling skill targets` 查看支持的客户端，明确选择 `--target NAME` 或 `--dir PATH`，再调用 `skill install/status/uninstall`；程序不隐式选择客户端。命名目标一般默认用户范围；`golutra-agent` 仅支持并默认项目范围。项目范围可使用 `--scope project --project-dir PATH`。自定义 `--dir` 指技能父目录，在其中安装 `ai-modeling/`，不要同时传 `--target`、`--scope` 或 `--project-dir`。查询、更新和卸载沿用原目标及范围。安装后刷新客户端 Skill 列表或新建会话，验证其可以读取输出目录的 `SKILL.md` 并调用同版本 CLI；安装器状态不能替代宿主加载。升级仍使用相同目标/范围。上述操作只管理本地指导文件，无需账号，也不改 MCP 配置；遇到用户改动或未管理内容时保留文件，不绕过冲突。独立 Skill ZIP 仍可按客户端方式手动导入。

下文 `ai-modeling` 均表示已确认的本项目 CLI；按实际安装入口替换，示例路径不要求固定目录。不要把整条命令当成一个可执行文件路径。

## 发现当前能力

先用当前安装版本的帮助找到与任务相关的入口，按需读取内置文档，不复制旧参数或一次加载全部手册：

```text
ai-modeling --help
ai-modeling docs --topic usage
ai-modeling docs --topic compatibility
ai-modeling model convert --help
```

最后一行仅示范按命令查帮助；应替换成当前任务的命令。官方兼容入口主要在 `generate/model/mesh/anim/task`，网页扩展在 `studio/canvas`。

需要结构化调用时，用 `ai-modeling tools --toolset studio` 获取对应 schema，再用 `ai-modeling call TOOL --input-stdin` 传 JSON。工具与指南发现只读取元数据，不访问账号、凭据文件或创建任务状态；长文本、JSON 和私有路径不要通过不安全的 shell 插值拼接。命令发现可先读 `guides read commands/index`，再读 `guides read commands/model/convert` 等具体分片。MCP 对应资源为 `ai-modeling://guides/commands/index` 和 `ai-modeling://guides/commands/{+command}`，不需要加载完整命令手册。

Skill 可直接调用 CLI，不要求安装 MCP。用户已选择 MCP 时保持该选择，读取该客户端当前工具定义；二者使用相同运行包和基础能力，不因为 Skill 可用就重配客户端或更换账号。

需要查找账号已有的网页素材时，用 `assets list --kind model|image --limit N --offset N` 分页读取；MCP 对应 `ai_modeling_assets_list`。实际调用选择一种 `kind`，沿用响应的 `next_offset`，直到返回 `null`。该清单与本机任务历史不同。图像输出索引用于下载；需要删除等操作的精确输出键时，先读取 `studio image-get`，不凭索引猜键。

## 网页登录

在用户授权的账号任务需要登录时，使用 CLI 的浏览器流程，不索取、打印、复制或抓取 Token/Cookie，也不读取普通浏览器用户目录。

交互环境可用 `ai-modeling login`；需要返回登录入口时用 `ai-modeling login --no-wait --no-open`。密码、验证码、第三方登录和双重验证由用户在浏览器完成；CLI 验证会话后原子保存到 OS 用户主目录 `.ai-modeling-auth/credentials/<service-sha256>/<account-sha256>.json`。同一 OS 用户/profile 的 CLI/MCP 共用，认证根不随业务 `AI_MODELING_DATA_DIR`、`HOME` 或 `TMPDIR` 变化。JSON 内有未额外加密的凭据，依赖私有权限，不读取其内容用于排障，也不写进日志、项目或发布包。

从 0.1.2 或更早的钥匙串版本升级时，程序不自动读取、迁移或删除旧条目；缺少 JSON 会话时走正常 `setup`/`login`。可选 LLM 密钥需通过对应配置入口重新设置。Windows 业务数据默认改为 `LOCALAPPDATA/ai-modeling`，未设置时使用用户主目录的 `AppData/Local/ai-modeling`；已有旧任务时可显式把 `AI_MODELING_DATA_DIR` 设为原业务目录，认证根不变。保留原 profile、账号和任务身份；`logout` 只清除当前 profile 会话并撤销流程，不清除其它 profile、上传引用、产物链接或独立 LLM 密钥。

初次安装可用 `doctor --offline --json` 检查本机条件，再用 `setup` 引导连接；已有有效会话不重复询问。`setup --check` 或 `--offline` 不启动登录，非交互 `setup --no-wait --no-open` 返回有界状态。MCP 用户继续使用当前客户端的认证资源和工具。default 集首次账号操作缺会话时返回 `AUTH_REQUIRED`、登录 URL 和 `login_id`；由用户完成浏览器交互，Agent 读取 `ai-modeling://auth/status`，确认同一个 `login_id` 的流程 `authenticated: true` 后按返回的原请求身份接续。ID 不同的历史流程不能当作本次完成。default 不需要先切换 Studio 工具集或调用 shell 登录。

用 `ai-modeling auth session status LOGIN_ID` 查询原流程，或 `ai-modeling auth session wait LOGIN_ID --timeout 30` 作有界等待。`LOGIN_ID` 使用真实返回值；单次等待超时不代表流程取消。流程查询返回 `scope: login_flow`，`credential_store_check` 和 `studio_session_check` 均为 `not_checked`：本次没有读取凭据 JSON 或检查远端会话。`authenticated`、`login_required`、余额及到期时间只是该流程的快照，已完成记录也可能长期保留；不能据此忽略后续工具的认证错误。没有流程的 `LOGIN_NOT_FOUND` 也不等于保存的会话失效。需要当前账号验证时使用 CLI 的 `auth status` 或当前 MCP 工具集的 `ai_modeling_balance`；否则以原任务接续工具的实际结果为准。

`CREDENTIAL_STORE_UNAVAILABLE` / `AUTH_DIRECTORY_INVALID` 表示私有 JSON 存储或权限检查失败。检查目录/文件所有者、权限、文件类型和客户端沙箱；Windows 另核系统 PowerShell 与受保护 ACL。升级时仅对经验证的应用自有控制目录和登录状态收紧旧 ACL，保留原状态与撤销信息；凭据 JSON 及外部导入文件的读取不会自动修复 ACL。不要读取秘密内容、放宽所有人访问、删除整个认证目录或换 profile 绕过。该错误不等于网页登录失效；修复后沿用原请求，凭据写结果未知时不能断言未写入或自动重提业务。

登录页回环地址属于 CLI 所在主机；无桌面的 SSH/容器不因此获得可见浏览器。WSL 与原生 Windows 使用不同的 OS 用户目录，不自动共享会话。不能默默换 profile、系统用户或数据目录解决问题。HTTP 403、额度不足和普通网络错误也不自动判为登录过期。

登录完成后继续原请求或任务。已发送的写请求不因重新认证而整体重放；保留错误中返回的原 `request_id` 和任务身份。

## 规划、费用与授权

沿用用户已经给出的操作范围、账号选择和预算，信息充分时直接推进，不逐步骤重复确认。请求解释、查能力或查看报价不等于授权生成；未授权的发布、分享、删除、第三方交接或新的收费意图不能从任务中自行扩展。

对支持的生成/处理入口，可先执行相同输入的 `--dry-run --json`：它检查参数和本地输入，不上传、联网报价或生成。`estimated_credits: null` 不表示免费，也不保证账号拥有远端能力。

`batch run` 当前没有 `--dry-run`；按需用等价的单项规划检查清单，不把真实批处理当作预览。所有操作是否支持某选项，以当前帮助为准。

当前工具集提供 `ai_modeling_quote` 时，按其 schema 与实际参数查询；该工具属于 Studio 集，不假定 default 集也有。default 生图要求 `max_estimated_credits`，使用用户已授权的上限；缺少该关键预算时取得用户决定，不猜报价、不改跑 shell。部分报价准备可能联网读取来源，报价不是提交。普通价格未知或过期时保留阻塞，不自行修改价格、期限或将未知视为零。

CLI 的 `pricing status` 离线显示来源、到期时间和刷新需求。维护源为 [reviewed-prices.json](https://github.com/seekskyworld/ai-modeling/blob/main/studio/api/reviewed-prices.json)。已有授权允许更新时，从对应 Release 取得审阅提交或标签及文件 SHA-256，使用固定提交的 raw.githubusercontent.com URL 调用 `pricing update HTTPS_URL --sha256 SHA256`；本地文件可用 `pricing verify/import FILE --sha256 SHA256 --network`。工具强制摘要与官方证据校验，不自动信任可变 main，不自动续期；不能把自行计算的下载摘要代替维护者发布值。选择 MCP 时保留入口，当前工具集没有价格维护能力则报告需维护者更新运行环境，不改跑 shell。

`--max-credits` / `max_estimated_credits` 是估算门槛，不是服务端硬扣费上限。多步骤可能分别收费；Canvas/Lab 的 `accept_variable_cost=true` 只在用户已授权可变费用时设置，不能为绕过失败自动添加。

若授权或关键输入确实缺失，先完成已有范围内的规划/检查，说明具体操作、费用性质与缺项后获取必要决定。明确报告能力限制，不切换开发者 API 钱包或其它模型提供商补结果。

## 执行与交付

- 使用用户选定的输入和输出位置；未指定时按项目惯例选合理可写位置并说明，不固定素材目录，不覆盖无关文件。
- 新的、已授权写意图使用稳定 `request_id`，记录返回的本地任务和远端回执；恢复时复用，不把每次调用当成新任务。
- `make/generate/处理命令 --out` 为输出根；`task get/watch --download --out` 和 full MCP 下载为精确目录。以 JSON 返回的实际文件路径为准。
- 只在入口支持时用 `--no-wait`；依赖前一步的多步骤通常需要等待。`--no-download` 省略交付到用户目录，仍可能读取并验证原件。
- 用原任务 `task get/watch` 查询和下载。需要准确来源时用明确任务/项目版本，避免后续新任务改变 `@last` 的含义。
- 原件下载、网页服务转换、固定网页引擎的本机转换和普通本地后处理分开说明。存在命令或远端成功不等于全部官方效果、任意提示语义或网页全站等价。

## 失败与恢复

`request_id` 不是 `task get/watch` 接受的任务 ID。先从原输出或历史确认本地 `job_id` / `task_id`；必要时读取 `ai_modeling_jobs_list` 当前 schema，以 `limit/offset` 分页查找，并核对原请求、意图及子步骤的对应关系，不能只凭前缀或 `-0` 后缀猜身份。确认唯一任务后用其 ID 执行 `task get`；提交结果不明且仍无唯一任务或可靠远端回执时，保留 `outcome_unknown`，不重提。

| 状态 | 行动 |
| --- | --- |
| `AUTH_REQUIRED` | 返回或完成网页登录，再继续原请求；不更换身份重提已发送写入。 |
| `PRICE_UNKNOWN` / 能力不支持 | 保留原因和已完成步骤，读取相关帮助/兼容说明；不擅改报价、不静默删参数或换钱包。 |
| 超时 / `outcome_unknown` | 超时不等于取消或未提交。查询原任务，只有唯一可靠服务回执才对账；没有回执时停止依赖操作，不自动重发。 |
| `needs_attention` | 保留真实回执与产物检查失败，报告哪项要求未通过；不缩放、替换来源或重新生成伪装成功。 |
| 下载失败 / 输出冲突 | 恢复原任务或选新的空目标，保留既有文件；不能用同字节陌生副本取得覆盖权。 |
| `IDEMPOTENCY_CONFLICT` | 原 ID 已绑定不同意图，先核原参数/来源；只有用户要新任务时才建新意图。 |

相同 batch manifest 与其 `.state.json` 用于恢复原提交。`--fresh` 和 `redo` 是新的生成/收费意图，不是补下载或未知提交的恢复方法。恢复还可能有只读网络请求，“没有新提交”不表示“没有联网”。

向用户交付实际文件位置、完成状态和必要限制；区分已验证结果、远端成功但未通过产物检查、尚未确认三种情况。凭据、签名链接和账号私密信息不进入公开报告；真实任务身份只保存在当前授权任务所需的私密上下文中。

## Golutra Agent

Skill 使用 `ai-modeling skill install --target golutra-agent --project-dir PATH` 安装到项目 `.agents/skills/ai-modeling`。TUI 可发现 `@skill:ai-modeling`；明确要求读取该目录的 `SKILL.md`，headless `exec` 也须显式引用路径，不假定自动注入。0.3.9 没有用户级 Skill 扫描。选择 Skill 路线时按说明调用 CLI。

`ai-modeling mcp export --target golutra-agent --out NEW_DIR` 可准备原生插件清单，但 Golutra Agent 0.3.9 会过滤 MCP 工具；即使 stage/review/enable 成功，模型仍不能调用。选择 MCP 的任务应报告这个宿主阻塞，不改跑 shell 来冒充 MCP 成功。须待宿主修复后重新验证；其原生 MCP 层还有限时约30秒、tools-only等限制，长任务应保留原任务身份并分次查询，不因超时重新生成。
