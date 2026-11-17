---
name: ai-modeling
description: 通过 ai-modeling CLI 按需发现能力，完成 Tripo Studio 资产操作并组合可恢复的流水线。适用于用户选择 ai-modeling 时；已选择 MCP 的任务沿用 MCP 资源与工具，不替换其它产品或官方 API 流程。
license: Apache-2.0
---

# ai-modeling

CLI 是基础执行接口。Skills 提供使用说明、示例和流程指导；MCP 提供同源指导资源与工具适配，调用链为 `Agent → MCP → CLI → Studio`。根据用户目标组合现有操作，不增加业务引擎或固定生成流水线。

## 选择入口

本 Skill 只有一套，通过按需读取参考资料覆盖 CLI 能力，不分轻量版和扩展版。默认使用已安装的 `ai-modeling` CLI，通过当前命令帮助和离线指南按需获取信息。这通常比预先加载整套 MCP 工具 schema 占用更少上下文，不需要常驻完整手册。

用户已选择 MCP 时，保持 MCP 入口：只调用该客户端的资源和工具，由 MCP 内部执行 CLI；不擅自改用 shell、重配客户端或更换账号。先读取相关工具定义，不假设 CLI 参数与工具 JSON 字段完全相同。

运行包为 npm 的 `@seekskyworld/ai-modeling`，命令为 `ai-modeling`；也可使用同版本 Release 归档。需要 Node.js 24+。Skill 本身不包含程序或会话；安装条件缺失时，按用户已有授权处理，不能用另一提供方补结果。仅使用新命名 `AI_MODELING_*`、`ai_modeling_*` 和 `ai-modeling://`。

## 按需读取

只读取当前任务需要的内容，不一次加载所有参考：

| 需要 | CLI / 本地参考 | MCP 入口 |
| --- | --- | --- |
| 查找操作与参数 | `ai-modeling <command> --help`；`guides read commands/index` 后按需读 `commands/model/convert` 等分片 | 相关 `ai_modeling_*` schema；`ai-modeling://guides/commands/index` 与相应命令分片 |
| 安装、登录、费用、任务恢复 | [使用与恢复](references/usage.md)，或 `ai-modeling guides read usage` | `ai-modeling://guides/usage` 与对应登录/任务工具 |
| 连接多个步骤、补交付、批处理 | [可组合流水线](references/pipelines.md)，或 `ai-modeling guides read pipelines` | `ai-modeling://guides/pipelines`，再调用各步骤工具 |

`ai-modeling guides list/templates` 列出离线 JSON 指南与模板；`guides read` 按主题读取共用内容。MCP 通过 `ai-modeling://guides/commands/{+command}` 读取具体命令，不为指南启动 shell CLI。只有分片帮助无法解答时，才读取完整命令参考。

## 始终保留的边界

- 沿用用户指定的输入、输出、账号与预算。已授权范围内继续推进；示例不授予额外生成、发布、分享或删除权限。
- 新写意图固定请求身份；恢复沿用原账号、来源和回执。`request_id` 不等于任务 ID，未知提交先核对，不能自动重提。
- CLI `--dry-run` 只做离线规划，未知报价不等于免费。`batch run` 没有 `--dry-run`；估算门槛不是服务端硬预算。
- 密码、验证码和双重验证由用户完成；不读取普通浏览器会话或索取 Token。MCP 登录通过工具和 `ai-modeling://auth/status` 接续，须核对原 `login_id`；流程快照不证明当前会话可用。
- 选择需要的步骤即可，已有输入直接进入相应操作。前一步失败或结果未知时停止依赖步骤；下载失败恢复原任务，不重新付费生成。

交付实际文件位置、任务状态和已确认的限制。能力缺失时明确报告，不静默换钱包、模型提供方或调用入口。
