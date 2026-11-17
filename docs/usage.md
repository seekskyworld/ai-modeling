# 使用指南

ai-modeling 通过你的 Tripo Studio 网页会话提供建模功能，使用网页积分，不回退开发者 API 钱包。npm 包名为 `@seekskyworld/ai-modeling`，唯一命令为 `ai-modeling`，CLI 是底层执行接口。MCP 通过 `ai-modeling mcp` 启动，为 Agent 提供工具入口并在内部调用 CLI；Skills 沿用选定入口，提供说明、示例和流程指导。

本页介绍安装到任务恢复的常用流程；具体参数见[命令参考](commands.md)，实际支持范围见[兼容与限制](compatibility.md)，开发与验证见[开发指南](development.md)。

## Quick start in English

Install Node.js **24+** and npm, then install the single runtime package:

```sh
npm install --global @seekskyworld/ai-modeling@0.1.4
ai-modeling --version
ai-modeling doctor --offline --json
```

The [npm package](https://www.npmjs.com/package/@seekskyworld/ai-modeling) is `@seekskyworld/ai-modeling`; the executable is `ai-modeling`. Keep platform optional dependencies enabled. Choose one entry point:

- **Skill:** run `ai-modeling skill targets`, install with `ai-modeling skill install --target YOUR_CLIENT`, and check the same target with `skill status`. Reload the client's Skills or start a new session, then verify it can read the installed `SKILL.md` and call the CLI. Targets: `codex`, `claude-code`, `cursor`, `copilot`, `gemini-cli`, `opencode`, `golutra-agent`, and shared `agents`. Use `--project-dir` for Golutra Agent, which supports project scope only. See the [destination table](#安装-skill).
- **MCP:** add the [version-pinned npx configuration](../examples/mcp-npx.json) to your client, or use the [installed executable configuration](../examples/mcp-installed.json) after the global install. [Codex uses TOML](../examples/mcp-codex.toml); other clients have their own configuration locations. Restart/reload the server and confirm six tools plus `ai-modeling://guides/usage`. The default includes GPT Image 2.5 image generation and 3D generation. For asset/editing extensions, append `--toolset studio` to the launch arguments and restart. See [client-specific setup](#mcp-客户端配置).
- **CLI:** run commands directly as below. Skill and MCP both use this same runtime; installing npm alone does not install a Skill or modify client configuration.

```sh
ai-modeling setup
ai-modeling balance
ai-modeling make "a small toy robot" --model tripo-p2 --dry-run --json
```

Account operations use private local JSON files under the OS account's `.ai-modeling-auth` directory. No system keychain, Linux Secret Service or session D-Bus is required for credentials. POSIX directories/files use `0700/0600`; Windows uses protected ACLs for the current user and SYSTEM, checked through system PowerShell. The JSON contains unencrypted credentials and must stay out of repositories, packages and logs. WSL and native Windows use their own OS user homes. Browser login needs an installed Chrome/Edge and a visible desktop. `setup` reuses a valid JSON session and guides login when needed; older keychain entries are not automatically read or migrated. Passwords and verification stay in the browser; do not copy account tokens into MCP configuration. See [storage and upgrades](#本地-json-凭据).

For MCP, a missing session returns `AUTH_REQUIRED`, a login URL and `login_id`. The user completes that login; the agent reads `ai-modeling://auth/status` until the same `login_id` reports `authenticated: true`, then continues the original request through MCP with its returned request identity. The resource is a flow snapshot and does not verify current credential access or the remote session; the resumed tool reports its actual authentication result.

If setup returns `CREDENTIAL_STORE_UNAVAILABLE` or `AUTH_DIRECTORY_INVALID`, check the private JSON directory's owner, file permissions and sandbox access. On Windows, ensure system PowerShell is available and the ACL can be verified. Upgrade initialization can tighten legacy ACLs on verified application-owned control directories and login-state files, preserving their contents and cancellation state; credential records and external import files are only checked, never repaired on read. Do not publish the JSON, loosen access for everyone or switch profiles to get past the error. A local storage error does not mean the Studio session expired; retain the original request and any unknown write outcome before retrying.

The dry run checks local inputs and does not submit or quote a live task. Remove `--dry-run` only when ready to spend Studio web credits, which are separate from the developer API wallet. Use a stable `--request-id` for each new intended submission and retain the returned task identity. `task get TASK_ID` and `task watch TASK_ID --download --out ./assets` inspect or finish that task. `outcome_unknown` requires reconciliation of the original receipt; `needs_attention` requires checking the output mismatch. Neither is a reason to create a paid replacement automatically.

To avoid a global installation, use the complete prefix for every command:

```sh
npx --yes --package @seekskyworld/ai-modeling@0.1.4 ai-modeling --version
npx --yes --package @seekskyworld/ai-modeling@0.1.4 ai-modeling skill install --target claude-code
```

Use the same pinned package when the Skill invokes CLI through npx. To upgrade, select a published version, update the runtime, then update the Skill in the same destination or the MCP configuration. Do not assume an existing client reloads automatically. Node/npm or the installed command must be on the client's PATH; GUI applications may need an absolute executable path.

[Release archives](https://github.com/seekskyworld/ai-modeling/releases) offer a separate installation route below. Source users run `npm ci` and `npm run build`, then replace every `ai-modeling` command with `node /absolute/path/to/ai-modeling/dist/cli/main.js`; building alone does not install a global executable.

`setup --check` reports diagnostics without starting login; `setup --offline` also avoids credentials and network. For headless clients, `setup --no-wait --no-open` returns a bounded login status. Query `auth session status` or wait with `auth session wait LOGIN_ID --timeout 30`. A loopback login URL belongs to the machine running the CLI.

Use `pricing status` to inspect price provenance and expiry offline. The maintained [pricing source](https://github.com/seekskyworld/ai-modeling/blob/main/studio/api/reviewed-prices.json) records review dates, prices and official evidence. For an update, use the reviewed commit or release tag and its published SHA-256 as described under [pricing maintenance](#价格快照更新). `pricing verify/import FILE --sha256 SHA256 --network` checks and installs a local snapshot; `pricing update HTTPS_URL --sha256 SHA256` downloads and validates one. These commands do not generate assets. Matching evidence hashes does not replace review of the formulas; expiry is never extended automatically.

The Release's **Reviewed pricing snapshot** section supplies the immutable JSON URL, **Source JSON SHA-256**, review/expiry dates and a copyable update command. Use that original-file digest, not the runtime TGZ digest or `canonical_sha256` from status/readiness reports. An expired historical snapshot still requires a newer reviewed version.

For optional features, run `doctor --offline --feature render`, `video`, or `frontend-export`. Blender 4.5+, FFmpeg/libx264 and the fixed conversion runtime are required only for their relevant operations. Review [capability status](compatibility.md#能力状态--capability-status) before relying on a particular effect.

## 安装

需要 Node.js **24+** 和 npm。账号操作使用当前 OS 用户的私有 JSON 文件，支持 macOS/Linux 的 POSIX 权限以及 Windows ACL，不要求系统钥匙串或 Linux Secret Service/D-Bus。Windows 需要系统 PowerShell 执行有界 ACL 检查；WSL 与原生 Windows 各用自身 OS 用户目录。离线工具发现和 Skill 安装管理不需要读取会话。保留 npm 平台可选依赖，不使用 `--omit=optional`。

自动登录需要已安装 Chrome 或 Edge，并能打开可见窗口。无桌面的 SSH、容器环境不一定具备浏览器；使用已保存 JSON 会话时仍需私有目录权限与网络访问。安装成功不代表所有系统与浏览器组合已完成真实登录验收。

### 安装运行包

从 [npm](https://www.npmjs.com/package/@seekskyworld/ai-modeling) 安装固定版本：

```sh
npm install --global @seekskyworld/ai-modeling@0.1.4
ai-modeling --version
ai-modeling doctor --offline --json
```

0.1.0 预发布版可能在全局安装后缺少原生依赖；使用0.1.4修补版。执行安装后紧接着运行 `ai-modeling --version` 和离线诊断，不能仅凭 npm install 退出码判定程序可用。

`@seekskyworld/ai-modeling` 是包名，`ai-modeling` 是唯一命令。一个包包含 CLI、MCP 和随包 Skill 指导，不需要分别安装三个运行引擎。发行包随附已审阅的可移植生产依赖，原生包及其平台依赖交由 npm 安装；保留 optional 依赖，不手工拼装其它平台的原生包。CLI 用户直接继续；Skill 用户执行下一节的目标安装；MCP 用户按[客户端配置](#mcp-客户端配置)添加服务。

不做全局安装时，每次用 `npx --yes --package @seekskyworld/ai-modeling@0.1.4 ai-modeling` 替换命令前缀。比如 `npx --yes --package @seekskyworld/ai-modeling@0.1.4 ai-modeling skill install --target claude-code`；此时 Skill 的 CLI 调用也沿用同一完整前缀。MCP 可直接使用[npx 配置](../examples/mcp-npx.json)。

`ai-modeling update` 离线显示更新指引，`ai-modeling update --check` 查询 scoped npm 的最新版本；它们不自动安装。升级时选择已发布版本，重新安装运行包，并在原目标/范围执行 `skill install` 更新指导；MCP 固定版本配置也需更新并重启。多版本环境用 `command -v ai-modeling` 或 PowerShell `Get-Command ai-modeling -All` 检查实际入口，避免新 Skill 调用旧程序。首次账号操作用 `ai-modeling setup` 引导连接，不把 Token 放进 MCP 配置。

### 使用 Release 归档

也可从 [GitHub Releases](https://github.com/seekskyworld/ai-modeling/releases) 取得 `ai-modeling-VERSION.tgz` 与 `SHA256SUMS`，或从源码导出。核对校验和后，把归档解包到自己选择的新持久目录。替换实际版本和路径；目标父目录须已存在：

```sh
mkdir "/path/to/ai-modeling-runtime"
tar -xzf "/path/to/ai-modeling-VERSION.tgz" -C "/path/to/ai-modeling-runtime" --strip-components=1
cd "/path/to/ai-modeling-runtime"
npm ci --omit=dev --no-audit --no-fund
npm link --omit=dev --ignore-scripts
ai-modeling --version
```

`npm ci` 使用归档内的生产 `npm-shrinkwrap.json`，`npm link` 暴露同一个 CLI。保留此目录及其依赖，不只复制入口文件；它不是可随时清理的临时解包目录。源码运行、npm 包安装、归档解包是三条独立路径，不混用其中的 `command` / `args`。

### 安装 Skill

运行包已经附带同版本 Skill，不会在安装 npm 依赖时自动写入客户端目录。先查看目标，再明确选择客户端。以下以 Claude Code 的用户范围为例：

```sh
ai-modeling skill targets
ai-modeling skill install --target claude-code --scope user
ai-modeling skill status --target claude-code --scope user
```

必须指定 `--target` 或 `--dir`，没有默认客户端。命名目标的 `--scope` 一般默认为 `user`；`golutra-agent` 仅支持 `project`，并默认使用它。`project` 范围以当前目录为项目根，不向上查找仓库。可用 `--project-dir` 指定已存在的项目目录，例如：

```sh
ai-modeling skill install --target cursor --scope project --project-dir /path/to/project
ai-modeling skill status --target cursor --scope project --project-dir /path/to/project
```

以下均为技能父目录，安装器会再创建 `ai-modeling/` 子目录。`~` 表示当前 OS 用户主目录，`PROJECT` 表示当前目录或 `--project-dir` 指定的项目目录。

| 目标 | 用户范围父目录 | 项目范围父目录 | 官方目录说明 |
| --- | --- | --- | --- |
| `codex` | `~/.agents/skills` | `PROJECT/.agents/skills` | [Codex / ChatGPT Skills](https://learn.chatgpt.com/docs/build-skills) |
| `claude-code` | `~/.claude/skills` | `PROJECT/.claude/skills` | [Claude Code Skills](https://code.claude.com/docs/en/skills) |
| `cursor` | `~/.cursor/skills` | `PROJECT/.cursor/skills` | [Cursor Skills](https://cursor.com/docs/skills) |
| `copilot` | `~/.copilot/skills` | `PROJECT/.github/skills` | [VS Code Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills) |
| `gemini-cli` | `~/.gemini/skills` | `PROJECT/.gemini/skills` | [Gemini CLI Skills](https://geminicli.com/docs/cli/skills/) |
| `opencode` | `~/.config/opencode/skills` | `PROJECT/.opencode/skills` | [OpenCode Skills](https://opencode.ai/docs/skills/) |
| `golutra-agent` | 不支持 | `PROJECT/.agents/skills` | [Golutra Agent](https://github.com/golutra/golutra-agent)，0.3.9 TUI 工作区 Skill 扫描 |
| `agents` | `~/.agents/skills` | `PROJECT/.agents/skills` | 共享目录；上列 Codex、Cursor、Gemini CLI、OpenCode 文档明确支持 |

`agents` 是共享目录选项，不代表所有客户端都会读取它；它与 `codex` 指向相同位置，无需分别安装两份。上述表格记录安装器支持的目录约定，不表示已在每个宿主客户端完成加载实测。客户端自定义配置或其它位置使用 `--dir`，不假定客户端环境变量会改变这些目标路径。

Golutra Agent 的项目目标也使用 `.agents/skills`；本机 0.3.9 的 TUI 按当前工作区扫描 `SKILL.md`，遵守 Git ignore，最多扫描 8 层。该实现没有用户级 Skill 目录；不要把 `~/.golutra-agent/skills` 当作会自动加载的路径。项目发现、TUI 提及与运行时自动注入是不同能力，调用方法见 [Golutra Agent](#golutra-agent)。

自定义位置使用下面的替代命令；`--dir` 与 `--target`、`--scope`、`--project-dir` 互斥：

```sh
ai-modeling skill install --dir /path/to/skills
ai-modeling skill status --dir /path/to/skills
```

旧安装不会自动迁移或删除。原先放在 `~/.codex/skills` 或其它自定义位置的内容，仍可通过指向其实际父目录的 `--dir` 查询或管理；不要将旧目录当作新的默认位置。

安装后刷新客户端 Skill 列表或重启会话，让 Agent 明确使用 `ai-modeling`；核对其能读取输出目录中的 `SKILL.md` 并运行同版本 CLI。仅 `skill status` 成功不能证明客户端已加载。

安装和状态检查只处理本地 Skill 文件，不需要 Studio 账号，也不修改 MCP 配置。`skill status` 不创建目录，返回目标路径、已安装版本、随包版本和冲突列表；`not_installed` 表示没有安装，`installed` 表示文件与管理记录一致，`unmanaged` 或 `modified` 表示需保留并检查现有内容。新增、修改、缺失文件或不安全的路径都会阻止覆盖，不通过删除用户文件绕过冲突。

再次运行 `skill install` 时，完全相同的内容返回 `current`；本工具管理且未被修改的旧安装可以更新为当前包的指导文件，返回 `updated`。更新运行包不会自动更新已复制的 Skill，应按需要对原目标再运行安装命令。

需要卸载时，使用 `ai-modeling skill uninstall` 并带回相同的目标、范围与项目目录，或相同的自定义 `--dir`。卸载只处理本工具管理且未被修改的安装；检测到改动或未管理内容时保留文件并返回冲突。它不卸载运行包，也不清除账号、任务或生成素材。

独立的 `ai-modeling-skill-VERSION.zip` 继续支持手动导入：将包含 `SKILL.md` 的 Skill 文件夹及附带参考文件一起导入客户端，并确认 Agent 能调用已安装的 `ai-modeling`。手动复制的内容不会被安装器自动接管。

Skill 提供使用说明、组合示例和流水线指导，不是独立业务引擎，也不包含登录凭据。选择 MCP 时，Agent 使用 MCP 工具，由 MCP 内部调用 CLI，不绕过客户端改跑 shell。只取得 Skill ZIP 时，仍须另行安装上面的运行包。源码入口为 [skills/ai-modeling/SKILL.md](../skills/ai-modeling/SKILL.md)，可用于审阅操作约定。

### 从源码导出或运行

在自己的源码目录执行，导出输出目录必须位于源码仓库之外、尚不存在且父目录已存在。检查会解析软链接，不能通过软链接指向仓库内：

```sh
cd /path/to/ai-modeling
npm ci
npm run export -- --out ../ai-modeling-export
```

默认 `--target all` 生成 `ai-modeling-skill-VERSION.zip`、`ai-modeling-VERSION.tgz`、`mcp.json`、`INSTALL.md`、`manifest.json` 和 `SHA256SUMS`。按导出的 `INSTALL.md` 安装，输出目录不会被覆盖。

单独导出可用 `npm run export:skill -- --out DIR` 或 `npm run export:mcp -- --out DIR`，等价于指定 `--target skill` / `--target mcp`；每次都要选择符合上述条件的仓库外新目录。Skill 可独立导出但不附带运行包，MCP 导出会构建。分发维护见[开发指南](development.md#打包与分发)。

只从源码运行时，在 `npm ci` 后执行 `npm run build`。下文所有 `ai-modeling` 均可替换为 `node /absolute/path/to/ai-modeling/dist/cli/main.js`。

## 登录与接续

```sh
ai-modeling doctor --offline --json
ai-modeling setup
ai-modeling balance
```

`setup` 先检查环境与现有会话；已经认证时直接返回，不重复询问登录。需要连接时，交互终端可选择专用 Chrome/Edge 窗口、显式授权的本机 CDP 或只显示说明。`setup --check` 只诊断，`setup --offline` 也不读凭据或联网，两者都不启动登录。非交互调用可用 `setup --no-wait --no-open` 获取有界登录状态；支持 `--browser-executable`、`--cdp-endpoint` 和 `--timeout`。即使登录成功，价格或依赖缺项仍会返回 `setup_status: needs_configuration`，按具体检查项处理。

`login` 先验证已有 JSON 会话，需要时打开独立浏览器窗口。密码、验证码和双重验证由你完成；CLI 验证账号后将会话存入[私有 JSON 文件](#本地-json-凭据)。有效 Cookie 可用于续期，只有 Bearer 的导入会标记 `renewable:false`。`balance` 是联网只读查询，不生成素材。

程序不会自动安装浏览器或读取普通浏览器用户目录。找不到程序时使用 `login --browser-executable /absolute/path/to/chrome-or-edge`。备用入口为 `login --form` 的本机表单、`login --paste` / `auth import --stdin`，或只接受私有普通文件的 `auth import --file PATH`（Unix 权限 0600；Windows 须有仅当前用户 SID 与 SYSTEM 可访问的受保护 ACL，导入不会替外部文件修权限）。凭据不要放入命令行参数、环境文件或 MCP 配置。

非交互 CLI/MCP 默认返回登录状态；也可主动取得本机入口：

```sh
ai-modeling login --no-wait --no-open
ai-modeling auth session status
ai-modeling auth session wait LOGIN_ID --timeout 30
ai-modeling auth session cancel LOGIN_ID
```

`--no-open` 页面需要点击按钮才打开窗口；它的 `127.0.0.1` 属于运行 CLI 的主机，不把登录转移到另一台机器。整个流程最多 15 分钟，单次等待超时不取消或延长它。关闭窗口、取消或总期限结束会停止流程；`logout` 还会清除当前 profile 的凭据，迟到验证不能恢复旧登录。

`auth session status` 查询短时流程；没有流程的 `LOGIN_NOT_FOUND` 不等于会话无效。实时只读验证用 `auth status`。交互 CLI 可在安全请求边界登录后继续；MCP 应沿用错误中返回的原 `request_id` 或任务 ID。已发送的写请求不会因登录而整体重放，HTTP 403、额度不足和普通网络错误也不自动视为登录过期。

显式 `AI_MODELING_BROWSER_CDP_ENDPOINT` / `login --cdp-endpoint` 只接受已授权的本机回环 HTTP(S)/WS(S) 地址，不接受远程主机、用户密码、query 或 hash。连接器只操作自己的页面，不关闭用户浏览器，也不向既有上下文注入旧会话。

## 使用 CLI

需要查看已有网页素材时，登录后按类型分页查询账号资产；这些命令只读取列表，不生成素材：

```sh
ai-modeling assets list --kind model --limit 20 --offset 0 --json
ai-modeling assets list --kind image --limit 20 --offset 0 --json
```

将响应中的 `next_offset` 用于下一页，返回 `null` 时结束。此列表包含网页创建的资产，与本机 `task list` 的任务记录不同。图像下载使用返回的 `outputs[].index` 选择输出；删除图像等后续操作需要精确输出键时，先通过 `studio image-get` 查询，避免将索引误作键。图像独立收藏的网页映射仍未确认，不代表平台没有该功能。

安装包提供离线 JSON 指南，内容与 Skill/MCP 共用；按需查询，避免一次加载完整手册：

```sh
ai-modeling guides list
ai-modeling guides templates
ai-modeling guides read commands/index
ai-modeling guides read commands/model/convert
ai-modeling guides read pipelines
```

`usage` 提供使用与恢复说明，`commands` 提供完整命令参考；通常先读索引与具体分片，或用具体命令的 `--help` 即可。

先发现能力并离线规划：

```sh
ai-modeling models --json
ai-modeling make "a small toy robot" --model tripo-v3.1 --dry-run --json
ai-modeling studio image --help
ai-modeling docs --topic commands/make
```

`--dry-run` 检查参数与本地输入，不上传、联网报价或生成。`estimated_credits: null` 不是零费用，也不保证账号具备远端能力。默认 3D 生成使用 P2，独立生图与图像编辑默认使用 GPT Image 2.5（`gpt_image_2.5_sunburst`）；模型别名和参数差异以帮助与兼容说明为准。

准备执行时，显式选择意图和输出方式。下面的生成命令会使用网页积分；查询和下载继续使用其原任务：

```sh
ai-modeling generate text-to-image "a blue toy robot" --model banana2 \
  --name concept --request-id concept-001 --no-download
ai-modeling task get @concept --json
ai-modeling task watch @concept --download --out ./assets --json
```

`--no-wait` 适用于支持异步提交的单任务；多步骤处理可能要求等待。`--no-download` 省略向调用方目录交付，但有产物证明义务的操作仍会读取并验证原件。`--then` 可组合处理步骤；`rig-check` 明确不通过时停止后续绑定。多候选的无人值守调用应明确选择结果，再执行后续操作。

`studio` 和 `canvas` 提供网页扩展。使用 `ai-modeling <command> --help` 查看具体参数，或用 `ai-modeling tools --toolset studio` 读取工具 schema；工具与指南发现是纯元数据读取，不访问账号或凭据文件，也不创建目录和任务库。结构化调用支持 `call TOOL --input-stdin` 或 `--input JSON`，与 `--toolset`、`--profile` 可按正常任意顺序排列，支持 `--flag=value`。重复、未知、互斥或缺值选项及非对象 JSON 返回 `INVALID_INPUT`。复杂编辑的输入范围、素材身份和处理条件应按相应命令帮助检查。

批处理入口是 **`ai-modeling batch run MANIFEST`，当前没有批处理 `--dry-run`**。先按[示例](../examples/README.md)用等价的 `make --dry-run` 预览各项。真实批处理会提交网页任务，清单旁的 `.state.json` 保存恢复身份；重跑须保留它。`--fresh` 是新的提交意图，不是未知结果的恢复办法。

## 使用 MCP

先安装运行包，再把导出的 `mcp.json` 合并到支持 `mcpServers` 的客户端。也可使用[安装包配置示例](../examples/mcp-installed.json)：

```json
{
  "mcpServers": {
    "ai-modeling": {
      "type": "stdio",
      "command": "ai-modeling",
      "args": ["mcp"],
      "env": {"AI_MODELING_PROFILE": "default"}
    }
  }
}
```

客户端需要在自己的 PATH 中找到 `ai-modeling`；GUI 客户端不一定继承终端环境，找不到时按客户端要求填写实际可执行文件路径。其它客户端按其原生格式设置相同的程序、参数与环境变量，配置中不放凭据。

### MCP 客户端配置

Skill 的目标目录与 MCP 配置是两件独立的事；安装 Skill 不注册 MCP，配置 MCP 也不要求导入 Skill。按所用客户端的原生格式合并配置，保留已有服务：

| 客户端 / 配置方式 | 本项目示例与放置方式 | 官方参考 |
| --- | --- | --- |
| Claude Code | [通用 JSON](../examples/mcp-installed.json)，项目根目录 `.mcp.json` 的 `mcpServers`；用户范围也可通过客户端自身的添加命令配置 | [Claude Code MCP](https://code.claude.com/docs/en/mcp) |
| Cursor | [通用 JSON](../examples/mcp-installed.json)，项目 `.cursor/mcp.json` 或用户 `~/.cursor/mcp.json` 中的 `mcpServers` | [Cursor MCP](https://cursor.com/docs/mcp) |
| VS Code Copilot / Copilot CLI | [通用 JSON](../examples/mcp-installed.json)，采用当前推荐的 portable `mcpServers` 格式，按客户端选择用户或项目范围 | [Copilot MCP 配置](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) |
| Codex | [TOML 示例](../examples/mcp-codex.toml)，合并到用户 `config.toml` 或受信任项目的 `.codex/config.toml`，使用 `mcp_servers` 表 | [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) |
| Gemini CLI | 使用 `mcpServers`、`command`、`args` 和 `env`；参照[通用 JSON](../examples/mcp-installed.json)的启动字段，按 Gemini 官方配置省略 `type` 字段 | [Gemini CLI MCP](https://geminicli.com/docs/cli/tutorials/mcp-setup/) |
| OpenCode | [OpenCode JSON](../examples/mcp-opencode.json)，按其配置范围合并 `mcp.servers`；本地服务使用 `type: local`、命令数组和 `environment` | [OpenCode MCP](https://opencode.ai/docs/mcp-servers/) |
| Golutra Agent | `mcp export` 可生成并注册原生清单；0.3.9 宿主过滤 MCP 工具，当前不能调用，见下文限制 | [Golutra Agent](https://github.com/golutra/golutra-agent) |
| VS Code 旧编辑器管理配置 | [兼容 JSON](../examples/mcp-vscode.json)，用于既有 `.vscode/mcp.json` 或用户配置中的 `servers` 格式；新 Copilot 配置使用通用 `mcpServers` 格式 | [旧 Local 配置说明](https://code.visualstudio.com/docs/agents/reference/mcp-configuration#_editor-managed-configuration-for-local-harness-compatibility) |

VS Code 官方已弃用 Local harness，并计划于 2027 年 2 月移除；旧 `servers` 示例用于维护现有配置，不作为新 Copilot 的推荐入口。起步示例启动 `ai-modeling mcp` 的6工具默认集；需要网页资产与编辑扩展时追加 `--toolset studio`。两者共用同一 CLI 后端。

未全局安装时，可按[npx 示例](../examples/mcp-npx.json)使用固定版本的 npm 包。GUI 找不到 `npx` 或 `ai-modeling` 时，配置实际可执行路径，并保证同一环境可找到 Node.js 24+；不要依赖终端专属初始化脚本。

配置格式来自对应官方文档；示例语法和服务端离线发现检查不能替代宿主客户端实测。合并后，在所用客户端中确认服务启动、工具列表和指南资源可用；这一步不需要生成素材。客户端之间的工具审批与资源展示方式可能不同。

源码运行使用[源码入口示例](../examples/mcp.json)：将 Node 和 `dist/cli/main.js` 的占位路径替换为实际绝对路径，脚本路径后保留 `mcp`；扩展集再追加 `--toolset studio`。可用 `node -p "process.execPath"` 查找 Node；Windows JSON 使用正斜杠或转义反斜杠。`command` 只放程序，参数分开放在 `args`，不自动展开 `~`、`$HOME` 或整条 shell 命令。

| 工具集 | 用途 |
| --- | --- |
| `default` | 6个常用工具：3D生成、独立生图/图像编辑、任务查询、等待、余额与历史 |
| `full` | 兼容官方工具框架，受网页能力限制 |
| `studio` | 网页扩展、本地辅助与登录流程工具 |

`ai-modeling mcp` 默认使用 `default` 工具集，已含 `ai_modeling_image_generate`，其模型、比例、数量、4K、模板和参考图参数与 Studio 集相同；其它网页扩展显式使用 `ai-modeling mcp --toolset studio`。所有工具集提供 `ai-modeling://auth/status`；Studio 集另有 `ai_modeling_auth_begin/status/wait/cancel`，其中 begin 默认不打开窗口，wait 单次为 1–60 秒。

默认集首次账号操作也支持登录接续：工具缺会话时返回 `AUTH_REQUIRED`、登录 URL 和 `login_id`，由用户完成浏览器交互。Agent 读取 `ai-modeling://auth/status`，确认返回的是原 `login_id` 且该流程 `authenticated: true`，再携带原 `request_id` 继续尚未提交的操作。资源的 `scope: login_flow`、`credential_store_check: not_checked`、`studio_session_check: not_checked` 表示本次只读流程快照；历史成功、余额或到期时间不证明当前凭据可读或会话可用，ID 不同的流程不能当作本次完成。以接续工具的实际结果为准；需要主动验证时可调用当前工具集的 `ai_modeling_balance`。不换用 shell，不重新提交结果未知的写入；客户端工具调用超时也不能证明任务未执行。

MCP 经同包 CLI 子进程执行业务。它应与 CLI 使用同一 OS 用户、profile 和数据目录；自定义环境须写入客户端的 `env`。MCP 等待 stdio 输入是正常状态，没有网页控制台；不要往 stdout 添加调试日志。

MCP 既提供指导，也提供工具入口。Agent 可先读 `ai-modeling://guides/commands/index`，再按 `ai-modeling://guides/commands/{+command}` 模板读取 `model/convert` 等具体分片；`usage`、`commands`、`pipelines` 仍与 Skill 参考资料及公开命令参考同源。选择 MCP 时保持 `Agent → MCP → CLI` 链路，不为读取指南或执行任务自行改跑 shell CLI。

### Windows 启动方式

Windows 的 npm 全局命令通常带 `.cmd` 启动脚本。能解析这些脚本的 MCP 宿主可继续使用通用 `npx` / `ai-modeling` 示例；不能直接启动 `.cmd` 的宿主使用 [Windows npx 配置](../examples/mcp-npx-windows.json)，由 `cmd.exe /d /c npx.cmd` 启动固定版本。Node.js 的直接 `execFile` 与采用 cross-spawn 的客户端行为不同，不能仅凭 macOS 的协议测试判断 Windows 启动必然成功。依据[Node.js 子进程说明](https://nodejs.org/docs/latest-v24.x/api/child_process.html#spawning-bat-and-cmd-files-on-windows)检查实际宿主。

已安装运行包时，也可直接配置 Node，无需 shell：`command` 使用 `node -p "process.execPath"` 得到的 `node.exe` 路径，`args` 使用已安装包的 `dist/cli/main.js` 绝对路径和 `mcp`。全局安装根可通过 `npm.cmd root --global` 查询，包位于其 `@seekskyworld/ai-modeling` 子目录；保留完整运行包与依赖。将路径作为独立 JSON 字符串，不在字符串中额外加入 shell 引号，也不把 `%APPDATA%` 等未展开变量直接当路径。

PowerShell 若因执行策略拒绝 `npm.ps1` / `npx.ps1`，可调用对应 `npm.cmd` / `npx.cmd`，无需为此降低整机执行策略。MCP 客户端仍需能找到 Node/npm；GUI 的 PATH、工作目录和沙箱权限应单独检查。以上是启动配置与源码依据，不能代替 Windows 实机、原生 ACL、浏览器登录和宿主工具调用的验收。

### Golutra Agent

Golutra Agent 0.3.9 支持发现项目 Skill。先安装运行包，在自己的项目中安装 Skill：

```sh
ai-modeling skill install --target golutra-agent --project-dir /absolute/path/to/project
ai-modeling skill status --target golutra-agent --project-dir /absolute/path/to/project
golutra-agent --cwd /absolute/path/to/project
```

TUI 输入 `@skill:ai-modeling` 可选择项目内的 Skill。提及本身不会自动注入正文；首次使用时请 Agent 读取 `.agents/skills/ai-modeling/SKILL.md`，再按需读取其参考资料。非交互 `exec` 也须明确要求读取该文件。安装器不提供该客户端的用户范围，不写入 Golutra 桌面的 `.golutra` 目录。

运行包及其依赖还须位于客户端沙箱可读的位置；已在 macOS 0.3.9 验证项目内安装的 Skill 读取与离线 CLI 调用。工作区外的临时安装路径可能返回 `EPERM`，命令链接存在不等于原文件可读；可将完整运行包安装到所选项目内，或使用宿主已授权的安装位置。真实账号、网络和私有 JSON 凭据目录访问仍须按运行环境另行验收。

**当前 MCP 限制：** 已在原生 0.3.9 验证三包清单 `stage/review/enable` 成功，但其 provider 工具白名单只包含内置工具，MCP 工具不会进入模型可调用列表；`full` 工具模式或审批开关不能修复。下面的导出和注册步骤用于准备接入，不能据此认定 MCP 已可执行。须等待 Golutra Agent 修复工具暴露与调用过滤，并重新验收；尚未确认其它版本已修复。现在可选择上面的 Skill/CLI 路线，选择 MCP 的任务遇到该限制应报告阻塞，不自行改为 shell 执行业务。

准备 MCP 清单时，从长期保留的运行包导出到新的目录。下面的环境变量只传递名称，值由启动 Golutra Agent 的进程提供；将示例路径换成自己的绝对路径：

```sh
ai-modeling mcp export --target golutra-agent --out /absolute/path/to/new-plugin-export \
  --env AI_MODELING_DATA_DIR --env AI_MODELING_OUTPUT_DIR
```

默认 Studio 集的 176 个工具按每包最多 64 个工具拆为三包，目录依次为 `ai_modeling_studio_1`、`ai_modeling_studio_2`、`ai_modeling_studio_3`。每包的 `golutra-agent-plugin.json` 都指向同一个已安装 CLI，保持 `Agent → MCP → CLI`；导出不注册或启用插件。也可用 `--toolset default` 或 `--toolset full` 选择较小的工具集。

工具参数 schema 保持完整；若描述超过客户端的 4096 字符限制，清单会明确标注缩短，完整原文保存在导出目录的 `README.md`，摘要返回 `shortened_descriptions` 供审阅。

对导出结果中的**每个插件目录**分别执行以下步骤。使用 `stage` 返回的实际插件 ID 与 revision ID，审阅清单和权限后再启用；下面仅展示第一包：

```sh
golutra-agent --cwd /absolute/path/to/project plugin stage /absolute/path/to/new-plugin-export/ai_modeling_studio_1
golutra-agent --cwd /absolute/path/to/project plugin review ai_modeling_studio_1 REVISION_ID
golutra-agent --cwd /absolute/path/to/project plugin enable ai_modeling_studio_1 REVISION_ID
golutra-agent --cwd /absolute/path/to/project plugin list
```

宿主修复后复验时，在启动客户端的同一终端设置已声明的变量，路径位于获准的项目工作区内：

```sh
export AI_MODELING_DATA_DIR=/absolute/path/to/project/.ai-modeling/state
export AI_MODELING_OUTPUT_DIR=/absolute/path/to/project/assets
golutra-agent --cwd /absolute/path/to/project
```

`--env NAME` 可重复；未使用时清单的 `env` 为空列表。声明的每个变量在运行 Golutra Agent 时都必须存在，不能把未设置的可选变量加入清单。可按需传递 profile、输入根、代理或外部程序路径，不在清单、环境文件或命令参数里放账号 Token。导出记录当前 Node 和同包 CLI 的绝对路径；移动或升级运行包后须重新导出并审阅新 revision。

原生插件进程的当前目录是插件包目录，素材与交付参数应使用绝对路径；工作区写权限不覆盖任意用户目录。账号操作还取决于私有 JSON 凭据及登录协调目录在客户端沙箱中的可用性，工具发现通过不能替代真实账号验收。当前客户端使用 macOS Seatbelt 或 Linux bubblewrap 执行插件，Windows 可以管理清单但尚不能执行这种原生受限 MCP 插件。

Golutra Agent 当前桥接 MCP 工具，尚不桥接 `ai-modeling://guides/*` 资源；可同时安装上述 Skill 读取指导，业务仍调用 MCP 工具。客户端每次调用重新启动服务，默认工具执行限时约 30 秒；长生成应异步提交，再查询原任务，超时不重新提交付费任务。`.mcp.json` 在该版本仅用于 TUI 提及发现，不代替上述插件注册。停用某包使用 `golutra-agent plugin disable PLUGIN_ID`。

## 重要配置与文件路径

| 配置 | 含义 |
| --- | --- |
| `AI_MODELING_PROFILE` | 凭据 profile；默认读取本地 `active_profile`，否则 `default` |
| `AI_MODELING_DATA_DIR` | 任务库、设置、输入与转换缓存目录 |
| `AI_MODELING_OUTPUT_DIR` | 可选交付根限制，不是兼容 CLI 的默认 `--out` |
| `AI_MODELING_INPUT_ROOTS` | 可选输入目录白名单；macOS/Linux 用 `:`，Windows 用 `;` 分隔 |
| `AI_MODELING_BROWSER_EXECUTABLE` / `AI_MODELING_BROWSER_CDP_ENDPOINT` | 浏览器程序或显式本机调试连接 |
| `AI_MODELING_BLENDER` / `AI_MODELING_FFMPEG` | 可选本地程序；未设置时查找 PATH 中的 `blender` / `ffmpeg` |
| `AI_MODELING_EXPERIMENTAL_MESH_EDIT=1` | 在 full MCP 工具集中启用实验性 `ai_modeling_mesh_edit` |

默认业务数据目录：macOS 为用户主目录下的 `Library/Application Support/ai-modeling`；Linux 为 `XDG_DATA_HOME/ai-modeling`，未设置时使用 `~/.local/share/ai-modeling`；Windows 为 `%LOCALAPPDATA%/ai-modeling`，未设置时使用用户主目录下的 `AppData/Local/ai-modeling`。`AI_MODELING_DATA_DIR` 可覆盖业务数据位置。相对环境路径基于进程工作目录，MCP 中宜使用绝对路径。

兼容命令的 profile 优先级为 `--profile` → `AI_MODELING_PROFILE` → 本地 `active_profile` → `default`。先 `ai-modeling login --profile personal`，再 `ai-modeling use personal` 可保存选择；原始 `auth`、`call` 入口和 MCP 使用环境或本地默认值，不假定它们接受兼容层的 `--profile`。

凭据与任务目录分离。OS 用户主目录下的 `.ai-modeling-auth` 保存私有 JSON 凭据、登录协调状态和锁，按同一用户/profile 共享；改变 `AI_MODELING_DATA_DIR` 不隔离同 profile 的凭据或登录流程，改变 profile 也不自动新建任务库。

### 本地 JSON 凭据

认证根通过 OS 用户信息确定，固定在该用户主目录的 `.ai-modeling-auth`，不受 `HOME`、`TMPDIR`、工作目录或 `AI_MODELING_DATA_DIR` 改变影响，也没有公开环境变量重定位入口。每条凭据位于 `credentials/<service-sha256>/<account-sha256>.json`，使用 `schema_version: 1` JSON envelope；会话按 profile 共享，上传引用、私有产物链接和可选 LLM 密钥也使用独立 JSON 条目。目录名使用摘要不代表文件内容已加密。

macOS/Linux 要求私有目录 `0700`、文件 `0600`，并核对所有者与文件身份。Windows 使用受保护 DACL，仅允许当前用户 SID 与 SYSTEM；读取前检查所有者、reparse point 和访问规则，不能以 chmod 代替 ACL。升级初始化可在验证归属与文件身份后，收紧应用自有控制目录和登录状态的旧 ACL，保留原状态、nonce 和撤销信息；权限已正确则不重写。凭据 JSON 条目及外部导入文件只验证、不自动修复 ACL。权限无法确认时明确失败，不自动放宽权限。JSON 中包含会话 Token 等秘密，不提交到 Git、放入发布包、粘贴到聊天或写入诊断日志。

正常登录会验证会话，再经同 profile 锁和 compare-and-save 原子保存；CLI 与 MCP 可复用同一条目。并发登录、取消、退出和刷新仍保留账号绑定与撤销检查。`ai-modeling://auth/status` 流程资源只读流程快照，不会因为 JSON 存储而成为实时账号验证。

从 0.1.2 或更早版本升级时，不自动读取、迁移或删除旧钥匙串。若没有 JSON 会话，运行 `setup` 或 `login` 正常登录；先前配置的可选 LLM 密钥也需通过相应配置入口重新设置。Windows 的业务数据默认位置也已调整；已有旧目录时可显式设置 `AI_MODELING_DATA_DIR` 指向原业务目录，以保留任务和设置，认证根仍按上述规则共享。旧任务继续绑定原账号和请求身份，不清理任务库或换 profile 强行恢复。`logout` 只清除当前 profile 的会话并撤销登录流程，不自动清除上传引用、产物链接、独立 LLM 密钥或其它 profile；不要为退出而删除整个认证目录。

```sh
ai-modeling config set default_output_dir /absolute/path/to/assets
ai-modeling config context output_dir=./assets model=tripo-v3.1
ai-modeling config list
```

全局偏好在数据目录的 `settings.json`；目录上下文取最近的 `.ai-modeling/context.json`，可为 `make` 提供默认参数，其相对输出路径基于该上下文所属目录。只读取新名称，不回退旧环境变量或目录；显式选项优先，但已有任务始终沿用冻结意图。

`make`、`generate` 和处理命令的 `--out` 是根目录，结果位于其下的 `ai-modeling-out/...`；`task get/watch --download --out` 指定最终目录。结构化工具的 `destination_path` 若没有 `AI_MODELING_OUTPUT_DIR`，须使用绝对路径。设置了输入/输出根时，文件仍须满足实际路径范围，已有目标不会无条件覆盖。

应用**不会自动加载 `.env`**。[环境模板](../.env.example) 需由 Node 显式加载，选项放在脚本路径之前：

```sh
node --env-file=.env dist/cli/main.js --help
node --env-file=.env dist/cli/main.js mcp --toolset studio
```

已有进程环境优先于文件同名值，文件里的 shell 变量不展开。Studio HTTP 请求支持 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 及对应小写名称；避免设置冲突值，回环排除可使用 `localhost,127.0.0.1,::1`。GUI 客户端可能不继承终端代理，应在 MCP `env` 设置后重启；这些变量不自动配置 Chrome/Edge。登录协调器和显式 CDP 的回环通信不经 Studio HTTP 代理。

## 费用、任务与恢复

提交前检查有效报价；普通任务价格未知或过期时停止。`--max-credits` 是逐步估算门槛，不是整条链或服务端扣费硬上限。Canvas/Lab 可变费用需要显式接受；分割、复制、贴图、UV、导出等组合步骤可能分别收费，账单未匹配不代表免费。

当前价格的维护源是 [`studio/api/reviewed-prices.json`](https://github.com/seekskyworld/ai-modeling/blob/main/studio/api/reviewed-prices.json)，更新方法见[价格快照更新](#价格快照更新)。普通价格过期时应更新经过审核的快照，不修改日期绕过校验。

- 同一意图重用原 `--request-id`；改变参数会触发 `IDEMPOTENCY_CONFLICT`。自动来源首次绑定后，不随新历史漂移。
- `outcome_unknown` 表示回执不明；查询并核对原任务，不创建替代请求。重新登录不会重放已经发送的写操作。
- `task watch` 失败或超时会退出 6，超时不取消远端任务。下载失败保留原付费任务，恢复查询或下载即可。
- `needs_attention` 表示来源、产物或交付证明尚不满足要求；远端成功不能代替正确文件，不通过改阈值或删除证明强行交付。
- 可信缓存恢复只接受已登记且身份、摘要匹配的原件；文件损坏、被替换或来源不符时拒绝。多目录交付不允许覆盖无关文件。

```sh
ai-modeling task get TASK_ID --json
ai-modeling task watch TASK_ID --json
ai-modeling task get TASK_ID --download --out /absolute/path/to/new-output --json
```

将 `TASK_ID` 换成原任务身份。CLI/MCP 应一起升级；旧程序可能拒绝新任务库，降级使用对应版本的备份，不修改数据库版本号。

## 可选本地程序与网页引擎

普通网页生成、查询和常规下载不要求 Blender/FFmpeg。部分本地转换、轴心/底部处理和渲染需要 **Blender 4.5+**；视频另需包含 **libx264** 的 FFmpeg。程序可由环境变量或支持的 `--blender` / `--ffmpeg` 选项指定，不承诺本地渲染与网页逐像素相同。

受限前端 GLB 导出使用固定版本的网页 Assimp JS/WASM，文件不随包分发。先查看当前程序要求的官方 URL、文件名、大小和 SHA-256，再将取得的两份原文件放到自选目录：

```sh
ai-modeling runtime status --json
ai-modeling runtime status --source-dir /path/to/studio-runtime --json
ai-modeling runtime install --source-dir /path/to/studio-runtime --json
```

这些入口不读取账号、创建任务库或提交导出；安装只读取本地文件并校验后发布缓存，`ready:true` 仅代表引擎就绪。`studio frontend-export --runtime-dir DIR` 也可直接使用指定目录。来源受 `AI_MODELING_INPUT_ROOTS` 限制，缓存位于数据目录下；损坏的现有缓存不自动覆盖。

官方文件 HTTP 下载可能返回 403，可通过正常浏览器取得相同固定文件后导入。浏览器能下载不代表 CLI 自动下载可用；不要把错误页改名、放宽摘要或替换任意引擎版本。转换、网页 `export-lite` 授权与最终交付是独立阶段，费用和支持条件见[兼容说明](compatibility.md)。

## 价格快照更新

`ai-modeling pricing status` 离线显示当前快照来源、审核时间、到期时间与刷新需求。维护源是 [`studio/api/reviewed-prices.json`](https://github.com/seekskyworld/ai-modeling/blob/main/studio/api/reviewed-prices.json)，[main 的原始 JSON](https://raw.githubusercontent.com/seekskyworld/ai-modeling/main/studio/api/reviewed-prices.json)用于查找最新审核版本。程序不会自动读取 main、信任新价格或延长有效期。

更新时从对应 [Release](https://github.com/seekskyworld/ai-modeling/releases) 的 **Reviewed pricing snapshot** 说明直接复制更新命令。该说明提供固定来源提交的 JSON URL、**Source JSON SHA-256**、`Reviewed at` 和 `Expires at`。摘要针对该来源文件的原始字节；不要使用运行包 TGZ 的摘要，也不要使用 `pricing status` / `readiness.json` 中的 `canonical_sha256`，后者针对解析后的 JSON，不能用于 `--sha256`。

手动填写时，把下例的 `REVIEWED_COMMIT` 和 `PUBLISHED_SHA256` 替换为该次发布的来源提交与原文件摘要；固定提交确保地址内容不会随 main 变化：

```sh
ai-modeling pricing update \
  "https://raw.githubusercontent.com/seekskyworld/ai-modeling/REVIEWED_COMMIT/studio/api/reviewed-prices.json" \
  --sha256 PUBLISHED_SHA256
ai-modeling pricing status
```

也可以下载已审阅 JSON，再执行 `pricing verify FILE --sha256 SHA256 --network` 与 `pricing import FILE --sha256 SHA256 --network`。文件摘要须与维护者发布的值核对，不能把刚下载文件的自行计算值当成独立信任依据。远程更新仅接受直接 HTTPS、不跟随重定向，并核验官方证据摘要；本地导入采用原子写入，不登录账号或生成素材。历史 Release 保留原审核和到期时间；过期快照仍会被拒绝，应取得更新的审阅版本，不能只修改期限。MCP 用户保持原工具入口，由运行环境维护者完成需要的价格更新，不改用 shell 执行业务。

`sha256` 是原文件字节摘要，`canonical_sha256` 是规范化内容摘要，两者不能混用。证据字节匹配不代替公式审核；过期、未来日期、摘要不符或证据不可读取时保留错误，不能自行只改日期来解锁提交。已有任务的查询和恢复沿用原任务，不因此重新生成。

## 常见问题

先检查 `node --version`、`ai-modeling --version`、`ai-modeling --help` 和离线 dry-run。`ai-modeling doctor --offline --json` 只检查本机条件，不读凭据、不联网、不创建运行状态。默认 `doctor --json` 还会读取凭据并联网验证会话；它不自动开始登录。用 `--feature core|render|video|frontend-export` 只将所选功能的依赖设为必要项；普通生成不因缺少 Blender/FFmpeg 而被误判不可用。

| 现象或错误 | 下一步 |
| --- | --- |
| MCP 找不到命令、缺少依赖或 `dist` | 先确认配置选择 npm/npx、全局命令还是源码入口；检查 Node 24+、版本与客户端 PATH。归档安装要保留运行目录及依赖；源码入口必须先构建。`command` 只放可执行文件，参数放 `args`。 |
| Skill 已导入但无法执行 | Skill 只提供操作说明；另装运行包，确认客户端允许调用 `ai-modeling`，并按原 profile 完成登录。 |
| `CREDENTIAL_STORE_UNAVAILABLE` / `AUTH_DIRECTORY_INVALID` | 检查 OS 用户认证目录与 JSON 条目的所有者、私有权限、文件类型和沙箱访问；Windows 另核系统 PowerShell 与 ACL。不要上传文件内容、放宽为所有人可读或换 profile 绕过。存储错误不等于网页登录失效；修复权限后沿原请求恢复，写结果未知时先核对。 |
| `BROWSER_NOT_FOUND` / `BROWSER_LOGIN_FAILED` | 核对 Chrome/Edge 绝对路径、可执行权限、可见桌面和浏览器自身网络；可使用上文备用导入。 |
| `AUTH_REQUIRED` / `LOGIN_BROKER_UNAVAILABLE` | 在原 profile 完成或重新开始登录，再继续原业务请求；`ACCOUNT_MISMATCH` 要先恢复正确账号。 |
| `AUTH_DIRECTORY_INVALID` / `LOGIN_STATE_INVALID` | 核对 `.ai-modeling-auth` 的所有者、私有权限与文件身份，不通过删其它活跃状态绕开检查。 |
| `NETWORK_ERROR` / `UPSTREAM_ERROR` / HTTP 403 | 检查代理、权限与服务；保留 `certainty` 和原回执，未知写入不重发，403 不等同于会话过期。 |
| `PRICE_UNKNOWN` / `ESTIMATE_EXCEEDS_BUDGET` / 额度不足 | 核对完整步骤、有效报价和 Studio 网页积分；未知不是免费，预算调整需明确选择。 |
| `OUTPUT_EXISTS` / 路径拒绝 | 使用新的空目标或已登记原位置，核对输入白名单、输出根和绝对路径，不覆盖陌生文件。 |
| `BATCH_CHANGED` / `BATCH_IN_USE` / `BATCH_LOCK_LOST` | 保留清单和状态，核对原任务与持锁进程；锁过期不证明远端未执行，`--fresh` 不是恢复。 |
| `LOCAL_DEPENDENCY_MISSING` / `LOCAL_MODEL_FAILED` / `LOCAL_VIDEO_FAILED` | 检查 Blender 4.5+、FFmpeg/libx264 及受支持输入；处理失败不一定是缺少程序，修复后恢复原导出。 |
| 不支持的参数或 `needs_attention` | 依据[兼容与限制](compatibility.md)检查实际操作和产物，不能仅凭命令存在认定效果已支持。 |

报告问题时提供版本、命令模板、错误码及是否已有回执；移除 Cookie、Token、签名 URL、账号余额、私人路径和任务库内容。开发验证与问题报告入口见[开发指南](development.md)。
