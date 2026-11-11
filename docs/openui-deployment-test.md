# OpenUI 真实应用测试部署

本说明从开发与发布主线 `develop` 构建隔离测试版本，运行真实 Nanobot Gateway 和 WebUI，连接由部署者配置的模型 Provider。它仍是实验功能，尚未正式发布；已有真实模型样本不能替代 P0/P1 完整验收及真实业务/MCP 验收。不要将其覆盖到现有生产实例或复用生产数据目录。当前配置、组件、故障恢复与升级检查见 [运行与维护说明](openui-integration.md)。

## 已实现与验证范围

当前交互模式为“关闭 / 自动 / 始终”。“自动”在普通解释中跳过 UI 请求，在明确选择、表单或授权数据场景按需生成；“始终”保留每回合尝试行为。首次使用为关闭；同一服务的会话记住已选模式，新建会话可在首条消息前选择并继承最近一次明确选择。兼容性、规则边界及现有只读工具的配置示例见 [自动模式与只读工具闭环](openui-auto-validation.md)。

开启 `channels.websocket.openuiEnabled` 后，WebUI 可为用户启用「交互组件」的普通持久化会话生成交互内容。`generation=model` 时，模型按内容选择快捷选项、确认按钮、简短表单或表格，组件直接接在原回答下面；不重复回答，不固定追加追问框，无需交互时不显示组件。点击选项、确认或提交表单会向当前会话发送用户消息。默认 `generation=preview` 不发起额外 UI 模型请求，只展示明确捕获的数据表格，没有表格的回合保持原生文字。设置 `generation=model` 时复用当前回合的 Provider，并增加一次独立 UI 模型请求。真实 Provider 的可用性、费用和具体模型生成质量需要使用部署者自己的配置验证。

表单支持一到十二字段，包括文本、数字、日期、下拉、单选、多选、选填和条件题。明确允许保存的非敏感字段自动保存草稿，未允许字段刷新可能丢失；自由文本 `Followup` 使用显式保存。表格可本地筛选排序，图表和指标只展示授权快照。普通确认按钮继续发送会话消息；直接写操作仅支持当前会话标题的预览与确认，不授予通用业务写入权限。刷新不自动再次提交。需一起部署后端与 WebUI；旧组件库哈希的历史视图保留原文，详见维护说明。

Python wheel 包含正式 WebUI 静态文件、OpenUI 清单和 Gateway，CI 在独立安装目录中启动它，并通过生产 OpenAI 兼容适配器、认证 WebSocket 和本地测试 HTTP 服务验证文字回答、UI 生成及快照恢复。该测试没有连接外部模型。CI 另行构建 Docker 镜像并启动容器验证 WebUI、认证和 OpenUI 能力；容器检查本身不验证模型生成。以当前 PR head 的 CI 日志为准，不把历史结果等同于当前版本结果。

## Docker 测试部署

以下示例适用于有 Docker 和 Git 的 Linux/macOS 测试主机，并以 OpenAI Provider 为例。可用其它已支持的 Provider 和模型替换该配置；配置字段以实际服务为准。本示例把端口只绑定在测试主机的 loopback，不对公网开放。

1. 克隆测试分支并构建独立测试镜像：

```bash
git clone -b develop --single-branch https://github.com/yuklcool/nanobot.git nanobot-openui-test
cd nanobot-openui-test
git rev-parse HEAD
docker build --build-arg NANOBOT_CHANNELS= -t nanobot-openui:test .
```

记录输出的完整 commit，测试结果应关联这个确切版本。若重建已验收版本，先检出所记录的提交，再构建；持续变化的 develop 分支头不自动等同于已验收版本。正式发布从 develop 的固定已验收提交产生，部署固定 tag、提交或镜像摘要；main 只跟踪上游最新，stable 只跟踪官方稳定基线。此构建不推送镜像，也不发布 tag 或 Release。

2. 创建独立数据目录与配置，填入自己的模型 API 凭据并生成 WebUI 登录口令。API key 留在部署环境中，不要提交到 Git 或发到聊天：

