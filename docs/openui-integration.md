# OpenUI 接入与维护

Refs #1。本文说明当前实现和维护入口，功能基线为 develop `105cac5bfcdc92e069dd731ccea78c18c1645b76`，不将设计稿中的计划当成已交付能力。OpenUI 仍是实验功能；业务工具及照明数据的真实验收在部署后进行，Issue #1 不因此关闭。部署步骤见 [隔离测试部署](openui-deployment-test.md)，阶段目标和 AT01–AT24 见 [详细设计](openui-integration-design.md)。

## 启用与模式

配置位于现有 `channels.websocket`；将下面的字段合入实例配置，不要覆盖已有认证和 Provider 配置：

```json
{
  "openuiEnabled": true,
  "openui": {
    "generation": "model",
    "timeoutSeconds": 45,
    "maxOutputTokens": 4096,
    "concurrency": 2,
    "capacity": 16,
    "tables": {}
  }
}
```

`generation` 的默认值为 `preview`，只从明确捕获的数据生成表格，不调用额外 UI 模型；`model` 使用当前回合冻结的 Provider 和模型生成组件，会产生额外请求和费用，不拥有业务工具执行权限。`timeoutSeconds` 默认 45、范围 1–120；`maxOutputTokens` 默认 4096、范围 128–8192；`concurrency` 默认 2、范围 1–4；`capacity` 默认 16、范围 1–32。`tables` 默认空，不自动公开工具返回值。UI 任务失败或满载保留普通文字回答。

前端“交互组件”另有三个模式：关闭走普通文字；自动根据公开问题、回答和授权数据按需生成；始终在符合条件的持久化回合尝试生成，仍可返回空面板。用户本轮明确要求纯文字时跳过 UI。自动是有界中英文规则，不是通用意图分类模型；它不改变服务端 `generation` 配置。临时会话不启用持久化交互。

首次使用为关闭。普通会话保存自己的选择，新建页可在首条消息前选模式，并继承同一服务最近一次明确选择；刷新会恢复已保存选择。偏好按服务地址隔离，缺少能力或组件库哈希不匹配时不启用。清除浏览器站点数据会清除偏好，不提供跨设备同步。细节见 [模式与新建会话](openui-auto-validation.md)。

## 现有组件与动作边界

组件库共八个组件，模型从受控组件中组合，不能生成任意网页或执行 JavaScript。

| 组件 | 能力与限制 |
| --- | --- |
| Panel | 最多六个子组件，可补充回答或受控替代重复展示；原文保留可展开入口 |
| Text | 简短说明及必要的数据范围、结论和限制 |
| Choices | 两到四个选项或确认回复，点击后发送到当前会话 |
| Form | 一到十二字段，支持文本、数字、日期、下拉、单选、多选、选填、前序选项条件；整表发送到当前会话 |
| Followup | 自由文本跟进，草稿需显式保存 |
| DataTable | 授权快照，最多五十行、八列；本地筛选和排序无需模型调用 |
| DataChart | 柱状、折线、占比图，最多三个数值系列；占比只允许一个非负系列 |
| MetricValue | 仅展示未截断的单条结果中的数值字段 |

表格、图表和指标仅消费授权快照；已捕获行不能代表完整数据库，展示层不猜单位、不聚合、不将文本数字强转为数值。数字表单值保留字符串形式，日期为有效的 `YYYY-MM-DD`，不推测业务上下限。图表空值是缺口，不补零。详见 [数据组件与字段](openui-data-components-validation.md)。

普通选项、表单和记录分析通过原 Session 发起新 Agent 回合，沿用原工具权限。直接只读 Query 目前仅覆盖已有会话搜索表格的刷新与详情，不能由浏览器指定任意工具；直接 Mutation 仅支持当前会话标题，必须先预览再确认。普通“确认”回复不授予业务写入权限，不存在通用 MCP 写操作入口。见 [只读查询](openui-query-validation.md) 与 [标题修改](openui-rename-validation.md)。

## 工具展示适配

只配置实际已授权工具和允许公开的字段。以下是现有只读工具的适配示例，将其合入 `channels.websocket.openui.tables`：

```json
{
  "search_sessions": {
    "title": "相关会话",
    "recordsKey": "results",
    "idField": "session_key",
    "columns": {"title": "标题", "updated_at": "更新时间"}
  }
}
```

`recordsKey` 默认 `records`，`idField` 默认 `id`，`maxRows` 默认 50、范围 1–50；`title` 和一到八列的 `columns` 必填。记录标识必须为唯一字符串；输入必须是有界 JSON 数组或包含记录数组的对象。超过捕获行数会明确保留总行数；非法字段、身份或类型拒绝适配，原生回答仍可查看。配置展示白名单不会扩大工具权限，也不会自动公开历史正文。实际照明工具名、返回结构和字段权限尚未提供，不在本次虚构业务配置。

## 草稿、恢复与故障处理

获准的非敏感 Form 字段可声明 `persist:true`，停止编辑约 500ms 后保存；未声明字段留在组件内存，刷新可能丢失。个人调查答案不应默认保存草稿。用户显式提交的答案仍作为普通会话消息保存，“不保存草稿”不代表已发送内容匿名或不留历史。只有已确认保存的数据保证恢复；Followup 沿用显式保存。保存冲突或失败保留页面输入并提示重试。

