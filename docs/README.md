# 文档导航

首次使用从[英文首页](../README.md)或[中文项目说明](../README.zh-CN.md)开始。统一运行包为 `@seekskyworld/ai-modeling`，命令为 `ai-modeling`：CLI 执行功能，MCP 内部调用 CLI，Skill 提供所选入口的指导。独立 Skill ZIP 仍需安装运行包。

English readers can start with the [English quick tutorial](usage.md#quick-start-in-english), [bilingual capability status](compatibility.md#能力状态--capability-status), and [maintainer workflow](development.md#maintainer-workflow-in-english).

| 文档 | 内容 |
| --- | --- |
| [使用指南](usage.md) | 安装与客户端配置、登录、Canvas 编辑和验收、配置、恢复与排障 |
| [命令参考](commands.md) | 由命令树生成的参数、选项与结构化工具入口 |
| [兼容与限制](compatibility.md) | 官方 CLI 与网页功能对照、支持条件、未完成项和版本适用范围 |
| [开发指南](development.md) | CLI/MCP/Studio 架构、验证、导出和发布维护 |

MCP 客户端配置、批处理和 Skill 导入集中在[示例目录](../examples/README.md)。本组文档对应 0.1.10，具体版本的变更见 [CHANGELOG](../CHANGELOG.md)。旧 0.1.4 包不包含本次新增的 Canvas 验收与历史入口；后续标记为 Unreleased 的能力仍不能假定已包含在 npm 包中。

CLI 使用 `ai-modeling docs` 读取使用指南，或以 `--topic commands`、`--topic compatibility`、`--topic development` 选择文档；`commands/*`、`examples/*` 和 `common-errors` 支持按主题查找。

Agent 可用 `ai-modeling guides list/templates/read` 获取离线 JSON 指南，从 `commands/index` 进入具体命令分片。MCP 使用 `ai-modeling://guides/commands/index`、`ai-modeling://guides/commands/{+command}` 和同源 usage/commands/pipelines 资源；已选择 MCP 时沿用 MCP 入口。

参与项目请读 [CONTRIBUTING](../CONTRIBUTING.md)、[SUPPORT](../SUPPORT.md)、[SECURITY](../SECURITY.md) 与 [LICENSE](../LICENSE)。
