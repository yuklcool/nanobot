# OpenUI 真实应用测试部署

这是 `feature/openui-p0` 分支的隔离测试版本，运行真实 Nanobot Gateway 和 WebUI，连接由部署者配置的模型 Provider。它仍是草稿 PR 的实验功能，不是正式发布版；P0/P1 的完整验收、真实外部模型与 MCP 尚未完成。不要将其覆盖到现有生产实例或复用生产数据目录。

## 已实现与验证范围

开启 `channels.websocket.openuiEnabled` 后，WebUI 可为用户勾选的普通持久化会话生成交互视图，支持同会话跟进、草稿、快照恢复、表格本地筛选和记录分析。默认 `generation=preview` 不发起额外 UI 模型请求；设置 `generation=model` 时复用当前回合的 Provider，并增加一次独立 UI 模型请求。真实 Provider 的可用性、费用和具体模型生成质量需要使用部署者自己的配置验证。

Python wheel 包含正式 WebUI 静态文件、OpenUI 清单和 Gateway，CI 在独立安装目录中启动它，并通过生产 OpenAI 兼容适配器、认证 WebSocket 和本地测试 HTTP 服务验证文字回答、UI 生成及快照恢复。该测试没有连接外部模型。CI 另行构建 Docker 镜像并启动容器验证 WebUI、认证和 OpenUI 能力；容器检查本身不验证模型生成。以当前 PR head 的 CI 日志为准，不把历史结果等同于当前版本结果。

## Docker 测试部署

以下示例适用于有 Docker 和 Git 的 Linux/macOS 测试主机，并以 OpenAI Provider 为例。可用其它已支持的 Provider 和模型替换该配置；配置字段以实际服务为准。本示例把端口只绑定在测试主机的 loopback，不对公网开放。

1. 克隆测试分支并构建独立测试镜像：

```bash
git clone -b feature/openui-p0 --single-branch https://github.com/yuklcool/nanobot.git nanobot-openui-test
cd nanobot-openui-test
git rev-parse HEAD
docker build --build-arg NANOBOT_CHANNELS= -t nanobot-openui:test .
```

记录输出的 commit，测试结果应关联这个确切版本。此构建不推送镜像，也不发布 tag 或 Release。

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

在该主机上打开 `http://127.0.0.1:8765/`，使用当前终端里的 `NANOBOT_WEB_TOKEN` 登录。远程测试主机应先通过 SSH 将远端 8765 转发到本机；不要直接把此测试端口暴露到公网。打开普通持久会话，勾选“交互视图（预览）”，发送问题，确认普通回答和后续交互视图均出现，再测试跟进、草稿和刷新恢复。用户请求和额外 UI 模型请求都走配置的真实 Provider。

停止容器：`docker stop nanobot-openui-test`。再次启动使用 `docker start nanobot-openui-test`；更改配置或环境变量后需按 Docker 的常规流程重建容器。测试会话和 UI sidecar 保存在上述独立目录中。

## 测试 wheel

OpenUI 工作流在构建、安装和 Gateway 测试通过后，生成包含 wheel 与 `SHA256SUMS` 的 GitHub Actions artifact（保留 7 天）。从对应当前 commit 的成功运行页面下载 artifact；它不是公开发布的 PyPI 包或正式 Release。wheel 的发行名和基础版本仍是上游的 `nanobot-ai 0.4.0`，因此必须在独立虚拟环境安装，不要直接覆盖现有生产安装。安装前可用 `sha256sum -c SHA256SUMS` 核对下载内容；部署配置与 Provider 要求同上。

## 当前边界

- 外部模型质量、真实 MCP、资源级权限和写操作确认还没有验收。当前表格只展示明确配置的工具字段；没有通用业务 Mutation。
- UI 生成失败或超时保留原生文字；可重试 UI，但进程重启后原回合的模型运行时不在内存时不能重试该旧视图。
- 不支持将 P0/P1 标记为完成，也不等同于与 main 合并后的发布候选验收。Docker 镜像构建、包安装及 Gateway smoke 结果必须逐次核对当前 CI。