```bash
mkdir -p "$HOME/nanobot-openui-test-data"
chmod 700 "$HOME/nanobot-openui-test-data"
read -rs -p 'OpenAI API key: ' OPENAI_API_KEY; echo
export OPENAI_API_KEY
export NANOBOT_WEB_TOKEN="$(openssl rand -hex 32)"
printf 'WebUI 登录口令（请妥善保管）：%s\n' "$NANOBOT_WEB_TOKEN"
cat > "$HOME/nanobot-openui-test-data/config.json" <<'JSON'
{
  "agents": {"defaults": {
    "workspace": "/home/nanobot/.nanobot/workspace",
    "model": "openai/gpt-4o-mini",
    "provider": "openai"
  }},
  "providers": {"openai": {"apiKey": "${OPENAI_API_KEY}"}},
  "channels": {"websocket": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8765,
    "tokenIssueSecret": "${NANOBOT_WEB_TOKEN}",
    "openuiEnabled": true,
    "openui": {"generation": "model"}
  }},
  "tools": {"restrictToWorkspace": true}
}
JSON
```

上述 `${...}` 是 nanobot 的配置环境变量引用，容器启动时解析。更换模型或 Provider 时同步调整 `agents.defaults` 与 `providers`，并提供对应凭据。表格捕获还需要按真实工具名称和字段配置 adapter，见 [生成及数据配置](openui-generation-validation.md)；没有配置时仍可测试文字与跟进表单，不会自动展示任意工具原文。

3. 启动独立容器：

```bash
docker run -d --name nanobot-openui-test \
  -p 127.0.0.1:8765:8765 \
  -e OPENAI_API_KEY -e NANOBOT_WEB_TOKEN \
  -v "$HOME/nanobot-openui-test-data:/home/nanobot/.nanobot" \
  nanobot-openui:test \
  gateway --foreground --config /home/nanobot/.nanobot/config.json

docker logs -f nanobot-openui-test
```

在该主机上打开 `http://127.0.0.1:8765/`，使用当前终端里的 `NANOBOT_WEB_TOKEN` 登录。远程测试主机应先通过 SSH 将远端 8765 转发到本机；不要直接把此测试端口暴露到公网。新建普通会话，在“交互组件”中选择自动或始终，发送需要选择、表单或已配置数据的问题，再测试跟进、草稿和刷新恢复；普通解释可以只显示文字。重复数据可由组件受控替代，原回答仍可展开查看。用户请求和额外 UI 模型请求都走配置的真实 Provider。

停止容器：`docker stop nanobot-openui-test`。再次启动使用 `docker start nanobot-openui-test`；更改配置或环境变量后需按 Docker 的常规流程重建容器。测试会话和 UI sidecar 保存在上述独立目录中。

## 测试 wheel

OpenUI 工作流在构建、安装和 Gateway 测试通过后，生成包含 wheel 与 `SHA256SUMS` 的 GitHub Actions artifact（保留 7 天）。从对应当前 commit 的成功运行页面下载 artifact；它不是公开发布的 PyPI 包或正式 Release。wheel 的发行名和基础版本仍是上游的 `nanobot-ai 0.4.0`，因此必须在独立虚拟环境安装，不要直接覆盖现有生产安装。安装前可用 `sha256sum -c SHA256SUMS` 核对下载内容；部署配置与 Provider 要求同上。

## 当前边界

- 表单的单选、下拉和多选字段支持 2–50 个不同选项，多选值使用相同上限；超过 4 项的单选优先使用下拉框，超过 50 项先收窄查询条件。此前 8 类 RTU 报警触发了 6 项上限，导致交互视图不可用。修复同步更新生成提示、前后端校验与组件清单，不截断真实选项，也不改变工具权限；表单提交仍有 4000 字符总预算。前后端需一起更新，旧组件清单哈希的历史视图仍按既有规则保留原文，更新后应新建一轮查询验证。
- 外部模型质量、真实 MCP、资源级权限和写操作确认还没有验收。当前表格只展示明确配置的工具字段；没有通用业务 Mutation。
- UI 生成失败或超时保留原生文字；可重试 UI，但进程重启后原回合的模型运行时不在内存时不能重试该旧视图。
- 不支持将 P0/P1 标记为完成，也不等同于 develop 固定待发布提交及对应产物的完整候选验收。main 不作为本项目发布分支或发布合并目标。Docker 镜像构建、包安装及 Gateway smoke 结果必须逐次核对当前 CI。
