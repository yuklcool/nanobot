# 断网、会话切换与历史分页验收

Refs #1，对应 AT12、AT13、AT14 的现有 WebUI 恢复路径，基线为 develop 的 ac2fc7636561a27f3ec5475e833c1d506cb1d715。本批复用原生 Gateway、认证 WebSocket、生产 NanobotClient、useNanobotStream、ThreadMessages 和官方 Renderer，不增加业务能力、组件、配置或持久化结构。

确定性 Provider 将 UI 流停在首个可见组件之后，通过仅存在于隔离测试夹具的控制接口释放流或关闭真实连接。重连须恢复相同 block/turn 的流式快照，继续生成后只显示一份表单，允许草稿刷新恢复；Agent、UI Provider 与只读工具计数不得因重连或刷新增加。连接关闭由原生 WebSocket 服务执行，不用前端伪造 ready、快照或恢复数据。

会话切换场景在 A 的 UI 生成未完成时切换至 B，在 B 完成独立交互后释放 A。A 的迟到快照不得出现在 B；返回 A 可恢复表单，提交仍进入 A，随后返回 B 保持原视图。验收不将组件隔离等同于多用户 RBAC 或跨主机切换验收。

历史场景预置 245 个虚构完整回合及其真实附属数据库快照，经原生 HTTP 历史分页与 OpenUI 每批最多 100 个 turn 的订阅恢复。检查最早、中间、最新回答与卡片的对应位置、已有草稿及无自动 Agent/Query/提交。分页按钮只存在于测试夹具，调用生产 Hook 的 loadOlder；本场景验证分页合并与锚点，不替代生产 ThreadViewport 的滚动位置验收。预置数据不构成模型生成质量证据。

测试、类型检查、lint 与构建仅在 GitHub Actions 执行，实际结果以本批 PR 的确切提交与运行产物为准。进程崩溃对账、重置/截断的物理清理、跨版本迁移及 Issue #1 整体验收不在本批范围内。
