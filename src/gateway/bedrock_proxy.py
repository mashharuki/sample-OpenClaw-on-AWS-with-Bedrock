#!/usr/bin/env python3
"""
OpenClaw マルチテナントプラットフォーム向け Bedrock Converse API プロキシ。

Gateway OpenClaw とテナントルーター間に位置する。OpenClaw からの Bedrock Converse API
呼び出しをインターセプトし、ユーザーメッセージとセッションコンテキストを抽出して
テナントルーター (AgentCore microVM を呼び出す) に転送し、Bedrock Converse API
フォーマットでレスポンスを返す。

Gateway OpenClaw は Bedrock と通信していると認識する。OpenClaw のコード変更は不要。

使用方法:
    export TENANT_ROUTER_URL=http://127.0.0.1:8090
    python3 bedrock_proxy.py  # ポート 8091 でリッスン

次に OpenClaw の設定を行う:
    openclaw config set models.providers.amazon-bedrock.baseUrl http://localhost:8091
"""
import json
import logging
import os
import re
import time
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [bedrock-proxy] %(message)s",
)
logger = logging.getLogger(__name__)

PORT = int(os.environ.get("PROXY_PORT", 8091))
TENANT_ROUTER_URL = os.environ.get("TENANT_ROUTER_URL", "http://127.0.0.1:8090")


def extract_user_message(converse_body: dict) -> tuple:
    """Converse API リクエストから最新のユーザーメッセージテキストとセッションコンテキストを抽出する。

    (user_message, channel, user_id) タプルを返す。
    """
    messages = converse_body.get("messages", [])
    system_parts = converse_body.get("system", [])

    # 最後のユーザーメッセージを検索
    user_text = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", [])
            parts = []
            for block in content:
                if isinstance(block, dict) and "text" in block:
                    parts.append(block["text"])
                elif isinstance(block, str):
                    parts.append(block)
            user_text = " ".join(parts).strip()
            break

    # システムプロンプトまたはメッセージメタデータから channel/user_id を抽出しようとする
    # OpenClaw は "Session: telegram:+1234567890" のようなセッション情報を含む
    channel = "unknown"
    user_id = "unknown"

    # セッションルーティング情報をシステムプロンプトから検索
    system_text = " ".join(
        p.get("text", "") if isinstance(p, dict) else str(p)
        for p in system_parts
    )

    # パターン: "channel: telegram"、"source: whatsapp"、または "agent:main:telegram:+123" のようなセッションキー
    ch_match = re.search(
        r'(?:channel|source|platform)[:\s]+(\w+)', system_text, re.IGNORECASE
    )
    if ch_match:
        channel = ch_match.group(1).lower()

    # パターン: 電話番号、Telegram ID、Discord ID
    id_match = re.search(
        r'(?:sender|from|user|recipient|target)[:\s]+([\w@+\-.]+)',
        system_text, re.IGNORECASE,
    )
    if id_match:
        user_id = id_match.group(1)

    # フォールバック: システムプロンプトのハッシュから導出 (一貫した tenant_id を保証)
    if user_id == "unknown":
        # システムプロンプトのハッシュを安定した識別子として使用
        # これにより同じ「ユーザー」は常に同じテナントにマッピングされる
        prompt_hash = hashlib.md5(system_text[:500].encode()).hexdigest()[:12]
        user_id = f"sys-{prompt_hash}"

    return user_text, channel, user_id


def build_converse_response(response_text: str, model_id: str = "proxy") -> dict:
    """プレーンテキストから Bedrock Converse API レスポンスを構築する。"""
    return {
        "output": {
            "message": {
                "role": "assistant",
                "content": [{"text": response_text}],
            }
        },
        "stopReason": "end_turn",
        "usage": {
            "inputTokens": 0,
            "outputTokens": len(response_text.split()),
            "totalTokens": len(response_text.split()),
        },
        "metrics": {
            "latencyMs": 0,
        },
    }


def build_converse_stream_response(response_text: str) -> list:
    """Bedrock ConverseStream イベントチャンクを構築する。"""
    events = []
    # messageStart
    events.append(json.dumps({"messageStart": {"role": "assistant"}}) + "\n")
    # contentBlockStart
    events.append(json.dumps({"contentBlockStart": {"start": {"text": ""}, "contentBlockIndex": 0}}) + "\n")
    # contentBlockDelta (全テキスト)
    events.append(json.dumps({
        "contentBlockDelta": {
            "delta": {"text": response_text},
            "contentBlockIndex": 0,
        }
    }) + "\n")
    # contentBlockStop
    events.append(json.dumps({"contentBlockStop": {"contentBlockIndex": 0}}) + "\n")
    # messageStop
    events.append(json.dumps({
        "messageStop": {"stopReason": "end_turn"},
    }) + "\n")
    # metadata
    events.append(json.dumps({
        "metadata": {
            "usage": {"inputTokens": 0, "outputTokens": len(response_text.split()), "totalTokens": len(response_text.split())},
            "metrics": {"latencyMs": 0},
        }
    }) + "\n")
    return events


class BedrockProxyHandler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        logger.info(fmt, *args)

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len)

        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._respond(400, {"message": "Invalid JSON"})
            return

        # Bedrock Converse API パス:
        # POST /model/<model-id>/converse
        # POST /model/<model-id>/converse-stream
        path = self.path
        is_stream = "converse-stream" in path

        logger.info("Request: %s (stream=%s)", path, is_stream)

        # ユーザーメッセージとルーティング情報を抽出
        user_text, channel, user_id = extract_user_message(data)
        if not user_text:
            logger.warning("No user message found in request")
            resp = build_converse_response("I didn't receive a message. Could you try again?")
            self._respond(200, resp)
            return

        logger.info("Routing: channel=%s user=%s msg=%s", channel, user_id, str(user_text)[:60])

        # テナントルーターへ転送
        try:
            tr_resp = requests.post(
                f"{TENANT_ROUTER_URL}/route",
                json={
                    "channel": channel,
                    "user_id": user_id,
                    "message": user_text,
                },
                timeout=300,
            )
            result = tr_resp.json()
            # テナントルーターは {"tenant_id": "...", "response": <agentcore_result>} を返す
            # AgentCore の結果は {"response": "text", "status": "success", ...}
            agent_result = result.get("response", {})
            if isinstance(agent_result, dict):
                response_text = str(agent_result.get("response", agent_result.get("error", "No response")))
            else:
                response_text = str(agent_result)
        except Exception as e:
            logger.error("Tenant Router error: %s", e)
            response_text = "I'm having trouble connecting right now. Please try again in a moment."

        logger.info("Response: %s", str(response_text)[:80])

        if is_stream:
            # ストリーミングイベントとして返す (改行区切り JSON)
            events = build_converse_stream_response(response_text)
            response_body = "".join(events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.amazon.eventstream")
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)
        else:
            resp = build_converse_response(response_text)
            self._respond(200, resp)

    def do_GET(self):
        # ヘルスチェック
        if self.path == "/ping" or self.path == "/":
            self._respond(200, {"status": "healthy", "service": "bedrock-proxy"})
        else:
            self._respond(404, {"message": "not found"})

    def _respond(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    server = HTTPServer(("0.0.0.0", PORT), BedrockProxyHandler)
    logger.info("Bedrock Proxy listening on port %d", PORT)
    logger.info("Tenant Router: %s", TENANT_ROUTER_URL)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
