# OpenUI 生成可靠性与动作范围

Refs #1。基线为 develop `7c40cbb5ded41d54e6f49782eedfc010db9eb56c`。本批对应 AT02、AT17 的生成和失败恢复路径，延续现有问卷、快照、取消和 UI 单独重试；不增加业务工具、模型分类请求、依赖或配置，不将这些局部验证等同于 P0/P1 总体验收完成。

## 修复与边界

原生 Provider 对已输出内容后的流超时可能恢复请求并关闭增量回调；UI 原先没有恢复回调，可能收到成功结果却将旧的半截源码标记完成。UI 现在在已有输出的恢复边界明确失败，保留原生文字与失败快照，由现有 UI 重试入口生成新的 revision。首次输出前的标准 Provider 重试仍沿用原实现；不重跑 Agent 或业务工具，不增加超时和重试预算。

重生成会清空旧 revision 的组件状态。为防止丢失用户输入或操作回执，已有 `$question`、`$forms` 或 `$renames` 的视图拒绝重生成，返回 `UI_STATE_SAVED`；检查同时位于请求入口与存储事务中，防止排队期间新保存的输入被清除。正常问卷修改仍通过已有同会话动作创建新表单，原提交保留。仅 `$followup` 来源上下文不阻止失败视图重试，继续沿用已获准保存的答案。

生成约束明确当前请求及已获准跟进上下文的范围；原生答案中的额外建议不构成新授权。按钮标签与实际回复应含义一致，明确给出的回复值应原样保留；确认收到信息不能扩展为执行下一项业务。该约束通过真实模型样本复验，不能替代服务端权限、参数验证和幂等保护，也不能保证任意模型的语义输出都合规。

## 复用现有日志

| 事件 | 用途 | 关键字段 |
| --- | --- | --- |
| `turn_completed`（既有） | 原生回答及工具回合 | `turn_id`、`duration_ms`、`outcome` |
| `openui_job_completed` | 排队到结束的 UI 作业 | `turn_id`、`queue_ms`、`duration_ms`、`status`、`error_type` |
| `openui_model_completed` | 单次 UI 模型请求链 | `turn_id`、`block_id`、`revision`、`manual_retry_count`、`duration_ms`、`first_delta_ms`、`retry_waits`、`output_bytes`、`finish_reason`、`error_code`、`error_status_code`、token 计数及冻结的模型/生成设置 |
| `openui_job_rejected` / `openui_job_cleanup_failed` | 容量拒绝或清理异常 | `turn_id`、原因或异常类型 |

字段沿用 Loguru 的结构化 extra；默认日志消息也带阶段耗时。`queue_ms=null` 表示未获得执行槽，不把排队超时误报为模型耗时。`first_delta_ms` 仅表示首段非空 UI 源码，不表示组件已可交互。`retry_waits` 是等待过的重试轮次，不重复计算心跳通知，也不替代实际 API 调用计数。超时取消模型协程时模型事件可为 cancelled，以外层作业的 timeout 为最终原因。缺失 token 用 null 表示，不估算失败请求未上报的消耗。

新增事件不记录问题、答案、表单值、Provider 错误原文或连接凭据。仅写入已知错误码及异常类名；原生 `turn_completed` 仍使用宿主既有日志策略。本批不改造通用 Provider/Agent 日志，也不新建监控平台。

## GitHub 验证

所有测试、静态检查和构建通过 GitHub Actions 执行，本地不运行。当前提交的确切运行与产物以 PR 证据为准，不将本文的验收清单当作已运行结果。

- 单测及 Gateway 回归：首段前可重试、部分 UI 流中断明确失败、手动 UI 重试不重复工具、排队超时与运行取消可区分、错误诊断脱敏、重试保留已有输入与提交状态。
- 既有浏览器回归：流式恢复、取消、会话隔离、问卷填写和同会话再次提交。
- 可选真实模型作业：复用隔离 Codespace runner 和现有四个浏览器场景，问卷覆盖修改、再次提交、限定确认回复及无额外动作。产物新增 `evidence.openui.jsonl`，仅导出上述日志的白名单指标，分别核对原生回合、UI 排队和模型阶段。

真实照明部署的原有超时原因需要用对应模型和上下文复验；其它模型的成功样本不能替代该验收。本批不访问或调整照明服务器实例。
