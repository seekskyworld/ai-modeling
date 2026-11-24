# ai-modeling 示例

这些示例使用 `@seekskyworld/ai-modeling` 包提供的命令 `ai-modeling`；源码运行时可替换为 `node dist/cli/main.js`。路径、profile 和提示词由调用方选择。以下预览命令均包含 `--dry-run`，不会自动提交生成。

## 单任务预览

在已安装命令的环境中运行：

```sh
ai-modeling make "A small toy robot with simple rounded shapes" --model tripo-v3.1 \
  -p texture=false -p pbr=false --dry-run --json
```

这只验证离线计划，不获取实时价格；返回 `estimated_credits: null` 不等于免费。实际生成需要主动移除 `--dry-run`、完成登录并接受网页费用。更多起步步骤见[安装指南](../docs/usage.md)。

## 批处理清单

[batch.yaml](batch.yaml) 使用真实批处理 schema：顶层为 `concurrency`、`defaults` 和 `jobs`，每项按 `make` 规划。当前批处理没有 `--dry-run`，可先用与两项内容对应的命令预览：

```sh
ai-modeling make "A small toy robot with simple rounded shapes" --model tripo-v3.1 \
  -p texture=false -p pbr=false --name robot-blockout --dry-run --json
ai-modeling make "A compact wooden chair with four legs" --model tripo-v3.1 \
  -p texture=false -p pbr=false --name chair-blockout --dry-run --json
```

| 字段               | 格式                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `concurrency`      | 整数 1–4，省略时为 2；服务和账号仍有自身并发限制                                               |
| `defaults`         | 所有任务共用的 `input`、`inputs`、`name`、`for`、`then`、`model`、`params`、`out` 中的可选字段 |
| `jobs`             | 1–500 项；每项仅使用上列任务字段                                                               |
| `input` / `inputs` | 一个文本/文件/引用，或 1–4 个有序输入；不要同时提供两种写法                                    |
| `name`             | 可选的唯一名称，1–100 个字母、数字、`_`、`.` 或 `-`；省略时为 `job-序号`                       |
| `params`           | 参数对象；布尔值和数值按 YAML 类型填写，不用 `param` 或 `parameters` 代替                      |

任务级字段覆盖 `defaults`，`params` 按键合并。`version`、`command` 和 `dry_run` 不是这个清单的字段。相对素材路径按运行命令的工作目录解析；示例只有提示词，不依赖素材文件。

真正的执行入口为 `ai-modeling batch run examples/batch.yaml`，会开始网页任务并可能扣费，本文不自动执行它。执行前自行选择 profile、输出位置和 `--max-credits`；该上限限制每步估算，不是整批的服务端硬预算。

