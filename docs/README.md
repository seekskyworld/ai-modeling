# 文档导航

首次使用请先读[中文项目说明](../README.zh-CN.md)或[英文首页](../README.md)。CLI 是底层执行接口，Agent 可通过 MCP 工具调用它；Skills 提供所选入口的说明、示例和流程指导。三者统一使用 `@seekskyworld/ai-modeling` 运行包，命令为 `ai-modeling`，Skill ZIP 仍需单独安装运行包。

English readers can start with the [English quick tutorial](usage.md#quick-start-in-english), [bilingual capability status](compatibility.md#能力状态--capability-status), and [maintainer workflow](development.md#maintainer-workflow-in-english).

| 文档 | 内容 |
| --- | --- |
| [使用指南](usage.md) | Skill/MCP 产物安装、跨平台私有 JSON 会话、登录、CLI 使用、任务恢复与排障 |
| [命令参考](commands.md) | 命令、参数、选项和结构化工具入口 |
| [兼容与限制](compatibility.md) | 官方 CLI 映射、网页功能范围、受限条件与未完成项 |
| [开发指南](development.md) | 三层架构、测试、统一导出、包检查与分发维护 |

通过 npm 按固定版本启动的 MCP 配置见[npx 示例](../examples/mcp-npx.json)；已安装运行包的 MCP 配置见[安装包示例](../examples/mcp-installed.json)，本地开发保留[源码入口示例](../examples/mcp.json)；更多使用方式见[示例目录](../examples/README.md)。贡献、支持、安全和许可见 [CONTRIBUTING](../CONTRIBUTING.md)、[SUPPORT](../SUPPORT.md)、[SECURITY](../SECURITY.md) 与 [LICENSE](../LICENSE)。

命令行中使用 `ai-modeling docs` 打开使用指南，或使用 `ai-modeling docs --topic commands`、`--topic compatibility`、`--topic development`。旧主题 `agent-guide`、`cli-compatibility`、`web-coverage`、`design`、`verification` 仍映射到合并后的文档；动态主题 `commands/*`、`examples/*` 和 `common-errors` 保持可用。

Agent 可用 `ai-modeling guides list/templates/read` 按需获取离线 JSON 指南；先读 `commands/index`，再读 `commands/model/convert` 等命令分片。MCP 对应资源为 `ai-modeling://guides/commands/index` 与 `ai-modeling://guides/commands/{+command}`，仍保留同源 usage/commands/pipelines 指导。Skill 默认按需调用 CLI，已选择 MCP 时沿用 MCP 入口。
