"""
Gateway テナントルーター — OpenClaw Gateway と AgentCore Runtime を橋渡しする。

EC2 上で OpenClaw Gateway プロセスと並行して HTTP プロキシとして動作する。
OpenClaw の Webhook は受信メッセージをここに転送する。このモジュールは:
  1. チャネルとユーザー ID から tenant_id を導出する
  2. sessionId=tenant_id で AgentCore Runtime を呼び出す
  3. エージェントのレスポンスを OpenClaw に返して配信する

設計上の決定:
  - tenant_id フォーマット: {channel}__{user_id} (例: "wa__8613800138000")
  - ステートレス: すべての状態は AgentCore Runtime セッションと SSM に存在する
  - グレースフルフォールバック: AgentCore に接続できない場合はエラーを返す (ローカルフォールバックなし)
"""

import hashlib
import json
import logging
import os
import re
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional

import boto3
from botocore.exceptions import ClientError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

STACK_NAME = os.environ.get("STACK_NAME", "dev")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
RUNTIME_ID = os.environ.get("AGENTCORE_RUNTIME_ID", "")
ROUTER_PORT = int(os.environ.get("ROUTER_PORT", "8090"))

# テナント ID のバリデーション: 英数字、アンダースコア、ハイフン、ドット
_TENANT_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_.\-]{1,128}$")

# チャネル名の正規化
_CHANNEL_ALIASES = {
    "whatsapp": "wa",
    "telegram": "tg",
    "discord": "dc",
    "slack": "sl",
    "teams": "ms",
    "imessage": "im",
    "googlechat": "gc",
    "webchat": "web",
}


# ---------------------------------------------------------------------------
# テナント ID の導出
# ---------------------------------------------------------------------------

def derive_tenant_id(channel: str, user_id: str) -> str:
    """チャネルとユーザー ID から安定した安全な tenant_id を導出する。

    フォーマット: {channel_short}__{sanitized_user_id}__{hash_suffix}

    AgentCore は runtimeSessionId >= 33 文字を要求するため、ハッシュサフィックスを
    追加して最小長を保証しながら人間が読みやすい ID を維持する。

    例:
      - ("whatsapp", "8613800138000") → "wa__8613800138000__a1b2c3d4e5f6"
      - ("telegram", "123456789")     → "tg__123456789__f7e8d9c0b1a2"
    """
    channel_short = _CHANNEL_ALIASES.get(channel.lower(), channel.lower()[:4])
    sanitized = re.sub(r"[^a-zA-Z0-9_.\-]", "_", user_id.strip())

    # ハッシュサフィックスで AgentCore runtimeSessionId の最小 33 文字を保証
    # 19 桁の hex で短い channel+user の組み合わせでも 33 文字以上になる
    hash_suffix = hashlib.sha256(f"{channel}:{user_id}".encode()).hexdigest()[:19]
    tenant_id = f"{channel_short}__{sanitized}__{hash_suffix}"

    # 短い場合は最小 33 文字になるまでパディング
    while len(tenant_id) < 33:
        tenant_id += "0"

    if len(tenant_id) > 128:
        tenant_id = f"{channel_short}__{hash_suffix}"

    if not _TENANT_ID_PATTERN.match(tenant_id):
        raise ValueError(f"Invalid tenant_id derived: {tenant_id}")

    return tenant_id


# ---------------------------------------------------------------------------
# AgentCore Runtime の呼び出し
# ---------------------------------------------------------------------------

def _agentcore_client():
    from botocore.config import Config
    cfg = Config(
        read_timeout=300,
        connect_timeout=10,
        retries={"max_attempts": 0},
    )
    return boto3.client("bedrock-agentcore", region_name=AWS_REGION, config=cfg)


