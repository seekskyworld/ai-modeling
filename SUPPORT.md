# 支持与问题报告

ai-modeling 是独立维护的社区项目，与 Tripo 官方无隶属关系。这里处理项目的安装、命令、MCP 接入、网页映射和本地处理问题；账号封禁、订阅、支付、额度争议及官方服务可用性，需要通过 Tripo 网站提供的帮助入口处理。

## Support in English

Use [GitHub Issues](https://github.com/seekskyworld/ai-modeling/issues) for installation, CLI/MCP, mapping and local-processing problems. Search existing reports, then include the project version, OS, Node/npm versions, a minimal synthetic example and redacted error codes. Start with `ai-modeling doctor --offline --json`; use `--feature render|video|frontend-export` for optional features. Do not include credentials, account/task identifiers, signed links or personal paths.

Security reports must follow [SECURITY.md](SECURITY.md) through the [private vulnerability form](https://github.com/seekskyworld/ai-modeling/security/advisories/new). Subscription, billing, account restrictions and upstream availability belong to Tripo's own support channels.

## 先查对应指南

| 需求 | 入口 |
| --- | --- |
| 安装、登录、CLI 或 MCP 配置 | [README](README.md)、[登录指南](docs/usage.md) |
| 命令与参数 | [命令目录](docs/commands.md)、[CLI 兼容合同](docs/compatibility.md) |
| 某功能是否支持或与官方不同 | [兼容与限制](docs/compatibility.md) |
| 运行时、导出或可选依赖 | [运行时指南](docs/usage.md)、[前端导出](docs/compatibility.md) |
| 测试、修复和贡献 | [验证说明](docs/development.md)、[贡献指南](CONTRIBUTING.md) |
| 安全问题 | [安全说明](SECURITY.md)，使用私密渠道 |
| 社区行为问题 | [行为准则](CODE_OF_CONDUCT.md)，使用私密渠道 |

Node.js 24+ 是运行要求；部分功能另需系统凭据库、Chrome/Edge、Blender 或 FFmpeg。不同系统、浏览器和上游权限的完整组合未全部验证。以具体功能指南的条件为准，不把可启动程序等同于每种处理都可用。

## 如何提问或报告

在 [GitHub Issues](https://github.com/seekskyworld/ai-modeling/issues) 中先搜索已有问题。可复现错误使用 Bug 表单，新增能力使用功能请求表单。使用问题可以新建空白 Issue，并在标题注明“使用问题”。仓库未提供讨论区或其它联系方式时，不假定它们已经可用。

报告通常需要以下信息：

- 项目版本或提交、安装方式、操作系统、Node.js/npm 版本；MCP 问题另写客户端与工具集。
- 最小命令或工具输入、输入文件的结构特征，以及预期和实际结果。尽量使用可公开的合成样本。
- 脱敏错误码和输出，是否能稳定复现，以及已经尝试过的安全排查。
- 若涉及兼容，注明官方 CLI 版本和命令；若涉及网页，说明对应菜单、前置条件及是否已比较同一来源的结果。

以下命令只读取版本，可用于确认正在运行的程序；从源码运行时可使用 README 中的对应入口：

```sh
node --version
npm --version
ai-modeling --version
```

本项目唯一可执行名称是 `ai-modeling`；多版本安装时核对它的安装位置。需要本机诊断时用 `ai-modeling doctor --offline --json`，按功能选择 `--feature`。公开报告中不要粘贴个人绝对路径、Cookie、Token、Authorization、签名 URL、真实账号/任务标识或完整任务数据库。MCP 配置只保留与问题相关的非秘密字段。

运行包下载见 [npm](https://www.npmjs.com/package/@seekskyworld/ai-modeling) 和 [GitHub Releases](https://github.com/seekskyworld/ai-modeling/releases)。安全问题使用[私密漏洞报告](https://github.com/seekskyworld/ai-modeling/security/advisories/new)，不附到公开 Issue。

## 结果不明或产物未通过

遇到 `outcome_unknown`，保留原请求，不用 `--fresh`、新 request ID 或反复点击补做。可靠的服务回执才能确认原提交；公开 Issue 只需提供状态和脱敏流程，不必发布真实任务标识。

遇到 `needs_attention`，说明产物哪项要求未通过。远端任务成功不代表图片尺寸、透明度、几何、材料或动画已经符合请求，也不保证 AI 严格理解任意提示词。不要为填写报告而重新执行收费操作。

## 支持范围

维护者可以协助分析项目问题和完善文档，但不承诺固定回复时间、特定功能交付时间或历史版本维护周期。未验证的效果会继续保留为未验证，不因一个成功样本变为全面支持。

官方 CLI 合同和网页行为可能变化。本项目使用 Studio 网页会话与积分，不提供官方 API 钱包额度互通保证，也不保证所有官方参数或全站条件分支已经等价。当前边界以[兼容清单](docs/compatibility.md)为准。
