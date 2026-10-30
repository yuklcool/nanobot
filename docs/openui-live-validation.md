# 真实模型与现有只读工具验收

Refs #1。基于 `develop` 的 `ed9f16b4f83d0b80b18693039b1e6e7fe3d7c184`，补充真实 Provider 的浏览器验收，复用生产客户端、Renderer、Gateway、AgentLoop 和 `search_sessions` / `read_session`。不增加产品配置项、业务工具或外部 MCP。本地不执行测试、静态检查或构建，所有执行证据来自 GitHub Actions。

## 执行方式

普通 PR CI 继续使用离线 Provider，验证临时配置隔离及既有 OpenUI 行为，不读取部署凭据。手动触发 `OpenUI Gateway acceptance` 的 `run_live=true`，并传入预先准备的 `openui-live-*` 临时 runner label，才会执行 `live-model` 作业；该 runner 必须只执行这次受信任提交，注册为 ephemeral，使用随机 label 并关闭默认 labels。

Codespace 管理员在服务器内准备 `/tmp/nanobot-openui-live-<label>/provider.json`，权限 `0600`，仅包含选中的模型 preset、Provider 和网络设置。凭据不传回本地、不加入仓库或 Actions secrets，不开放生产服务公网端口。运行时再次筛选配置，在临时目录创建独立 workspace、SQLite 会话与 UI 快照；关闭生产 channels、MCP 和 fallback，清除默认 Agent 工具，仅注册两个生产只读工具。作业结束删除临时配置，runner 自动注销；管理员清理临时 runner 目录。不要把生产数据目录挂载到测试 workspace。

`NANOBOT_OPENUI_LIVE_CONFIG` 和 `NANOBOT_OPENUI_LIVE_EVIDENCE` 必须同时显式设置；前者缺失时使用离线 Provider，文件不存在时明确失败。外部调用沿用项目现有重试策略，浏览器场景不自动重跑，UI 生成沿用默认 45 秒超时，每个 Agent 回合最多五次迭代，整个 live job 最多 15 分钟。失败保留证据，不用重复运行掩盖失败样本。

## 验收路径

1. 自动模式下单句解释（显式要求纯文字）仅执行 Agent 请求，无工具、无 UI 生成；预设验收会话标题，避免后台标题请求干扰计数。
2. 搜索两条人工历史会话，真实搜索结果由白名单数据适配器生成表格；表格不展示历史正文或验收码。
3. 本地筛选不发送消息、不增加工具或模型请求。
4. 点击 `Planning notes`，在原 Session 执行 `read_session`，回答包含该记录的验收码 `ORBIT-742`，继续生成可点击选项；不能串到另一条记录的 `COMET-319`。
5. 刷新恢复表格与后续组件，消息和真实调用计数保持不变；检查 Renderer 是否可用、页面错误、UI 状态及模型返回的 usage。

报告使用原生 `LLMCallRecord` observer 和 AgentHook，逐次记录物理请求的模型、Provider、时间、finish reason、错误状态及 reported/estimated token，工具只记录名称、错误标志及选中记录是否正确，不保存请求消息、原始工具结果、API 地址或凭据。浏览器附件记录各阶段耗时、终态快照数量/状态、Lang 字节数、library hash 和 UI usage；截图只包含人工验收会话。统计包含 Provider 自动重试，不能把物理请求数等同于对话回合数。

## 证据范围

单个模型、单次人工场景只能证明对应提交和样本的闭环，不能推算通用成功率；外部 MCP、直接 Query/Mutation、业务写入确认、崩溃对账及 P0/P1 整体验收仍未完成。

## 2026-10-30 实测记录

所有执行均由 GitHub Actions 调度，模型为 Codespace 已配置的 `openai / gpt-6-luna`。早期失败样本与最终通过样本一并保留，三次运行的代码或验收夹具不同，不合并计算成功率。

| GitHub run | 验证提交 | 结果 | 物理请求 / token |
| --- | --- | --- | --- |
| [41072765382](https://github.com/yuklcool/nanobot/actions/runs/41072765382) | `bca5984655c27a0a94766fd66460bdcf82d32a10` | 搜索阶段出现一次失败的 `read_session` 尝试，严格工具序列断言失败；已生成搜索表格，尚未点击记录。该次还包含后台标题请求。失败尝试未在后续样本复现，未宣称已修复模型决策问题。 | 5 / 5270 |
| [41074285353](https://github.com/yuklcool/nanobot/actions/runs/41074285353) | `3ba907339ed784e9d399ca65caa71314a5672fa7` | 搜索、选择和正确读取均成功；最终回答使用 `Choose one: …`，自动规则漏判，未请求第二个 UI，等待按钮失败。 | 6 / 8376 |
| [41075559150](https://github.com/yuklcool/nanobot/actions/runs/41075559150) | `0ad6f103c2baf829db9883d3d4072f1766a64f9a` | 修复规则后完整三轮闭环通过；两个 UI 快照均 `complete`，无页面、工具或 Provider 错误，筛选和刷新均无新增调用。 | 7 / 9783 |

生产修复仅扩展 `nanobot/openui/policy.py` 的明确行首选择指令：识别 `Choose one`、`Pick one`、`Select between`，支持列表和加粗写法；继续排除代码块、引用及解释句。不增加意图分类模型请求，不改变普通模式和默认开关。补充六个回归案例，其中一个逐字复现第二次真实失败回答。

最终场景从页面加载至刷新确认耗时 23.271 秒，含初始连接与断言等待；搜索至表格完成为 5.558 秒，点击记录至详情和后续按钮完成为 5.500 秒。共 3 条用户消息、5 次 Agent 请求、2 次 UI 请求，输入 9491、输出 292、总计 9783 token，均为 Provider reported，无 estimated token。`search_sessions` 与 `read_session` 各执行一次，后者确认目标为 `websocket:saved-planning`。刷新后模式按既有行为恢复关闭，历史表格和按钮仍能显示，不重放工具或模型请求；本地筛选文本按既有行为不持久化。

独立离线 CI [41075462716](https://github.com/yuklcool/nanobot/actions/runs/41075462716) 验证同一功能提交：92 项 Python、276 项 Vitest 和 7 项浏览器测试通过，类型、静态检查、manifest、导入边界、wheel 安装启动与 Docker 认证启动检查通过。已下载并人工检查 `live-search.png`、`live-selected-detail.png`、`live-restored.png`；原始截图和 JSON 指标保留在 GitHub run 的 `openui-live-results-0ad6f103c2baf829db9883d3d4072f1766a64f9a` 产物，保留期 7 天，未提交原始产物到源码。