def invoke_agent_runtime(
    tenant_id: str,
    message: str,
    model: Optional[str] = None,
) -> dict:
    """テナント分離を用いて AgentCore Runtime を呼び出す。

    本番モード: AgentCore Runtime API を呼び出す (テナントごとに Firecracker microVM)。
    デモモード: ローカルのエージェントコンテナを直接呼び出す (AGENT_CONTAINER_URL 環境変数)。

    引数:
        tenant_id: 導出されたテナント識別子。sessionId として使用される
        message: ユーザーメッセージテキスト
        model: オプションのモデルオーバーライド

    戻り値:
        'response' キーを持つエージェントレスポンス辞書

    例外:
        RuntimeError: 呼び出しに失敗した場合
    """
    # デモモード: ローカルのエージェントコンテナを直接呼び出す
    local_url = os.environ.get("AGENT_CONTAINER_URL")
    if local_url:
        return _invoke_local_container(local_url, tenant_id, message, model)

    # 本番モード: AgentCore Runtime API を呼び出す
    if not RUNTIME_ID:
        raise RuntimeError(
            "AGENTCORE_RUNTIME_ID not configured. "
            "Set it in SSM or environment after creating the AgentCore Runtime."
        )

    return _invoke_agentcore(tenant_id, message, model)


def _invoke_local_container(
    base_url: str, tenant_id: str, message: str, model: Optional[str]
) -> dict:
    """ローカルのエージェントコンテナ server.py を直接呼び出す (デモ/テストモード)。"""
    import requests

    payload = {
        "sessionId": tenant_id,
        "tenant_id": tenant_id,
        "message": message,
    }
    if model:
        payload["model"] = model

    start = time.time()
    try:
        resp = requests.post(
            f"{base_url}/invocations",
            json=payload,
            timeout=300,
        )
        duration_ms = int((time.time() - start) * 1000)

        if resp.status_code == 200:
            logger.info(
                "Local container invocation tenant_id=%s duration_ms=%d status=success",
                tenant_id, duration_ms,
            )
            return resp.json()
        else:
            logger.error(
                "Local container invocation failed tenant_id=%s status=%d body=%s",
                tenant_id, resp.status_code, resp.text[:200],
            )
            raise RuntimeError(f"Agent Container returned {resp.status_code}: {resp.text[:200]}")

    except requests.exceptions.ConnectionError as e:
        raise RuntimeError(f"Agent Container not reachable at {base_url}: {e}") from e


def _invoke_agentcore(tenant_id: str, message: str, model: Optional[str]) -> dict:
    """AgentCore Runtime API を呼び出す (本番モード)。"""
    import json as _json

    payload = {
        "sessionId": tenant_id,
        "message": message,
    }
    if model:
        payload["model"] = model

    # Runtime ARN を取得 — コントロールプレーン権限が不要なパターンから構築
    runtime_arn = os.environ.get("AGENTCORE_RUNTIME_ARN", "")
    if not runtime_arn:
        # ランタイム ID + リージョン + アカウントから ARN を構築
        try:
            sts = boto3.client("sts", region_name=AWS_REGION)
            account_id = sts.get_caller_identity()["Account"]
            runtime_arn = f"arn:aws:bedrock-agentcore:{AWS_REGION}:{account_id}:runtime/{RUNTIME_ID}"
            logger.info("Constructed runtime ARN: %s", runtime_arn)
        except Exception as e:
            logger.error("Could not construct runtime ARN: %s", e)
            raise RuntimeError(f"Cannot determine runtime ARN: {e}") from e

    start = time.time()
    try:
        client = _agentcore_client()
        response = client.invoke_agent_runtime(
            agentRuntimeArn=runtime_arn,
            runtimeSessionId=tenant_id,
            contentType="application/json",
            accept="application/json",
            payload=_json.dumps(payload).encode(),
        )

        # レスポンスボディのキーは 'response' (StreamingBody)。'body' や 'payload' ではない
        result_bytes = response.get("response", response.get("payload", response.get("body", b"")))
        if hasattr(result_bytes, "read"):
            result_bytes = result_bytes.read()
        if isinstance(result_bytes, str):
            result_bytes = result_bytes.encode()
        result = json.loads(result_bytes) if result_bytes else {}
        duration_ms = int((time.time() - start) * 1000)

        logger.info(
            "AgentCore invocation tenant_id=%s duration_ms=%d status=success",
            tenant_id, duration_ms,
        )
        return result

    except ClientError as e:
        duration_ms = int((time.time() - start) * 1000)
        error_code = e.response.get("Error", {}).get("Code", "Unknown")
        error_msg = e.response.get("Error", {}).get("Message", "")
        logger.error(
            "AgentCore invocation failed tenant_id=%s error=%s msg=%s duration_ms=%d",
            tenant_id, error_code, error_msg, duration_ms,
        )
        raise RuntimeError(f"AgentCore invocation failed: {error_code}: {error_msg}") from e


