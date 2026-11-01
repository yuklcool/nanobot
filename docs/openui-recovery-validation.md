# 断网、会话切换与历史分页验收

Refs #1，对应 AT12、AT13、AT14 的现有 WebUI 恢复路径，基线为 develop 的 ac2fc7636561a27f3ec5475e833c1d506cb1d715。本批复用原生 Gateway、认证 WebSocket、生产 NanobotClient、useNanobotStream、ThreadMessages 和官方 Renderer，不增加业务能力、组件、配置或持久化结构。

确定性 Provider 将 UI 流停在首个可见组件之后，通过仅存在于隔离测试夹具的控制接口释放流或关闭真实连接。重连须恢复相同 block/turn 的流式快照，继续生成后只显示一份表单，允许草稿刷新恢复；Agent、UI Provider 与只读工具计数不得因重连或刷新增加。连接关闭由原生 WebSocket 服务执行，不用前端伪造 ready、快照或恢复数据。

会话切换场景在 A 的 UI 生成未完成时切换至 B，在 B 完成独立交互后释放 A。A 的迟到快照不得出现在 B；返回 A 可恢复表单，提交仍进入 A，随后返回 B 保持原视图。验收不将组件隔离等同于多用户 RBAC 或跨主机切换验收。

历史场景预置 245 个虚构完整回合及其真实附属数据库快照，经原生 HTTP 历史分页与 OpenUI 每批最多 100 个 turn 的订阅恢复。检查最早、中间、最新回答与卡片的对应位置、已有草稿及无自动 Agent/Query/提交。分页按钮只存在于测试夹具，调用生产 Hook 的 loadOlder；本场景验证分页合并与锚点，不替代生产 ThreadViewport 的滚动位置验收。预置数据不构成模型生成质量证据。

测试、类型检查、lint 与构建仅在 GitHub Actions 执行，实际结果以本批 PR 的确切提交与运行产物为准。进程崩溃对账、重置/截断的物理清理、跨版本迁移及 Issue #1 整体验收不在本批范围内。

本批见 [PR #18](https://github.com/yuklcool/nanobot/pull/18)。2026-11-01 启动验收曾返回 HTTP 422：Actions has been disabled for this repository；仓库配置仍为 enabled:true，工作流仍为 active。登录后的 Actions 页面明确显示 Workflows on this fork have been disabled，说明 GitHub 为减少 fork 的无效计算而停用了工作流。通过页面上的重新启用按钮恢复后，手动调度及 PR 触发均可创建运行；无需修改工作流权限或账单预算。

[GitHub Actions 运行 41292134757](https://github.com/yuklcool/nanobot/actions/runs/41292134757) 对提交 ef8457a042bc230252686d810f43fe78613f3828 验收通过：158 个 Python 测试、298 个前端测试、13 个浏览器用例、清单一致性、lint、类型检查、导入边界、容器与安装包验收。夹具复用生产 bootstrap 方法在重连时取得新握手凭据，按既有调用来源区分 Agent 与系统标题调用，并在用例结束时释放暂停流，避免失败污染后续用例。之后仅更新本验收文档，测试源码及运行代码未变，沿用该次证据；本地未执行测试、静态检查或构建。本次未执行真实模型用例，历史分页结论仍受前述范围限制。
