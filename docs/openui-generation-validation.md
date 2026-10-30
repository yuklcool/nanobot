# OpenUI 第三批：独立生成任务与数据快照

关联 Issue #1、草稿 PR #3。基于第二批 `ab30eaf553f40eae0b43f05603a33ff94e06969f`，继续使用 `feature/openui-p0 → develop`。本批交付独立 UI 任务、当前模型适配、表格与记录分析的可验证增量；P0/P1 仍未整体放行，不替代真实模型/MCP、移动端、Docker 或 main 合并候选验收。前两批记录保留为历史证据。

## 当前行为

原生 Agent 完成工具执行、保存文字回答并发送 turn_end 后，Gateway 立即安排独立 UI 任务，不再等待视图生成才消费下一条业务输出。现有 turn hook 捕获该回合冻结的 Provider/model/generation 和显式注册的展示数据；typed bus event 只传这些对象，不传隐藏推理或任意工具原文。Agent loop、runner、Provider 和原生历史 schema 未改。

默认仍关闭 OpenUI；启用但保持 `generation=preview` 时使用确定性编译器，不增加 UI 模型请求。设置 `generation=model` 后，仅用户勾选交互视图的持久化 WebUI 回合会发起独立模型请求，使用当时已选模型和现有 Provider 凭证，不新增 API Key 配置。模型接收 SDK library prompt；有数据表时只接收 data_ref、标题、列定义和行数，不接收单元格事实；无数据表时接收已公开回答。不会把整段业务对话、工具结果或推理复制给 UI 模型。

数据适配器按精确工具名配置，必须明确 recordsKey、idField 和允许展示的 columns。只接受有界 JSON 文本中的平面标量记录；未选择字段不会进入数据快照。每回合最多 4 个数据集、总计 64 KiB，每表最多 50 行、8 列；记录总数和捕获时间随快照保存，截取前 50 行不会伪装成全量结果。数据来自已通过宿主原生权限的工具调用；这没有新增资源级 RBAC，原生 WebUI 仍是实例共享权限。

`DataTable(data_ref)` 从服务端快照读取字面单元格，布局模型不重写金额、能耗、ID。超出 JavaScript 安全整数范围的整数转为十进制字符串保存，避免传输后丢失末位数字。筛选只修改浏览器本地状态，不调用模型、工具或 RPC；过滤状态不承诺跨刷新恢复。Followup 草稿仍由用户显式保存。

“分析快照”先请求服务端核对 block/revision/data_ref/record_id，再生成包含捕获时间和原始展示值的规范化用户消息；原生入站再次核对内容完全一致后走同一 Session 的正常 Agent 路径。客户端不能提交任意工具名或伪造行数据。此动作是新一轮用户请求，沿用原生 Agent 权限；没有实现直接业务 Mutation、写操作确认或实时资源刷新。

## 配置示例

把下面字段合入已有的 `channels.websocket` 配置；`lookup` 是本批隔离测试工具名，实际使用时替换为已注册的工具名和其 JSON 字段。工具不返回这一结构时不会自动推断或展示原文。

```json
{
  "openuiEnabled": true,
  "openui": {
    "generation": "model",
    "timeoutSeconds": 45,
    "maxOutputTokens": 4096,
    "concurrency": 2,
    "capacity": 16,
    "tables": {
      "lookup": {
        "title": "Tasks",
        "recordsKey": "records",
        "idField": "id",
        "columns": {"name": "Task", "energy": "Energy", "status": "Status"},
        "maxRows": 50
      }
    }
  }
}
```

模型输出 token 上限同时受冻结回合 max_tokens 约束。总任务超时包含排队、Provider 正常网络重试与写入；未增加 prompt 自动修复循环。模型请求禁用 tools；即使 Provider 返回 tool_calls，也只让视图失败，绝不执行。完成快照记录 Provider 返回的用量（可能为估算值），尚无价格换算或全局费用预算。

## 任务、恢复与边界