UI sidecar 为运行数据目录中的 `openui.sqlite3`，当前数据库 schema 为 2；原生会话仍由已有 SessionState 管理。原生答案先持久化，UI 快照先提交再发送；订阅恢复读取快照，不重新运行模型或业务工具。重启后遗留生成任务标记为 `UI_STREAM_INTERRUPTED`；订阅和动作入口核对同代次的答案锚点，移除失去锚点的孤立视图。

提交与标题修改保留动作身份和回执，重复请求不能再次入队或写入。执行结果为 unknown 时必须先查看会话或查询结果，不换新 ID 自动重放。此约定不保证任意业务工具 exactly-once，也不保证原生存储和 sidecar 的跨库原子事务。

模型凭据和冻结运行时只在内存保留；进程重启或缓存淘汰后重试旧模型视图会返回 `UI_MODEL_UNAVAILABLE`，不会改用当前模型或重跑业务回合。已经完成的兼容视图仍可恢复；需要重新生成时由用户明确发起新回合。旧组件库哈希的历史视图降级为原文，不加载历史远端代码。

不支持的未来数据库 schema 只禁用 OpenUI，普通聊天继续；不自动降级改写或删除该数据。关闭功能可将 `channels.websocket.openuiEnabled` 设为 false，并按原部署方式重启，保留会话、侧栏和 sidecar。回滚代码前核对持久化格式，旧安装不支持新格式时保持功能关闭或使用支持该格式的版本；关闭功能不等于数据库迁移。前后端组件清单需要一起部署。

## SDK 与组件库升级

先在 develop 派生功能分支中修改明确锁定的 SDK/组件依赖；沿用现有组件和协议，不引入第二个生成或执行系统。清单及依赖锁文件在 GitHub Actions 生成，本地不运行生成、测试或构建：

```bash
gh workflow run openui.yml --ref codex/your-feature -f refresh_manifest=true
```

从对应运行下载 `openui-generated-manifest`，审查并提交 `nanobot/openui/generated/chat-library.json`、`webui/bun.lock` 和 `webui/package-lock.json`。之后用普通 PR 检查验证冻结依赖、清单一致性、React 18 渲染、动作、恢复、类型、浏览器、wheel 和容器；生成动作本身不替代最终提交的完整验证。合入 develop 后按固定 SHA 部署前后端，不发布到 main 或 stable。

## 官方稳定版兼容检查

`main` 只跟踪上游最新，`stable` 只跟踪官方稳定基线，定制开发与发布候选来自 develop。本批不更新任一上游跟踪分支，也不实际升级运行实例。手动执行：

```bash
gh workflow run upstream-stable.yml --ref develop
```

工作流只读取固定官方仓库 `HKUDS/nanobot` 的最新正式 Release，验证 stable 对应官方正式标签和共同祖先，然后在临时 detached worktree 对固定 develop SHA 试合并。报告记录基线、目标和候选完整 SHA、两侧重叠文件及冲突路径。

| 结果 | 含义与下一步 |
| --- | --- |
| up_to_date | develop 已包含目标版本，本次不重复合并，不据此认定业务验收通过 |
| conflicts | 保留冲突报告，阻止候选回归；另开 develop 功能分支人工评估和解决升级 |
| mergeable | 生成临时候选 bundle，按不可变 artifact ID 和精确 SHA 复用 OpenUI 回归；回归通过后才报告检查通过 |
| 工具或回归失败 | 检查未通过，查看失败步骤与报告；不把无文件冲突等同于兼容 |

报告 artifact 保留 14 天，候选 bundle 保留 7 天；bundle 只用于本次 CI，不自动推送、建升级 PR、修改 stable、部署或发布。PR 检查使用 PR 自身合并提交验证 bundle 传递及精确 SHA 执行链路，不冒充官方升级验收。需要实际升级时，在独立评审的功能分支处理冲突、核对依赖和持久化格式，再完成相应回归与部署验收。

仓库当前默认分支为 main，该检查放在 develop，未配置 schedule，也不宣称自动定时检查已运行。手动 dispatch 必须能在 GitHub 识别到该工作流；若 GitHub 尚未注册入口，应先检查本工作流 PR 运行记录，不通过更改 main 或默认分支绕开限制。工作流不使用真实业务凭据或生产实例。

## 验证证据与未完成项

运行时基线的 [GitHub Actions 42826811324](https://github.com/yuklcool/nanobot/actions/runs/42826811324) 验证了 428 个 Python、308 个前端、16 个浏览器用例及构建、wheel 和容器；它是上一批运行时证据，不是本批升级工作流的执行结果。真实模型的历史样本与失败边界见 [模型验收记录](openui-live-validation.md) 及各阶段说明，不能据此宣布所有模型和业务都已通过。

本批工具测试、workflow 校验、候选传递回归与官方目标试合并结果以 PR 最终提交对应的 GitHub Actions 为准。业务 MCP/照明字段绑定、真实数据效果与权限、固定发布候选的完整 P0–P3/AT 矩阵仍需后续验收；不为等待这些资料新增通用业务框架。
