# OpenUI P0：首批实现与验证记录

关联：[#1](https://github.com/yuklcool/nanobot/issues/1)、[详细设计](openui-integration-design.md)。验证日期：2026-10-29 UTC。状态：**P0 进行中，尚未满足完整 P0 放行条件，不进入 P1 发布集成**。

本批代码交付可执行的 SDK 演示、快照存储和自动化测试。正式聊天界面尚未挂载 Renderer，Gateway 尚未注册 OpenUI 协议或启动 UI 生成任务。下面分别列出已执行证据与未验证部分，不能将分层测试视为真实浏览器到模型的完整闭环。

## 1. 基线与兼容矩阵

| 项目 | 本次实际值 | 结论 |
| --- | --- | --- |
| 功能分支 | `feature/openui-p0`，目标 `develop` | 未直接修改 stable/main |
| develop 起点 | `d79a1546561ebd326b7c39e1f25896f166693713` | 包含文档 PR #2 |
| stable | `8f7a7d17590de7ab187650381894dba2b9e060ab` | 延用设计中核定的官方 v0.4.0 基线 |
| main | `cb3ba4531761b49f61568754eb3d3ce84db4b75d` | 相对 stable 领先 12 个提交；本批未进行发布合并验收 |
| `@openuidev/react-lang` / `@openuidev/lang-core` | 均精确锁定 `1.0.2` | 使用 npm 发布物，没有修改 SDK 源码 |
| Zod | 精确锁定 `4.4.3` | 保留仓库原锁文件已有版本，提升为直接依赖 |
| React / React DOM | `18.3.1` | 真实 Renderer 的 DOM 测试通过 |
| Vite / TypeScript | `5.4.21` / `5.9.3` | 主应用与独立 PoC 均可构建；类型检查通过 |
| Bun | `1.3.13` | 更新 bun.lock，冻结锁文件安装通过；同时更新 package-lock.json |
| Python | `3.12` | 使用项目现有 dev 依赖；没有新增 Python 第三方依赖 |
| Chromium | 尝试 `134.0.6998.35` | 启动被当前执行环境的 socket 限制阻断，浏览器验收未通过 |

## 2. 本批实现

### 2.1 受控 Renderer 与真实 SDK 演示

`webui/src/openui/poc-library.tsx` 注册 Panel、Text、Period、Inspect 四个最小组件。Text 使用 React 文本节点；组件库没有 HTML、URL、脚本或任意工具入口。Period 使用 SDK reactive binding 和 `useStateField().setValue()`；Inspect 通过 `useStateField()` 解析最新值，再交给 `useTriggerAction()`。实测不能直接把 reactive prop 当作 `{ value }` 读取，该错误已由动作测试发现并修复。

`OpenUIPocBlock.tsx` 在流式阶段禁用动作，完成后允许交互；解析失败、取消、失败和不兼容组件库显示文字回退。相同 block/revision 的增量保留组件实例；新 revision 重建组件状态和错误边界。Renderer 设置 `publishObservability={false}`，未配置 `toolProvider`。SDK 的 Query/Mutation 代理尚未验证或启用。

`webui/browser/openui.html` 是独立开发夹具，通过“Advance stream”逐段注入确定性 Lang，经过现有 `useNanobotStream.send()` 和 `NanobotClient` 回传动作。该夹具中的 localStorage 仅模拟快照 API；它不是服务端持久化实现，也没有注册生产能力标识。`nanobot-openui-poc-v1` 是本夹具的版本标识，虽然位于拟议字段 `library_hash` 中，但不是构建产物哈希。P1 接入前必须生成实际 spec/prompt/hash，不能沿用这个常量作为完整性证明。

### 2.2 增量与恢复状态

`snapshot.ts` 验证 schema、会话 generation、block、turn、组件库和 revision；重复/过期 delta 被忽略，序列缺口请求权威快照，完成后迟到 delta 不再改变内容。源内容限制为 128 KiB，状态限制为 16 KiB。独立 `state_version` 允许完成后的表单保存，不推动源内容的 `seq`。尚未把这些函数连接到宿主 WebSocket decoder、重连和历史分页。

### 2.3 UI 附属 SQLite 存储

`nanobot/openui/snapshots.py` 使用独立 SQLite、WAL 和 FULL 同步，按可信 owner/session key/generation/block 隔离快照。源流更新和状态保存均使用事务及版本比较；状态仅允许显式登记的顶层键。generation 删除写入 tombstone，阻止延迟任务在重启后重新创建已删除 generation 的卡片。schema 版本不支持时拒绝打开，不静默覆盖。

该存储是底层原语，不提供身份验证、资源级授权、状态字段业务校验、事件 outbox、任务恢复或双库原子性。宿主需要从可信身份与 SessionState 构造 scope，并在线程中调用同步 API；数据库路径、目录权限、备份和清理策略也需要宿主接入。当前尚未建立这些生产调用点。

### 2.4 原生 Agent 验证

`tests/openui/test_native_turn.py` 使用真实 AgentLoop、ToolRegistry、工具执行、Hook、MessageBus 和原生会话存储，Provider 为确定性离线替身。第一轮执行测试工具；`after_execute_tool` 获取结果；`SessionTurnPersisted` 订阅者读取已提交会话并保存关联 turn/generation 的 UI 快照。关闭并重新创建 AgentLoop 和 UI store 后，第二轮携带恢复的 period=30 意图进入同一会话，保留前轮工具结果，并再次执行测试工具。此测试没有真实外部模型调用、MCP 或浏览器网络连接。

前端另有真实 Renderer → `useNanobotStream.send()` → `NanobotClient` → 内存 WebSocket 的联动测试，断言 chat_id 未改变、生成 turn_id、只产生一次 message、参数为恢复后的表单值。两项测试分别验证前后端边界；尚未连成原生 Gateway 的单条 E2E 链路。

## 3. 已执行验证

| 验证 | 结果与范围 |
| --- | --- |
| `pytest tests/openui` | 9 项通过：存储 8 项、原生两轮/重启集成 1 项 |
| 原有 turn hooks / composite hooks / direct websocket status / runner hooks | 50 项通过；与新增测试合计 59 项 |
| OpenUI Vitest | 11 项通过：真实 SDK 流式渲染、禁用时序、状态恢复、动作与现有 sender 联动、错误回退、spec prompt、增量与 schema |
| 原有 `nanobot-client` / `useNanobotStream` Vitest | 211 项通过；与新增测试合计 222 项 |
| TypeScript 应用和 browser 配置 | 通过 |
| Python 新模块 basedpyright；改动文件 Ruff / ESLint | 通过 |
| Python / WebUI import boundaries | 通过 |
| import checker 自测 | 41 通过、1 个 Windows 专属测试跳过；首次默认 5 秒超时，按 30 秒上限复跑通过 |
| 主 WebUI production build | 通过；现有大 chunk 警告仍在 |
| 独立 PoC production bundle | 通过，实际包含 OpenUI SDK；不是仅检查未被主入口引用的文件 |
| Playwright `browser/openui.spec.ts` | 2 项均在浏览器启动前受阻，不能记为通过 |

浏览器限制的具体证据：项目 Playwright 默认 Chromium 下载返回损坏 ZIP；备用 Chromium 134 下载成功，但启动时报 `process_singleton_posix.cc: socket() failed: Operation not permitted`。没有通过降低环境权限限制绕过此问题。保留 Playwright 用例，待能正常启动 Chromium 的开发机/CI 复跑。现有 pytest fixture scope 弃用提示、已有 useNanobotStream 测试的 act 提示也仍存在。

### 可复现命令

在仓库根目录安装项目既有 dev 依赖，然后执行：

```bash
uv venv .venv
uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/python -m pytest tests/openui tests/agent/test_turn_hooks.py tests/agent/test_hook_composite.py tests/agent/test_loop_direct_websocket_status.py tests/agent/test_runner_hooks.py -q
.venv/bin/ruff check nanobot/openui tests/openui
.venv/bin/basedpyright nanobot/openui
.venv/bin/python -m scripts.check_import_boundaries
```

在 `webui/` 目录执行；无全局 Bun 时可使用 `npx --yes bun@1.3.13`：

```bash
bun install --frozen-lockfile
bun run typecheck
bun x tsc -p tsconfig.browser.json
bun run test -- src/tests/openui src/tests/nanobot-client.test.ts src/tests/useNanobotStream.test.tsx
bun run check:imports
bun test ../scripts/check_client_import_boundaries.test.mjs --timeout 30000
bun run lint
bun run build
```

本次 ESLint 仅执行新增源代码、夹具及新增测试文件；上面的全量 `lint` 命令供后续完整验证使用，不表示本批跑过全库 lint。

独立 SDK bundle（在 `webui/` 执行，不改变正式应用入口）：

```bash
node --input-type=module - <<'JS'
import { build } from 'vite';
await build({ build: { outDir: '/tmp/nanobot-openui-poc', emptyOutDir: true, rollupOptions: { input: 'browser/openui.html' } } });
JS
```

本地演示：`bun run dev` 后访问 `/browser/openui.html`。流式和表单状态可演示；动作网络由 Playwright 的测试 WebSocket 提供，Vite 本身不提供 Agent 服务。不要把该地址当成已经接入生产聊天的功能。浏览器复验命令：`bun run test:browser -- browser/openui.spec.ts`，可按仓库惯例用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向可用的 Chromium。

## 4. 关键决策与待完成的接入点

1. **保留原生 Agent 主循环。** 本批没有修改 loop、Provider、会话投影或 WebSocket 核心文件。实测已有 turn hook factory 和持久化事件足够做结果观察，但不能因此断言生产 UI 生命周期接入已经完整。
2. **持久化事件不等于最终消息投递。** 实测顺序是工具 Hook → `after_run` → `SessionTurnPersisted`。持久化时尚不能假定最终可见回答已交付；后续协调器需要绑定已持久化的 turn 和最终展示锚点，验证多段回答、重试及恢复后的唯一映射。`after_run` 不能用作 durable UI complete。
3. **当前输入去重不能证明重启后的幂等。** `webui/inbound_commands.py` 的 accepted message 缓存及 request operation 缓存是内存记录。Agent 动作需要持久化 action admission/request ID/参数摘要与入队协调，明确崩溃窗口；Query/Mutation 还需要各自的资源权限、版本和副作用回执。不得把本批单次点击测试宣称为双击、断线重试或崩溃后的 exactly-once。
4. **权限从宿主继承。** store 的 owner 是可信调用参数，不是认证机制。下一步需要映射宿主身份、workspace scope、generation 和资源授权，并补充越权请求测试。固定只读 fixture action 与参数白名单只用于验证 SDK 回调。
5. **增量协议尚未协商。** P0 尚需验证新 namespace 穿过 client contract/decoder、附着/重连、旧客户端降级，以及 UI 取消/会话删除订阅的注册和释放。本批 tombstone 测试证明存储行为，不证明原生删除事件已接通。
6. **组件库产物要来自构建。** 已实测 library.prompt() 可生成规范，下一步输出版本化 manifest/spec/prompt 与哈希并打入前后端包；需验证 Query/Mutation 的 toolProvider API、历史模式和后端代理，不能直接暴露 ToolRegistry。
7. **继续 P0，再开始 P1。** 补齐真实浏览器 → 原生 Gateway → 确定性 Provider → 工具 → UI → 动作的同会话闭环，再用实际配置 Provider 检查生成质量、耗时与 token。没有在本批读取或配置用户模型凭证。

当前对 AT02/04/08/12/13/14/15/16/17/19 提供了组件、存储或原生会话层的部分证据；**没有把任何完整端到端 AT 项标为最终通过**。鉴权、幂等、Query/Mutation、历史分页、组合取消、双库崩溃恢复、真实模型、Docker 与 release-candidate 验收均待后续完成。

## 5. 上游维护与回退

已有文件仅修改 `webui/package.json`、两份锁文件以及设计文档中的验证入口；运行时代码、测试和 PoC 说明均为新增文件。最可能的上游冲突是依赖清单/锁文件，按项目版本重解析即可；P1 增加宿主接入点时必须重新列出改动，不以本批零核心改动推断未来不会冲突。

PoC 未接入正式路由，没有创建生产数据库或执行迁移。回退本批提交即可移除演示和依赖。后续真实接入需要单独完成开关、数据保留/迁移与发布回退设计。main 的 12 个上游提交仍需最终无损合并及完整回归，不能用本分支证据代替。