同一清单旁的 `batch.yaml.state.json` 保存运行身份。重跑时保留它，才能恢复原请求；修改清单、删除状态或使用 `--fresh` 不能作为未知任务的恢复方法。详见[批处理排错](../docs/usage.md#使用-cli)。

## MCP 配置

| 使用方式 | 示例 |
| --- | --- |
| 通过 npm 按固定版本启动 | [mcp-npx.json](mcp-npx.json)：`npx --yes --package @seekskyworld/ai-modeling@0.1.7 ai-modeling mcp`，无需全局安装；首次启动需要下载依赖。 |
| Windows 宿主不能直接启动 npm `.cmd` 脚本 | [mcp-npx-windows.json](mcp-npx-windows.json)：使用 `cmd.exe /d /c npx.cmd`；能解析 `.cmd` 的宿主可保留通用示例。 |
| Claude Code、Cursor、当前 VS Code/Copilot | [mcp-installed.json](mcp-installed.json)：`mcpServers` 格式，使用 PATH 中的 `ai-modeling`，与导出的 `mcp.json` 用法一致。 |
| Codex | [mcp-codex.toml](mcp-codex.toml)：原生 `mcp_servers` TOML，合并到客户端配置。 |
| OpenCode | [mcp-opencode.json](mcp-opencode.json)：原生 `mcp.servers`、`type: local`、命令数组及 `environment`。 |
| Golutra Agent | 运行 `ai-modeling mcp export --target golutra-agent --out NEW_DIR` 准备原生插件；0.3.9 过滤 MCP 工具，注册成功仍不可调用。当前可用 Skill/CLI，见 [Golutra Agent 接入](../docs/usage.md#golutra-agent)。 |
| VS Code 的旧 Local harness | [mcp-vscode.json](mcp-vscode.json)：`servers` 格式，用于 `.vscode/mcp.json`；Local 已弃用，官方计划于 2027 年 2 月移除，新 Copilot 使用上面的 `mcpServers`。 |
| 从源码运行 | [mcp.json](mcp.json)：使用本机 Node 和已构建的 `dist/cli/main.js`，通过 `mcp` 子命令启动，需替换占位路径。 |

先按[运行包安装步骤](../docs/usage.md#安装运行包)运行 `npm install --global @seekskyworld/ai-modeling@0.1.7`，或直接使用 npx 配置。Node.js 24+ 与 npm 必须能被客户端找到；GUI 不继承终端 PATH 时使用对应可执行文件的绝对路径。Windows 还可将 `node.exe` 与已安装包 `dist/cli/main.js` 的实际路径分开放入 command/args，避开 `.cmd` 启动差异；详见 [Windows 启动方式](../docs/usage.md#windows-启动方式)。这些示例不构成 Windows 实机验证。归档安装和源码构建是独立替代路径，不混用它们的 `command` / `args`。

源码示例使用前替换：

1. `command` 中的 `/absolute/path/to/node`：本机 Node 24+ 的可执行文件。
2. `args` 中的 `/absolute/path/to/ai-modeling/dist/cli/main.js`：自己构建的 CLI 入口，后面的 `mcp` 参数保留；扩展集再追加 `--toolset studio`。
3. `AI_MODELING_PROFILE`：若 CLI 未使用 `default`，改为实际选择；自定义数据目录时另加相同的 `AI_MODELING_DATA_DIR`。

JSON 不支持注释，也不会自动展开 `~`、`$HOME` 或 shell 命令。不要直接复制占位路径后运行。其它客户端应按其原生格式设置相同的可执行文件、参数与环境变量，见[配置指南](../docs/usage.md#使用-mcp)。

起步示例都选择6工具 `default` 集和 `default` profile；独立生图默认 GPT Image 2.5。需要完整资产和编辑入口时，在 args 末尾追加 `--toolset studio` 并重启。CLI 使用其它 profile 时同步设置。配置后先验证工具列表和 `ai-modeling://guides/usage` 可读，语法检查不能替代真实客户端连接。

首次账号操作缺少会话时，工具会返回 `AUTH_REQUIRED`、登录 URL 和 `login_id`；用户在浏览器登录，Agent 读取 `ai-modeling://auth/status`，确认同一 `login_id` 的流程 `authenticated: true` 后使用原请求身份继续。该资源不重新验证当前凭据或远端会话，按接续工具的实际结果处理。会话由 CLI 保存在同 OS 用户/profile 共用的私有 JSON 文件中，不填入 MCP 配置，也不随项目数据目录改变。Agent 全程沿用 MCP。业务操作通过同包 CLI 完成；查看工具或任务本身不会授权新的收费生成。

Gemini CLI 使用 `~/.gemini/settings.json` 或项目 `.gemini/settings.json` 中的 `mcpServers`，复制已安装示例的 `command`、`args` 和 `env`，按其官方示例省略 `type`。客户端配置结构和默认目录会随版本变化，核对 [Claude Code](https://code.claude.com/docs/en/mcp)、[Cursor](https://cursor.com/docs/mcp)、[VS Code/Copilot](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)、[Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Gemini CLI](https://geminicli.com/docs/cli/tutorials/mcp-setup/) 和 [OpenCode](https://opencode.ai/docs/mcp-servers/) 的当前说明。配置语法与 MCP 协议检查不代表每种客户端都已现场连接；重启或重新加载后，在客户端中查看 `ai_modeling_*` 工具与指南资源。

## Skill 与分发产物

Skill 的源码为 [skills/ai-modeling/SKILL.md](../skills/ai-modeling/SKILL.md)。取得 `ai-modeling-skill-VERSION.zip` 后，按客户端支持的方式导入整个 Skill 文件夹；它提供操作说明和[可组合流水线示例](../skills/ai-modeling/references/pipelines.md)，指导所选入口，不代替运行包。选择 MCP 时，Agent 只调用 MCP 工具，由 MCP 内部执行 CLI。详细安装和源码导出步骤见[使用指南](../docs/usage.md#安装-skill)。

已有运行包时先执行 `ai-modeling skill targets`，显式选择 `--target`；项目安装加 `--scope project --project-dir /path/to/project`。其它客户端可用 `--dir /path/to/skills`。安装器只管理 Skill 文件，不修改客户端配置或默认批准工具执行；安装后仍须由客户端发现该 Skill。`agents/openai.yaml` 是可选的 OpenAI 界面元数据，不是 Skill 的运行依赖。

在安装源码依赖后运行 `npm run export -- --out DIR` 可生成 Skill ZIP、运行包 TGZ、`mcp.json`、`INSTALL.md`、`manifest.json` 和 `SHA256SUMS`。`DIR` 必须位于源码仓库之外，父目录已存在且目标目录不存在；位置检查解析软链接，拒绝指回仓库内的路径。`export:skill` / `export:mcp` 可只导出对应入口，并遵循同一目录要求。公开下载见 [npm](https://www.npmjs.com/package/@seekskyworld/ai-modeling) 与 [GitHub Releases](https://github.com/seekskyworld/ai-modeling/releases)；本地导出本身不执行发布。

## 环境文件

[.env.example](../.env.example) 只提供无凭据配置。应用不会自动读取 `.env`；需要环境文件时，用 Node 的 `--env-file` 显式加载，或把非敏感配置写入 MCP 的 `env`。具体优先级与路径规则见[环境配置](../docs/usage.md)。
