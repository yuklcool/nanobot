# OpenUI P0：Gateway 接入验证（第二批）

关联 Issue #1、PR #3。此批基于 `48da8994552b6eb9aa00b0cf7b5c26445ac2ac9e`，继续在 `feature/openui-p0` 开发，目标仍为 develop。本文记录 Gateway 最小接入；完整设计目标未缩减，P0 仍未整体放行。

## 当前实现与边界

正式聊天组件已挂载受功能开关和协议协商控制的 OpenUI 入口。仅在配置 `channels.websocket.openuiEnabled=true`、连接通过原生 WebUI 认证、客户端组件库哈希匹配、用户勾选“交互视图（预览）”时，新回合才生成 UI。默认关闭；CLI、旧客户端、临时会话和普通文本回合不生成 UI，不增加模型请求。

本批使用**确定性最小编译器**：读取原生持久化历史中当前完成回合的最后一个公开回答，将其编译为真实 SDK 的 Panel/Text/Followup。它不调用额外模型，不读取原始工具输出或隐藏推理。该视图是后续 Generator/DisplayBundle 的接入验证，尚不是模型生成的表格、图表、业务表单或完整自动布局；当前也没有 auto 模式。预览卡片可能重复展示正文，后续产品化需要优化。

生成顺序为原生历史提交 → 原生 `turn_end` 投递 → UI 独立快照流。卡片使用服务端 `turn_id + turn_seq` 锚点，既不把浏览器随机消息 ID 当作历史身份，也不把文本 `stream_end` 当成回合结束。仅成功完成的回合创建此最小视图，取消或失败回合继续保留原生文字行为。UI 写入或发送失败不会使原生回答投递失败；启动时未完成的快照变为 failed，不重跑业务工具。

客户端在 ready 中检查可选 `openui` 协议 1 与组件库哈希，再通过认证 WebSocket 调用 `openui.subscribe` 获取已加载回合的服务端快照（每批最多 100 个，长历史分批）；增量事件使用 `openui.snapshot` 全量快照与递增 seq，恢复也以快照为权威。本批没有新增第二个聊天连接，没有实现事件 outbox/delta replay。旧客户端不协商此能力，不接收 UI 事件。协议核心仍为 WebUI 1；此 P0 能力不代表设计文档中的最终 ui.* 契约已经全部落地。

客户端通过原 `useNanobotStream.send()`/`NanobotClient` 发送带 `ui_action` 的普通 message；服务端验证连接权限、已附着聊天、当前 generation、完整卡片、revision、组件库、动作白名单及参数，然后进入原生入站队列。跟进内容是用户输入；不能直接指定 Tool/MCP 名称，不能通过该动作注入斜杠或 shell 命令。执行权限仍由原生 Agent 和工具策略负责。

当前宿主的 WebUI 认证是实例共享权限，store 的 `owner=webui` 反映这一事实。client_id 不被当成可信租户身份。本批不声称增加了宿主原本没有的多租户或逐资源 RBAC。

## 动作幂等和状态

新增 SQLite `ui_actions`，按 owner/session/generation/request_id 保存参数摘要与 reserved/accepted 状态。request_id 同时作为目标原生 turn_id。同键改参数拒绝；已接受动作重发返回接收回执，不再入队。服务重启后该行为仍由数据库保护。

数据库登记与内存入站队列没有跨系统原子事务。若进程在 reserved 后、accepted 回执落盘前崩溃，重新提交得到 `RESULT_UNKNOWN`，不自动重放。这个保证是保守的至多一次入站放行；可能保留未真正执行的未知操作，不是任意业务工具的 exactly-once。用户需要检查会话及真实业务结果；持久化任务队列、对账接口和远端副作用幂等仍待后续实现。

只有主动点击“保存草稿”才把 `$question` 写入附属库，自由输入不自动落库。状态与 Lang 源内容采用独立版本比较；同一保存因丢回执而重放可以返回原结果，新旧草稿冲突不能覆盖。历史挂载不发送 Agent 动作或 Mutation。

附属库升级为 schema 2，可读取并升级 schema 1；旧版本遇到 schema 2 应拒绝写入。升级前备份 `openui.sqlite3` 及 WAL/SHM（停服务或使用 SQLite backup API）；回滚代码时先关闭 openuiEnabled，保留附属数据，不覆盖原生 sessions.sqlite3。新 generation 会使旧卡片/动作失效；WebUI 的原生 session.delete 已接通附属清理：先 tombstone 当前及已有 generation，再删除卡片/草稿/动作记录，然后执行原生删除；原生删除失败时保留文字并让 UI 降级。命令重置、历史截断等其它管理路径的物理回收仍待 P2 验证。

## 可复现验证

