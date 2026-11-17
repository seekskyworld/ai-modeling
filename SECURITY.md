# 安全说明

ai-modeling 会代表用户访问 Tripo Studio 账号，也能读取和写入调用方指定的本地资产。只连接自己有权操作的账号，会话保存在当前 OS 用户的私有本地 JSON 文件中。项目不要求在 MCP 配置或工具参数中填写 Token。

## Private reporting in English

Report credential exposure, account-boundary failures, unauthorized file access or code execution through [GitHub private vulnerability reporting](https://github.com/seekskyworld/ai-modeling/security/advisories/new). If the form is temporarily unavailable, request a private contact in [Issues](https://github.com/seekskyworld/ai-modeling/issues) without exploit details, account data or sensitive evidence. Keep the detailed report locally until a private channel is available. No fixed response time or historical-version support is promised.

## 私密报告安全问题

潜在的凭据泄露、跨账号访问、越权操作、任意文件读写或命令执行问题，请使用 [GitHub 私密漏洞报告](https://github.com/seekskyworld/ai-modeling/security/advisories/new)，对应仓库 **Security → Report a vulnerability**。

如果入口暂时不可用，只在 [Issues](https://github.com/seekskyworld/ai-modeling/issues) 中请求私密联系方式，不公开利用方式、受影响账号或敏感证据。私密渠道可用前保留详细报告，不把凭据或漏洞细节附到公开 Issue、PR 或评论中。

维护者会根据可用信息、影响和资源评估报告；不承诺固定响应时限、历史版本修补或长期维护。发布候选中的 `SECURITY_CONTACT_URL` 应指向上述私密表单，发布前确认入口仍可用。

## 报告应包含什么

- 受影响的版本或提交、操作系统、Node.js 版本，以及 CLI/MCP 的调用方式。
- 最小复现步骤，优先使用合成数据、模拟响应和占位符。
- 预期边界、实际结果、可能受影响的数据或操作，以及需要满足的前置条件。
- 必要的脱敏错误和已有缓解方式；说明哪些结论已经验证、哪些只是怀疑。

不要为了确认问题访问他人的账号、扩大数据读取、制造付费订单，或重提结果不明的写请求。发现真实会话或私人资产时停止扩展验证，通过私密渠道描述最小必要事实。

## 本地会话与数据

正常登录流程先验证会话，再保存到 OS 账号主目录下的 `.ai-modeling-auth/credentials/<service-sha256>/<account-sha256>.json`。每条记录使用 `schema_version: 1` JSON envelope；会话、私有产物链接、上传引用和可选 LLM 密钥均使用此私有存储。JSON 内容没有额外加密，保密性依赖文件权限；不要把整个认证目录放入源码、云端共享或公开备份。

macOS/Linux 使用目录 `0700`、文件 `0600` 并核对所有者与普通文件身份。Windows 使用受保护 DACL，仅允许当前用户 SID 和 SYSTEM；校验所有者，拒绝 reparse point 与其它允许访问的 ACE。Windows 权限通过系统 PowerShell 检查/设置，不能用 POSIX chmod 代替。升级初始化可在验证归属与文件身份后，收紧应用自有认证控制目录和登录状态文件的旧 ACL，保留原登录状态与撤销信息；权限已正确则不重写。凭据 JSON 条目及 `auth import --file` 的外部文件只验证、不自动修复 ACL，无法确认权限时拒绝访问。沙箱需要允许当前进程访问这个私有目录。

认证根由 OS 用户信息确定，不随 `HOME`、`TMPDIR` 或 `AI_MODELING_DATA_DIR` 重定位。同一用户/profile 的 CLI 和 MCP 共用凭据、并发锁与撤销状态，写入通过同目录临时文件和原子替换完成。不要手动编辑、复制另一账号的条目，或通过换 profile 处理结果未知的任务。0.1.2 及更早的钥匙串条目不会被自动读取、迁移或删除；升级后用正常登录流程建立 JSON 会话。

密码、验证码和双重验证由用户在浏览器中完成。显式 CDP 地址只允许本机回环连接；不要向网络开放浏览器调试端口，也不要共享普通浏览器用户目录。

凭据 JSON、任务数据库、输入缓存、配置、签名 URL、网页抓取和账号报告都可能包含私人信息。它们不应进入公开提交、发布包或日志。忽略规则不能代替检查：分享错误输出前仍需移除会话、账号和任务标识、个人路径及资产链接。详细行为见[登录指南](docs/usage.md)和[架构](docs/development.md)。

如果会话已经泄露，使用上游服务提供的会话撤销方式，并清理本机会话。`ai-modeling logout` 清除当前 profile 的本地会话并撤销其登录流程，不能代替服务端撤销。它不会自动删除上传引用、签名下载链接、独立 LLM 密钥、其它 profile 或旧钥匙串条目。需要额外清理时先确定对应条目及其用途，不删除整个认证目录代替退出。删除公开文本也不保证已经复制的凭据失效。

## 请求与费用边界

`outcome_unknown` 表示提交结果不确定。保留原请求和回执线索，先进行对账；以新 request ID 重试可能产生另一个收费操作。估算费用不是上游扣费硬上限，余额暂时未变也不证明任务免费。

普通使用问题或非安全错误请查看[支持说明](SUPPORT.md)。社区行为问题按[行为准则](CODE_OF_CONDUCT.md)报告；不要将私人沟通或举报内容转贴到公开错误报告。
