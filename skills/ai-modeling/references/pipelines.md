# 可组合流水线

这些示例展示 Skill 如何组织底层 CLI 能力，不是默认执行计划。CLI 模式使用下列命令；用户选择 MCP 时，只通过 MCP 资源和工具执行同一计划，由 MCP 内部调用 CLI，不擅自改成 shell。按目标选步骤并保留已有素材；登录、费用和恢复细节按需查[使用与恢复](usage.md)。

## 参考图到模型

如果用户已经提供参考图，从模型步骤开始。只有用户也要生成参考图时，才使用图片生成；新增步骤可能另行收费。下面的提示、文件路径和请求标识均由当前任务替换。

先按真实输入规划。`--dry-run` 不提交任务或取得实时价格：

```sh
ai-modeling generate text-to-image "USER_CONCEPT" --model chat_image_2.5_sunburst --dry-run --json
ai-modeling generate image-to-model /absolute/path/to/reference.png --model tripo-v3.1 --dry-run --json
```

参考图尚未取得时，第二条等文件可用后再运行。用户已授权图片生成时，可执行第一步并记录 JSON 返回的实际任务身份：

```sh
ai-modeling generate text-to-image "USER_CONCEPT" --model chat_image_2.5_sunburst \
  --request-id IMAGE_REQUEST_ID --no-download --json
ai-modeling task get IMAGE_TASK_ID --download --out /absolute/path/to/image-output --json
```

用返回的实际图片路径替换 `reference.png`。检查图片是否符合当前输入要求，再按已授权范围创建模型：

```sh
ai-modeling generate image-to-model /absolute/path/to/reference.png --model tripo-v3.1 \
  --request-id MODEL_REQUEST_ID --no-download --json
ai-modeling task watch MODEL_TASK_ID --download --out /absolute/path/to/model-output --json
```

`IMAGE_TASK_ID` / `MODEL_TASK_ID` 来自对应步骤返回的本地任务身份，不是请求 ID，也不靠命名后缀猜测。每个新意图选择各自稳定的请求 ID，重试沿用原值。输入尚未通过核验、前一步结果未知或费用授权不足时，不启动依赖步骤。

贴图、减面、绑定和导出是可选后续操作。用当前版本的 `model/mesh/anim` 帮助确定接口，按确切来源选择必要步骤，不因模型生成成功就自动全部执行。

## 已有任务补交付

用户只要查询、等待或补下载时，复用原任务即可，不运行生成前置条件，不以当前报价阻止读取已完成的原结果：

```sh
ai-modeling task get TASK_ID --json
ai-modeling task watch TASK_ID --json
ai-modeling task get TASK_ID --download --out /absolute/path/to/new-output --json
```

按状态选择上述操作，不机械地全部执行。`task watch` 超时不取消远端任务；下载或输出冲突应保留原付费结果，修复交付条件后从同一任务继续。没有唯一任务或可靠回执的未知提交，应停止依赖步骤并报告，不能重新生成来补结果。

## 独立候选批处理

`batch run` 适合独立的候选任务，不表达“先生成图片、再把其结果自动送给下一项”的依赖图。当前没有批处理 `--dry-run`；先用各项等价的 `make --dry-run --json` 规划。

清单可按用户需求填写：

```yaml
concurrency: 2
defaults:
  model: tripo-v3.1
jobs:
  - name: candidate-a
    input: USER_CONCEPT_A
  - name: candidate-b
    input: USER_CONCEPT_B
```

授权范围覆盖这些生成任务后，才运行 `ai-modeling batch run /absolute/path/to/batch.yaml`。保留清单及其 `.state.json`；恢复时不改清单，不使用 `--fresh` 绕过未知状态。单项失败不表示其它项没有提交，逐项核对回执后再选择后续操作。

## 使用 MCP 执行同一计划

MCP 提供同源的 `ai-modeling://guides/usage`、`ai-modeling://guides/commands` 和 `ai-modeling://guides/pipelines`。按需读取相关主题，保留上述步骤选择和身份记录，通过当前客户端的 `ai_modeling_*` 工具执行。先读取相关工具 schema，不根据 CLI 参数名称拼猜 JSON 字段，也不调用 shell 代替 MCP。登录状态通过 `ai-modeling://auth/status` 获取；需要用户交互时返回登录入口，完成后继续原任务。

默认6工具集可以完成“图片 → 模型”：先用 `ai_modeling_image_generate`，其图片参数位于 `parameters`，并提供当前意图的 `request_id` 和已授权 `max_estimated_credits`；使用返回的真实任务身份调用 `ai_modeling_task_wait`，取得下载的实际图片路径。确认图片后，把该路径传入 `ai_modeling_make.input`，为模型步骤选择独立请求身份，再通过返回的任务身份等待/下载。`ai_modeling_image_generate` 默认 GPT Image 2.5；不要把 CLI 的 `--model` 字段名直接套入原生工具 schema。

首次缺会话时，把工具返回的登录 URL 交给用户，读取 `ai-modeling://auth/status` 确认认证后继续原请求。图片或模型需要较长时间时保留原任务，通过 `ai_modeling_task_get` / `ai_modeling_task_wait` 查询；客户端超时不意味着需要再生成。此流程是用户同时要求图片和模型时的示例，已有图片直接使用模型步骤。

CLI 执行所选操作，MCP 提供指导资源并代理工具调用；是否需要下一步、如何连接产物和何时停止由 Skill 根据用户目标指导。已经授权的范围内继续推进；新增收费意图、发布或删除不从示例中自动取得授权。