- 队列有容量与并发限制，同一 session generation/turn 去重；满载或维护交接时回退为已有文字回答，不影响后续普通聊天。任务注册为 runtime maintenance 的 pending work，维护操作不会越过仍在生成或清理的 UI 任务。
- `openui.cancel` 只停止 UI；`openui.retry` 只重新生成同一份已捕获数据，使用新的 revision，总共最多 3 个 revision，不重复业务工具。超时、取消、Provider 错误和空输出都结束视图状态，保留原生文字。
- SQLite 在线程中写入；取消请求会等待已接受的工作线程收尾，不遗留后台写入跨过维护/删除边界。原生 WebUI 删除先 tombstone，再取消并清理 UI 任务与内存数据。
- 快照和草稿跨进程恢复不调用模型或工具。启动时 streaming 快照改为 failed；UI 源码、表格事实仍可查询。模型运行时凭证对象只在内存有界缓存中保留；进程重启或缓存淘汰后的模型重试明确返回 `UI_MODEL_UNAVAILABLE`，不会擅自改用当前模型或重新执行业务回合。
- 断开连接会清空当前视图；恢复前重新检查可选能力/hash。旧连接的迟到订阅/状态响应不能重新装入视图，旧连接记录预备响应不能向新连接发送分析请求。断线时未完成的 OpenUI RPC 和未能写入的 UI 动作不会跨连接自动重发；测试覆盖不提供该能力的宿主、同 ID 不同宿主和过期 socket 事件。实际跨机器/多标签页切换验收仍待完成。
- 历史锚点继续采用服务端 turn_id + turn_seq；后台捕获最多扫描最近 32 个原生回合，每回合 100 条/512 KiB。极端队列积压超出扫描范围时只保留文字，不猜测锚点。
- SQLite schema 保持 2，新字段是快照 JSON 的可选扩展。manifest 新增数据合同源码哈希；旧 library hash 的卡片不会在新组件库下执行。升级前备份，回滚前关闭功能并保留 sidecar。

## 验证与复现

本地通过：OpenUI Python 40 项；加上 hook、WebSocket 边界、Gateway smoke、CLI runtime 和历史回归共 126 项。前端 OpenUI 18 项；加 NanobotClient 和 useNanobotStream 共 231 项。应用/browser TypeScript、针对性 Ruff/ESLint/BasedPyright、Python/WebUI 导入边界、共享 manifest 一致性、主应用 build 通过。既有 pytest fixture 弃用提示、stream hook 测试的 React act 提示和构建大 chunk 提示仍存在。

```bash
python -m pytest tests/openui tests/agent/test_turn_hooks.py tests/agent/test_runner_hooks.py tests/agent/test_hook_composite.py tests/channels/test_websocket_application_boundary.py tests/webui/test_gateway_webui_smoke.py tests/cli/test_gateway_runtime.py tests/session/test_display_history.py -q
cd webui
bun x vitest run src/tests/openui src/tests/nanobot-client.test.ts src/tests/useNanobotStream.test.tsx
bun run build
bun x tsc -p tsconfig.browser.json
bun run openui:check
NANOBOT_OPENUI_GATEWAY_PYTHON=/absolute/path/to/nanobot/.venv/bin/python bun run test:browser -- browser/openui.spec.ts browser/openui-gateway.spec.ts
```

本批浏览器夹具使用生产 Provider 适配函数、原生 Agent/ToolRegistry、认证 TCP WebSocket 和 SQLite；Provider 的响应及只读 lookup 工具为确定性测试实现，不读取真实凭证。用例覆盖模型流输出、5412.5/0 字面数据、本地筛选、草稿刷新恢复、同 Session Followup/记录分析、删除后重建。专用 CI 增加前端 OpenUI 单元测试，浏览器结果必须以当前 PR head 的实际日志为准；第二批旧 head 的绿色结果不能替代本批验证。本地 Chromium 仍受先前已记录的 socket 限制，本批未宣称在本地完成浏览器验收。

SDK 1.0.2 的 Query/Mutation 兼容测试直接使用真实 createQueryManager，验证快照 Query、显式 Mutation 和应用工具白名单；注册 Mutation 不执行，未允许的业务写入返回失败。**这只是 SDK API 验证，生产 Renderer 仍不传 toolProvider，没有开放 Query/Mutation 后端。**

对应设计 AT03/AT04/AT05/AT08/AT10/AT11/AT12/AT13/AT16/AT18/AT20/AT22 的部分断言已覆盖；完整判定仍以设计矩阵为准。下一步保留真实模型与真实 MCP 演示、auto、图表、资源级数据权限和写操作确认、事件 outbox/崩溃对账、命令重置/截断物理清理、复杂历史与移动端、Docker、main 无损合并候选验收。此批不关闭 Issue，不自动发布。
