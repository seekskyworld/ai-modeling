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
| Canvas Agent 聊天后检查画布与产物 | [画布交付验收](references/pipelines.md#canvas-agent-交付验收)，再按需读 `commands/canvas/audit` | `ai-modeling://guides/pipelines`、`ai_modeling_canvas_audit` 与产物工具 |

`ai-modeling guides list/templates` 列出离线 JSON 指南与模板；`guides read` 按主题读取共用内容。MCP 通过 `ai-modeling://guides/commands/{+command}` 读取具体命令，不为指南启动 shell CLI。只有分片帮助无法解答时，才读取完整命令参考。

## 始终保留的边界

- 沿用用户指定的输入、输出、账号与预算。已授权范围内继续推进；示例不授予额外生成、发布、分享或删除权限。
- 新写意图固定请求身份；恢复沿用原账号、来源和回执。`request_id` 不等于任务 ID，未知提交先核对，不能自动重提。
- CLI `--dry-run` 只做离线规划，未知报价不等于免费。`batch run` 没有 `--dry-run`；估算门槛不是服务端硬预算。
- 密码、验证码和双重验证由用户完成；CLI 将会话保存到同 OS 用户/profile 共用的私有 JSON，不依赖钥匙串。不要索取 Token、读取普通浏览器目录或将凭据文件内容带入输出。MCP 登录通过工具和 `ai-modeling://auth/status` 接续，须核对原 `login_id`；流程快照不证明当前会话可用。
- 选择需要的步骤即可，已有输入直接进入相应操作。前一步失败或结果未知时停止依赖步骤；下载失败恢复原任务，不重新付费生成。
- Canvas Agent 回复结束后，交付前通过 `canvas audit` 回读准确画布、会话和回合，核对所需节点与资产；再下载准确原件。图片/模型用 `studio artifact-inspect` 检查并审阅外观；HolyMolly 用 `expect.kind:"html"` 核候选身份，再独立验原件、依赖与玩法，不能送进图片/模型检查器。MCP 使用对应工具。聊天终态、资产可读、用户目标与费用结算分别报告；节点账单不自动归属本次聊天。
- 编辑画布先查实时 `canvas tools` 的 `cli_support`（MCP 对应 `ai_modeling_canvas_tools`），再读取准确图。`graph-edit` 可直接接收读回 JSON，使用身份/版本守卫和 `patch_params` 做局部修改，保存与运行分开。HolyMolly 用显式 `capabilities:["holy_molly"]` 的 Agent 请求、素材 refs 和可选游戏目标 node_id；不是普通 `canvas-run`。目录或协议映射不表示游戏效果已验，详细流程按需加载下方参考资料。
- Holy 空正文须有显式能力、准确已保存 Holy 目标且无普通附件；网页历史 retry 的原目标未知时保持阻塞，不覆盖猜补。节点 stop/retry 与历史消息重试分开：沿准确 revision/run 的持久 job 执行，预检非原子，未知写不重提；stop 不清零原账单，retry 需可变费用授权。节点操作从 0.1.5 提供；Holy Stop 和合资格原生 Retry 的真实验收仍未完成，边界和完整参数按需读取[画布交付验收](references/pipelines.md#canvas-agent-交付验收)。

交付实际文件位置、任务状态和已确认的限制。能力缺失时明确报告，不静默换钱包、模型提供方或调用入口。