# ---------------------------------------------------------------------------
# HTTP サーバー — OpenClaw Gateway から Webhook を受信する
# ---------------------------------------------------------------------------

class TenantRouterHandler(BaseHTTPRequestHandler):
    """テナントルーティングプロキシ用の HTTP ハンドラー。

    エンドポイント:
      GET  /health          → ヘルスチェック
      POST /route           → AgentCore Runtime へメッセージをルーティング
      POST /route/broadcast → (将来) 複数テナントへのブロードキャスト
    """

    def log_message(self, fmt, *args):
        logger.info(fmt, *args)

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {
                "status": "ok",
                "runtime_id": RUNTIME_ID or "not_configured",
                "stack": STACK_NAME,
            })
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/route":
            self._handle_route()
        else:
            self._respond(404, {"error": "not found"})

    def _handle_route(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._respond(400, {"error": "invalid json"})
            return

        # ルーティングフィールドを抽出
        channel = payload.get("channel", "")
        user_id = payload.get("user_id", "")
        message = payload.get("message", "")

        if not channel or not user_id:
            self._respond(400, {"error": "channel and user_id required"})
            return

        if not message:
            self._respond(400, {"error": "message required"})
            return

        # テナントを導出してルーティング
        try:
            tenant_id = derive_tenant_id(channel, user_id)
        except ValueError as e:
            self._respond(400, {"error": str(e)})
            return

        try:
            result = invoke_agent_runtime(
                tenant_id=tenant_id,
                message=message,
                model=payload.get("model"),
            )
            self._respond(200, {
                "tenant_id": tenant_id,
                "response": result,
            })
        except RuntimeError as e:
            self._respond(502, {"error": str(e), "tenant_id": tenant_id})

    def _respond(self, status: int, body: dict):
        data = json.dumps(body, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


# ---------------------------------------------------------------------------
# 起動
# ---------------------------------------------------------------------------

def _load_runtime_id_from_ssm():
    """環境変数に設定されていない場合、SSM から AGENTCORE_RUNTIME_ID の読み込みを試みる。"""
    global RUNTIME_ID
    if RUNTIME_ID:
        return

    ssm_path = f"/openclaw/{STACK_NAME}/runtime-id"
    try:
        ssm = boto3.client("ssm", region_name=AWS_REGION)
        resp = ssm.get_parameter(Name=ssm_path)
        RUNTIME_ID = resp["Parameter"]["Value"]
        logger.info("Loaded runtime_id from SSM: %s", RUNTIME_ID)
    except Exception as e:
        logger.warning("Could not load runtime_id from SSM path=%s: %s", ssm_path, e)


def main():
    _load_runtime_id_from_ssm()

    if not RUNTIME_ID:
        logger.warning(
            "AGENTCORE_RUNTIME_ID not set. Router will start but /route calls will fail. "
            "Set AGENTCORE_RUNTIME_ID env var or SSM parameter /openclaw/%s/runtime-id",
            STACK_NAME,
        )

    server = HTTPServer(("0.0.0.0", ROUTER_PORT), TenantRouterHandler)
    logger.info(
        "Tenant Router listening on port %d (stack=%s, runtime=%s)",
        ROUTER_PORT, STACK_NAME, RUNTIME_ID or "NOT_SET",
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