**已完成 CI 浏览器实测**：源码 head `ed18a4954556fee118049a3908a59ad2f199d042` 的 [GitHub Actions run 40983213876](https://github.com/yuklcool/nanobot/actions/runs/40983213876) 成功。该运行实际执行 3 个 Playwright 用例，全部通过（非跳过）：真实 SDK 流式与恢复、非法组件降级，以及真实认证 Gateway → 两轮原生工具执行 → 跟进表单 → 刷新后的服务端卡片/草稿恢复。CI 同时通过新增 Python 17 项和 manifest 一致性检查。此记录保留原运行身份；后续功能补充必须重新验证，不把它写成新 head 的重新执行。

本地针对性验证：Python 152 项通过，包含新增 Gateway/原生 Agent/真实认证 WebSocket、共享/独立会话两种路由、重启后防重、参数冲突、未知状态、旧 generation、未认证连接，以及原 Hook、WebUI 协议和 transcript 回归。前端 225 项通过，覆盖真实 SDK、锚点归属、显式保存、刷新恢复、不自动执行、结构化动作及旧宿主降级。应用和 browser TypeScript、针对性 Ruff/ESLint/BasedPyright、Python/WebUI import boundaries、组件库 manifest 一致性及主应用构建通过。已有 chunk 大小警告仍在。另以已构建前端产物跳过重建，实际构建 Python wheel，并在临时解包目录导入打包后的 openui_runtime，确认共享 manifest 的内容及加载路径正确；这不等于 Docker 或五平台发布验收。

```bash
.venv/bin/python -m pytest tests/openui tests/agent/test_turn_hooks.py tests/agent/test_hook_composite.py tests/agent/test_loop_direct_websocket_status.py tests/agent/test_runner_hooks.py nanobot/channels/websocket/tests/test_webui_session_admission.py nanobot/channels/websocket/tests/test_websocket_protocol_boundaries.py tests/webui/test_client_contract.py tests/utils/test_webui_transcript.py -q
cd webui
bun run test -- src/tests/openui src/tests/nanobot-client.test.ts src/tests/useNanobotStream.test.tsx
bun run typecheck
bun x tsc -p tsconfig.browser.json
bun run openui:check
bun run check:imports
bun run build
```

`openui:generate` 从实际 SDK library.prompt()、组件源码及锁定 SDK 版本生成共享 manifest/hash，前后端消费同一文件；Python 包显式包含该 JSON，避免源码环境可用而打包缺失。更新组件库必须同时重新生成并审查 manifest。没有把首批 PoC 的固定字符串当作正式哈希。

完整浏览器验收使用新的 `browser/openui-gateway.html`，它引用生产 NanobotClient、useNanobotStream、MessageBubble 和 OpenUIChatProvider，通过真实 TCP WebSocket、真实认证、原生 Agent/ToolRegistry/SessionState 和 SQLite 服务。仅 Provider 和 read-only 业务测试工具为确定性夹具；没有前端拦截 WebSocket 或 localStorage 伪造服务端恢复，也不读取用户凭证。

```bash
cd webui
NANOBOT_OPENUI_GATEWAY_PYTHON=/absolute/path/to/nanobot/.venv/bin/python bun run test:browser -- browser/openui.spec.ts browser/openui-gateway.spec.ts
```

Python 可执行文件由环境变量指定；Playwright 自动启动并清理隔离的临时 Gateway 与 Vite。普通 browser suite 没有该变量时跳过需要 Python Gateway 的新增用例。专用 `.github/workflows/openui.yml` 在标准 ubuntu-latest 上安装依赖、运行 Python 和三项浏览器用例，不上传大型产物，不发布 tag/Release/镜像。工作流结果须以 PR 当前 head 为准。

**本地环境限制（已由 CI 补验基础链路）**：默认 Playwright 浏览器尚未安装，使用已安装的 `/usr/bin/chromium` 后仍在启动时被 process_singleton_posix 的 socket 权限限制阻断。未绕过宿主限制。Python TCP WebSocket 实测通过并不替代浏览器验收；上文 CI 已补验这三项浏览器用例；本地启动失败仍保留为环境记录。

## 剩余放行项

- 基础浏览器闭环已通过；仍需断线和宿主切换实测、移动端和复杂历史合并验收。
- 真正的模型 Generator、受控 DisplayBundle/data_ref、表格/图表、auto 模式、预算与用量。
- Query/Mutation SDK 代理验证、资源级权限、确认和真实业务回执。
- UI 任务/事件 outbox、崩溃对账、复杂历史合并，以及命令重置/截断等其它管理路径的物理数据回收。
- 上游 main 无损合并候选、Docker 实际启动、真实模型和真实 MCP 演示。

宿主改动集中在 gateway_services（可选服务装配）、WebSocket runtime（默认开关、ready 能力和持久化回合完成后的单一接入点）、inbound_commands（认证 RPC 和动作入站）、NanobotClient/useNanobotStream（可选消息元数据和接收回执）、ThreadShell/MessageBubble（上下文及单一渲染入口）、构建清单/测试配置。Agent loop、runner、Provider、MCP 和原生历史 schema 未修改。最可能的上游冲突仍是 WebSocket 投递、入站编排和前端发送接口；关闭功能并回退此批代码可保留普通聊天，不能据此承诺未来无合并冲突。
