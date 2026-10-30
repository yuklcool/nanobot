"""Exercise an installed wheel with the real Gateway and provider HTTP adapter.

The HTTP provider is a deterministic local test server. No credentials, user
configuration, or production data are read. Run outside the checkout by passing
an already installed target directory as the only argument.
"""

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

import websockets


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ProviderHandler(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        ui = "Generate only OpenUI Lang" in json.dumps(body.get("messages", []))
        self.calls.append((ui, body.get("tools")))
        content = (
            '$question = ""\nroot = Panel([heading, followup])\n'
            'heading = Text("Packaged UI")\nfollowup = Followup($question)\n'
        ) if ui else "Real gateway provider response"
        self.send_response(200)
        if body.get("stream"):
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, reason in (({"role": "assistant", "content": content}, None), ({}, "stop")):
                chunk = {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                         "model": "test-only", "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            result = {"id": "fixture", "object": "chat.completion", "created": 1, "model": "test-only",
                      "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                      "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
            self.wfile.write(json.dumps(result).encode())


async def socket_check(payload, expected_hash):
    url = payload["ws_url"] + "?" + urlencode({"client_id": "installed-smoke", "token": payload["token"]})
    async with websockets.connect(url, proxy=None, open_timeout=5) as ws:
        event = json.loads(await asyncio.wait_for(ws.recv(), 5))
        assert event["event"] == "ready"
        assert event["openui"] == {"protocol": 1, "library_hash": expected_hash, "modes": ["markdown", "openui", "auto"]}
        chat_id = event["chat_id"]
        await ws.send(json.dumps({"type": "webui_request", "request_id": "subscribe", "action": "openui.subscribe",
                                  "payload": {"chat_id": chat_id, "turn_ids": []}}))
        while True:
            event = json.loads(await asyncio.wait_for(ws.recv(), 5))
            if event.get("request_id") == "subscribe":
                assert event.get("ok"), event
                break
        await ws.send(json.dumps({"type": "message", "chat_id": chat_id, "turn_id": "packaged-turn",
                                  "content": "hello", "webui": True, "ui_mode": "openui"}))
        events = []
        for _ in range(100):
            event = json.loads(await asyncio.wait_for(ws.recv(), 15))
            events.append(event)
            if event.get("event") == "openui.snapshot" and event["snapshot"]["status"] != "streaming":
                assert event["snapshot"]["status"] == "complete", event
                assert "Packaged UI" in event["snapshot"]["source"], event
                assert any(row.get("event") == "turn_end" for row in events), events
                break
        else:
            raise AssertionError("No completed UI snapshot")
        await ws.send(json.dumps({"type": "webui_request", "request_id": "restore", "action": "openui.subscribe",
                                  "payload": {"chat_id": chat_id, "turn_ids": ["packaged-turn"]}}))
        while True:
            event = json.loads(await asyncio.wait_for(ws.recv(), 5))
            if event.get("request_id") == "restore":
                assert event.get("ok") and event["result"]["blocks"][0]["status"] == "complete", event
                break


def main(installed_root):
    installed_root = Path(installed_root).resolve(strict=True)
    ProviderHandler.calls.clear()
    with tempfile.TemporaryDirectory(prefix="openui-deploy-smoke-") as temp:
        root = Path(temp)
        ws_port, gateway_port = free_port(), free_port()
        while gateway_port == ws_port:
            gateway_port = free_port()
        provider_server = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
        threading.Thread(target=provider_server.serve_forever, daemon=True).start()
        config = {
            "agents": {"defaults": {"workspace": str(root / "workspace"), "model": "openai/test-only",
                                    "provider": "openai", "dream": {"enabled": False}}},
            "providers": {"openai": {"apiKey": "test-only", "apiBase": f"http://127.0.0.1:{provider_server.server_port}/v1"}},
            "gateway": {"host": "127.0.0.1", "port": gateway_port, "heartbeat": {"enabled": False}},
            "channels": {"websocket": {"enabled": True, "host": "127.0.0.1", "port": ws_port,
                                       "tokenIssueSecret": "test-only-secret", "openuiEnabled": True,
                                       "openui": {"generation": "model"}}},
            "tools": {"restrictToWorkspace": True},
        }
        path = root / "config.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        env = {**os.environ, "HOME": str(root), "PYTHONPATH": str(installed_root), "NO_PROXY": "*", "no_proxy": "*"}
        source = subprocess.check_output([sys.executable, "-c", "import nanobot; print(nanobot.__file__)"],
                                         cwd=root, env=env, text=True).strip()
        assert Path(source).is_relative_to(installed_root), source
        log = root / "gateway.log"
        with log.open("w", encoding="utf-8") as out:
            child = subprocess.Popen([sys.executable, "-m", "nanobot", "gateway", "--foreground", "--config", str(path)],
                                     cwd=root, env=env, stdout=out, stderr=subprocess.STDOUT)
            try:
                opener = build_opener(ProxyHandler({}))
                deadline = time.monotonic() + 30
                while True:
                    try:
                        req = Request(f"http://127.0.0.1:{ws_port}/webui/bootstrap",
                                      headers={"Authorization": "Bearer test-only-secret"})
                        with opener.open(req, timeout=1) as response:
                            payload = json.load(response)
                        break
                    except OSError:
                        if child.poll() is not None or time.monotonic() >= deadline:
                            raise RuntimeError("Gateway failed to start:\n" + log.read_text(encoding="utf-8")[-5000:])
                        time.sleep(0.2)
                with opener.open(f"http://127.0.0.1:{ws_port}/", timeout=3) as response:
                    assert response.status == 200 and b"<html" in response.read().lower()
                manifest = json.loads((installed_root / "nanobot/openui/generated/chat-library.json").read_text())
                asyncio.run(socket_check(payload, manifest["library_hash"]))
                probe_env = {**env, "NANOBOT_TEST_WEB_SECRET": "test-only-secret",
                             "NANOBOT_TEST_BASE_URL": f"http://127.0.0.1:{ws_port}"}
                subprocess.run([sys.executable, str(Path(__file__).with_name("container_gateway_probe.py"))],
                               cwd=root, env=probe_env, check=True, timeout=15)
                assert any(not ui for ui, _ in ProviderHandler.calls)
                assert any(ui and not tools for ui, tools in ProviderHandler.calls)
                print("Installed Gateway, bundled WebUI, provider adapter, OpenUI and snapshot restore passed")
            finally:
                if child.poll() is None:
                    child.send_signal(signal.SIGINT)
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                provider_server.shutdown()
                provider_server.server_close()


if __name__ == "__main__":
    main(sys.argv[1])
