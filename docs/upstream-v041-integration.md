# Issue #29：官方 v0.4.1 集成评估

本批只在 `codex/upstream-v041-integration` 准备升级候选，通过 PR 审查后再决定是否合入 develop。没有更新运行实例，也没有发布 tag 或 Release。

## 固定输入

| 引用 | Commit SHA |
| --- | --- |
| 本批 develop 起点 | `467b9aa572e6245f995fea140f50ed463601bc5b` |
| origin/stable，官方 v0.4.1 | `3404fe83e22b7b2cb3edae1348ed45dd9b8ad051` |
| 共同官方基线 v0.4.0 | `8f7a7d17590de7ab187650381894dba2b9e060ab` |

v0.4.0 至 v0.4.1 包含 75 个上游提交、1180 个文件变化。最新 develop 的隔离试合并产生 13 个冲突文件；没有把 main 的未发布改动并入本批。

## 冲突与处理

| 冲突文件 | 冲突原因与处理 |
| --- | --- |
| `nanobot/agent/tools/sessions.py`、`nanobot/session/history.py` | 上游增加异步取消、流式读取、代次及 handle 二次校验；保留这些安全和性能合同，同时迁移本项目的 `session_keys` 筛选、标题命中摘要和相邻公开回答。隐藏消息和运行上下文继续过滤。 |
| `nanobot/channels/websocket/runtime.py` | 上游将消息投影和持久化迁至 `webui/outbound_delivery.py`。删除旧发送实现，将交互生成接到新模块成功持久化并投递完成事件之后；不恢复旧投影模块。 |
| `nanobot/cli/gateway_runtime.py` | 同时保留上游 goal 装配、上下文来源 Hook，以及既有文件编辑 Hook 和 OpenUI 采集 Hook。 |
| `nanobot/command/builtin.py` | 保留统一执行会话模式下独立展示历史的 reset 和代次校验，沿用上游命令分层。 |
| `nanobot/webui/inbound_commands.py` | 使用上游 command application 入口及 workspace 错误处理，保留交互动作、能力提示、表单和防重准入；迁移会话通知到新投递接口。 |
| `nanobot/webui/sidebar_state.py` | 合并上游归档状态数据库化、偏好文件写锁，以及本项目的标题确认、版本比较和原子落盘。重命名广播从原生侧栏服务读取完整状态，防止漏发数据库中的归档标记。 |
| `tests/agent/tools/test_session_history.py`、`tests/agent/tools/test_sessions.py` | 同时保留两侧行为断言，采用上游异步资源释放，覆盖相邻回答、筛选和会话替换时的读取安全。 |
| `tests/scripts/test_ci_workflows.py` | 同时保留候选产物与 SHA 绑定合同，以及上游 Windows 检查的串行执行合同。 |
| `webui/package.json`、`webui/bun.lock`、`webui/package-lock.json` | 合并 OpenUI/图表与上游代码高亮依赖；锁文件统一交给 GitHub Actions 生成，避免人工拼接。 |

自动合并仍需语义回归：重点包括 `session/state.py` 的删除/reset 通知、`display_history.py` 的回答锚点、Gateway 装配及前端消息渲染、模式记忆、恢复和动作投递。文本无冲突不代表这些合同已经通过。

## 回归中发现的兼容问题

- 空闲会话的 `/new` 经过上游 session worker 执行时，取消旧任务的逻辑会取消当前 worker 自己。取消时排除当前任务，其他活动任务仍按原合同取消并等待退出。
- 删除自动合并留下的重复 `SessionState.read_header` 定义；更新 OpenUI 测试夹具，使用真实入站分发入口和新版出站投递服务。
- OpenUI 外层以会话 ID 作为 React `key` 会重建整个聊天界面，破坏上游上下文侧栏跨会话保持和首次历史滚动。移除外层强制重建，沿用 Provider 已有的会话状态清理和代次隔离。
- 浏览器实测中，Recharts 隐藏提示框在桌面缩至 390px 后仍保留桌面坐标，将页面撑至 678px。将横向裁剪限定在图表容器内，保留原有窄屏回归断言；不隐藏整页溢出，也不修改交互组件清单 hash。
- 纯 stable 的 437 项原生浏览器检查通过，而集成候选出现 57 项失败。SDK 的开发入口会在导入时从 CDN 自动加载调试控件，向普通页面添加隐藏弹窗、编辑器及调试 DOM。Vite 将可选调试控件接到明确禁用的适配模块，保留 SDK 渲染器与交互功能，继续用原生浏览器检查验证接入影响。
- 上游严格类型检查覆盖既有 OpenUI 模块后暴露 JSON 状态类型和跨模块私有存储接口问题。明确内部 JSON 类型，统一事务内快照读写接口，保留运行时校验与事务边界。

## 升级检查工具

`origin/stable` 可以先于 develop 更新，因此它不一定已经是 develop 的祖先。兼容检查继续严格要求 stable 对应官方正式标签、目标不能降级，并从 stable 与 develop 共同包含的最新官方标签计算双方改动。报告分别记录 stable 指针和共同基线，不再把“stable 已同步但 develop 尚未集成”误判为无效仓库。

## 验证和回退边界

所有测试、类型检查、lint、构建、锁文件和组件清单生成均在 GitHub Actions 执行。本地只执行源码检查、Git 操作和 `git diff --check`。Actions 对确切候选验证 Python、前端、浏览器、安装 wheel 和 Docker；结果及失败修复会记录到 PR，运行中的检查不算通过。

合入前回退只需停止本功能分支评审，develop 和实例不受影响。若将来明确选择合入后需要撤销，通过 develop 功能分支对合并提交执行 `git revert -m 1 <merge-sha>` 并走 PR，不重写 main/stable。运行环境回退必须使用实际部署前记录的版本及对应产物；本批没有改变生产数据，也不能据此承诺数据库降级兼容。

Issue #29 的关闭仍需要独立实例验收问卷、两轮真实只读 SQL/MCP、模式和历史恢复，并记录部署来源 SHA 和产物校验值。本批代码回归不能替代该验收。
