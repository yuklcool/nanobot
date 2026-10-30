"""Check a running container's real WebUI and authenticated OpenUI capability."""

import asyncio
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

import websockets

import nanobot


def bootstrap():
    opener = build_opener(ProxyHandler({}))
    base = os.environ.get("NANOBOT_TEST_BASE_URL", "http://127.0.0.1:8765")
    try:
        opener.open(base + "/webui/bootstrap", timeout=5)
    except HTTPError as exc:
        assert exc.code == 401, exc.code
    else:
        raise AssertionError("Unauthenticated bootstrap was allowed")
    request = Request(base + "/webui/bootstrap", headers={"Authorization": "Bearer " + os.environ["NANOBOT_TEST_WEB_SECRET"]})
    with opener.open(request, timeout=5) as response:
        payload = json.load(response)
    with opener.open(base + "/", timeout=5) as response:
        assert response.status == 200 and b"<html" in response.read().lower()
    return payload


async def probe(payload):
    manifest = json.loads((Path(nanobot.__file__).parent / "openui/generated/chat-library.json").read_text())
    url = payload["ws_url"] + "?" + urlencode({"client_id": "container-smoke", "token": payload["token"]})
    async with websockets.connect(url, proxy=None, open_timeout=5) as ws:
        ready = json.loads(await asyncio.wait_for(ws.recv(), 5))
        assert ready["event"] == "ready"
        assert ready["openui"] == {"protocol": 1, "library_hash": manifest["library_hash"]}
    print("Container WebUI, authentication and OpenUI capability passed")


if __name__ == "__main__":
    asyncio.run(probe(bootstrap()))
