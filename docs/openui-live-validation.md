# 真实模型与现有只读工具验收

Refs #1。基于 `develop` 的 `ed9f16b4f83d0b80b18693039b1e6e7fe3d7c184`，补充真实 Provider 的浏览器验收，复用生产客户端、Renderer、Gateway、AgentLoop 和 `search_sessions` / `read_session`。不增加产品配置项、业务工具或外部 MCP。本地不执行测试、静态检查或构建，所有执行证据来自 GitHub Actions。

## 执行方式

普通 PR CI 继续使用离线 Provider，验证临时配置隔离及既有 OpenUI 行为，不读取部署凭据。手动触发 `OpenUI Gateway acceptance` 的 `run_live=true`，并传入预先准备的 `openui-live-*` 临时 runner label，才会执行 `live-model` 作业；该 runner 必须只执行这次受信任提交，注册为 ephemeral，使用随机 label 并关闭默认 labels。

Codespace 管理员在服务器内准备 `/tmp/nanobot-openui-live-<label>/provider.json`，权限 `0600`，仅包含选中的模型 preset、Provider 和网络设置。凭据不传回本地、不加入仓库或 Actions secrets，不开放生产服务公网端口。运行时再次筛选配置，在临时目录创建独立 workspace、SQLite 会话与 UI 快照；关闭生产 channels、MCP 和 fallback，清除默认 Agent 工具，仅注册两个生产只读工具。作业结束删除临时配置，runner 自动注销；管理员清理临时 runner 目录。不要把生产数据目录挂载到测试 workspace。

`NANOBOT_OPENUI_LIVE_CONFIG` 和 `NANOBOT_OPENUI_LIVE_EVIDENCE` 必须同时显式设置；前者缺失时使用离线 Provider，文件不存在时明确失败。外部调用沿用项目现有重试策略，浏览器场景不自动重跑，UI 生成沿用默认 45 秒超时，每个 Agent 回合最多五次迭代，整个 live job 最多 15 分钟。失败保留证据，不用重复运行掩盖失败样本。

## 验收路径

1. 自动模式下普通解释仅执行 Agent 请求，无工具、无 UI 生成。
2. 搜索两条人工历史会话，真实搜索结果由白名单数据适配器生成表格；表格不展示历史正文或验收码。
3. 本地筛选不发送消息、不增加工具或模型请求。
4. 点击 `Planning notes`，在原 Session 执行 `read_session`，回答包含该记录的验收码 `ORBIT-742`，继续生成可点击选项；不能串到另一条记录的 `COMET-319`。
5. 刷新恢复表格与后续组件，消息和真实调用计数保持不变；检查 Renderer 是否可用、页面错误、UI 状态及模型返回的 usage。

报告使用原生 `LLMCallRecord` observer 和 AgentHook，逐次记录物理请求的模型、Provider、时间、finish reason、错误状态及 reported/estimated token，工具只记录名称、错误标志及选中记录是否正确，不保存请求消息、原始工具结果、API 地址或凭据。浏览器附件记录各阶段耗时、终态快照数量/状态、Lang 字节数、library hash 和 UI usage；截图只包含人工验收会话。统计包含 Provider 自动重试，不能把物理请求数等同于对话回合数。

## 证据范围

实际提交、GitHub run、模型与结果将在执行后记录。单个模型、单次人工场景只能证明对应提交和样本的闭环，不能推算通用成功率；外部 MCP、直接 Query/Mutation、业务写入确认、崩溃对账及 P0/P1 整体验收仍未完成。
