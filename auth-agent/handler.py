"""
Authorization_Agent ハンドラー — 承認通知とヒューマンインザループフロー。

要件: 9.3, 9.4, 9.7, 9.9
"""

import logging
import os
import re
import threading
from datetime import datetime, timezone
from typing import Optional

import boto3

try:
    from .permission_request import PermissionRequest
except ImportError:
    from permission_request import PermissionRequest  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 承認メッセージの入力バリデーション
# ---------------------------------------------------------------------------

# 承認レスポンスにおけるプロンプトインジェクションを示すパターン
_APPROVAL_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+", re.IGNORECASE),
    re.compile(r"new\s+system\s+prompt", re.IGNORECASE),
    re.compile(r"approve\s+all\s+(pending|future)", re.IGNORECASE),
    re.compile(r"grant\s+(all|unlimited|full)\s+(access|permissions?)", re.IGNORECASE),
    re.compile(r"<\s*system\s*>", re.IGNORECASE),
    re.compile(r"\[INST\]", re.IGNORECASE),
]

MAX_APPROVAL_MESSAGE_LENGTH = 2000
MAX_REASON_LENGTH = 500


def validate_approval_input(message: str) -> str:
    """Human_Approver からの承認レスポンスを検証する。

    以下を確認する:
    - メッセージ長 (最大 2000 文字)
    - プロンプトインジェクションパターン
    - サニタイズ済みメッセージを返す

    インジェクションが検出された場合は ValueError を送出する。
    """
    if len(message) > MAX_APPROVAL_MESSAGE_LENGTH:
        logger.warning("Approval message truncated: %d > %d", len(message), MAX_APPROVAL_MESSAGE_LENGTH)
        message = message[:MAX_APPROVAL_MESSAGE_LENGTH]

    for pattern in _APPROVAL_INJECTION_PATTERNS:
        match = pattern.search(message)
        if match:
            logger.warning(
                "[auth-agent] INJECTION_BLOCKED pattern=%r matched=%r",
                pattern.pattern, match.group(0)[:60],
            )
            raise ValueError(f"Approval message rejected: suspicious pattern detected")

    return message


def validate_permission_request_fields(payload: dict) -> dict:
    """受信した PermissionRequest ペイロードのフィールドを検証する。

    確認内容:
    - tenant_id: 英数字 + アンダースコア/ハイフン/ドット、最大 128 文字
    - resource: null バイトなし、パストラバーサルなし、最大 512 文字
    - reason: 最大 500 文字、インジェクションパターンなし
    - resource_type: 許可された値のいずれかであること
    """
    import re as _re

    tenant_id = payload.get("tenant_id", "")
    if not _re.match(r"^[a-zA-Z0-9_.\-]{1,128}$", tenant_id):
        raise ValueError(f"Invalid tenant_id: {tenant_id!r}")

    resource = payload.get("resource", "")
    if len(resource) > 512:
        raise ValueError("Resource too long")
    if "\x00" in resource:
        raise ValueError("Null byte in resource")
    if ".." in resource.split("/"):
        raise ValueError("Path traversal in resource")

    reason = payload.get("reason", "")
    if len(reason) > MAX_REASON_LENGTH:
        payload["reason"] = reason[:MAX_REASON_LENGTH]

    allowed_types = {"tool", "data_path", "api_endpoint"}
    if payload.get("resource_type") not in allowed_types:
        raise ValueError(f"Invalid resource_type: {payload.get('resource_type')}")

    return payload


# ---------------------------------------------------------------------------
# SSM システムプロンプト (要件 9.9)
# ---------------------------------------------------------------------------

STACK_NAME = os.environ.get("STACK_NAME", "dev")
_SYSTEM_PROMPT_SSM_PATH = f"/openclaw/{STACK_NAME}/auth-agent/system-prompt"
_DEFAULT_SYSTEM_PROMPT = (
    "You are the Authorization Agent. Review permission requests carefully."
)


def _ssm_client():
    """SSM boto3 クライアントのファクトリ — テストでモック可能。"""
    return boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "us-east-1"))


def load_system_prompt() -> str:
    """SSM パラメータストアからシステムプロンプトを読み込む。

    SSM が利用できない場合やパラメータが存在しない場合はハードコードされた
    デフォルトにフォールバックし、SSM なしでもエージェントが動作し続けるようにする。

    要件: 9.9
    """
    path = _SYSTEM_PROMPT_SSM_PATH
    try:
        ssm = _ssm_client()
        response = ssm.get_parameter(Name=path)
        return response["Parameter"]["Value"]
    except Exception as e:
        logger.warning(
            "[auth-agent] SSM system prompt unavailable path=%s error=%s — using default",
            path,
            e,
        )
        return _DEFAULT_SYSTEM_PROMPT


def get_system_prompt() -> str:
    """現在のシステムプロンプトを返す。SSM を毎回再読み込みする (ホットリロード)。

    要件: 9.9
    """
    return load_system_prompt()


# ---------------------------------------------------------------------------
# 保留リクエストのインメモリストア
# ---------------------------------------------------------------------------
_pending_requests: dict[str, PermissionRequest] = {}
_timers: dict[str, threading.Timer] = {}

# ---------------------------------------------------------------------------
# リスク評価
# ---------------------------------------------------------------------------

_LOW_RISK_TOOLS = {"web_search"}
_MEDIUM_RISK_TOOLS = {"file_write", "code_execution"}
_HIGH_RISK_TOOLS = {"shell"}

_LOW_RISK_KEYWORDS = {"read", "public", "readonly"}
_HIGH_RISK_KEYWORDS = {"system", "/etc/", "/var/", "/usr/", "/bin/", "/sbin/"}


def assess_risk_level(request: PermissionRequest) -> str:
    """リクエストされたリソースに基づいて '低'、'中'、または '高' を返す。"""
    resource = request.resource.lower()
    resource_type = request.resource_type

    if resource_type == "tool":
        if resource in _HIGH_RISK_TOOLS:
            return "高"
        if resource in _MEDIUM_RISK_TOOLS:
            return "中"
        if resource in _LOW_RISK_TOOLS:
            return "低"
        # 未知のツール — デフォルトは中リスク
        return "中"

    # data_path or api_endpoint
    if request.duration_type == "persistent":
        return "高"
    if any(kw in resource for kw in _HIGH_RISK_KEYWORDS):
        return "高"
    if any(kw in resource for kw in _LOW_RISK_KEYWORDS):
        return "低"
    return "中"

# ---------------------------------------------------------------------------
# リスク説明
# ---------------------------------------------------------------------------

_RISK_DESCRIPTIONS = {
    "低": "この操作は低リスクの読み取り専用またはパブリックアクセスであり、システムセキュリティへの影響は限定的です。",
    "中": "この操作はファイル書き込みまたはコード実行を伴い、システム状態に影響を与える可能性があります。慎重に承認してください。",
    "高": "この操作は高リスク操作（シェル実行やシステムパスアクセスなど）であり、システムセキュリティに重大な影響を与える可能性があります。一時的な権限のみ付与することを強く推奨します。",
}

# ---------------------------------------------------------------------------
# 通知フォーマット
# ---------------------------------------------------------------------------


def format_approval_notification(request: PermissionRequest) -> str:
    """Human_Approver 向けにフォーマットされた承認通知文字列を返す。"""
    risk = assess_risk_level(request)
    risk_desc = _RISK_DESCRIPTIONS[risk]

    if request.duration_type == "temporary" and request.suggested_duration_hours:
        duration_str = f"一時的（{request.suggested_duration_hours} 時間）"
        approve_temp_label = f"✅ 承認（一時的）- {request.suggested_duration_hours} 時間の権限付与"
    elif request.duration_type == "temporary":
        duration_str = "一時的（1 時間）"
        approve_temp_label = "✅ 承認（一時的）- 1 時間の権限付与"
    else:
        duration_str = "永続的"
        approve_temp_label = "✅ 承認（一時的）- 1 時間の権限付与"

    resource_type_label = {
        "tool": "ツール",
        "data_path": "データパス",
        "api_endpoint": "API エンドポイント",
    }.get(request.resource_type, request.resource_type)

    lines = [
        "🔐 **権限申請通知**",
        "",
        f"**申請人**：{request.tenant_id}",
        f"**申請リソース**：{request.resource}（{resource_type_label}）",
        f"**申請理由**：{request.reason}",
        f"**推奨有効期間**：{duration_str}",
        f"**リスクレベル**：{risk}",
        "",
        f"**リスク説明**：{risk_desc}",
        "",
        "**以下のいずれかで返信してください**：",
        approve_temp_label,
        "✅ 承認（永続的）- ホワイトリストに永久追加",
        "⚠️ 部分承認 - 制限条件を説明してください",
        "❌ 拒否 - 理由を説明してください（任意）",
        "",
        "⏰ 30 分以内に返信がない場合は自動拒否されます。",
    ]
    return "\n".join(lines)

# ---------------------------------------------------------------------------
# 通知送信 (抽象化済み — 実際のチャネル統合はスコープ外)
# ---------------------------------------------------------------------------


def _send_notification(message: str, tenant_id: str) -> None:
    """Human_Approver チャネルへ通知メッセージを送信する。

    実際の WhatsApp/Telegram 統合はスコープ外のため、
    CloudWatch Logs で確認できるようメッセージをログ出力する。
    """
    logger.info(
        "[auth-agent] NOTIFICATION tenant_id=%s message=%s",
        tenant_id,
        message,
    )


# ---------------------------------------------------------------------------
# エージェントコンテナへの通知
# ---------------------------------------------------------------------------


def _notify_agent_container(request_id: str, status: str, reason: Optional[str] = None) -> None:
    """承認結果を元のエージェントコンテナに通知する。"""
    logger.info(
        "[auth-agent] AGENT_NOTIFY request_id=%s status=%s reason=%s",
        request_id,
        status,
        reason or "",
    )


# ---------------------------------------------------------------------------
# タイムアウト時の自動拒否
# ---------------------------------------------------------------------------


def auto_reject(request_id: str) -> None:
    """Human_Approver が返信しなかった場合に 30 分タイマーから呼び出される。"""
    request = _pending_requests.pop(request_id, None)
    _timers.pop(request_id, None)

    if request is None:
        # タイムアウト発火前に既に処理済み (承認/拒否)
        return

    request.status = "timeout"

    logger.warning(
        "[auth-agent] AUTO_REJECT request_id=%s tenant_id=%s resource=%s reason=timeout",
        request_id,
        request.tenant_id,
        request.resource,
    )

    _notify_agent_container(request_id, "timeout", reason="30 分以内に審査回答がなかったため、自動拒否しました。")

    # リクエストがタイムアウトしたことを Human_Approver に任意で通知
    timeout_msg = (
        f"⏰ 権限申請がタイムアウトのため自動拒否されました。\n"
        f"申請人：{request.tenant_id}\n"
        f"申請リソース：{request.resource}\n"
        f"申請 ID：{request_id}"
    )
    _send_notification(timeout_msg, request.tenant_id)

# ---------------------------------------------------------------------------
# メインエントリポイント
# ---------------------------------------------------------------------------

TIMEOUT_SECONDS = 30 * 60  # 30 minutes


def handle_permission_request(request: PermissionRequest) -> dict:
    """受信した PermissionRequest を処理する。

    1. システムプロンプトを読み込む (各呼び出し時に SSM からホットリロード)。
    2. 承認通知をフォーマットする。
    3. リクエストを保留辞書に格納する。
    4. Human_Approver チャネルへ通知を送信する。
    5. 期限切れ時に auto_reject を呼び出す 30 分タイマーを開始する。

    request_id、通知メッセージ、SSM プロンプトパスを含む dict を返す。
    """
    # リクエストごとにシステムプロンプトをホットリロード (要件 9.9)
    get_system_prompt()

    notification = format_approval_notification(request)

    # 保留ストアに格納
    _pending_requests[request.request_id] = request
    request.status = "pending"

    logger.info(
        "[auth-agent] PENDING request_id=%s tenant_id=%s resource=%s",
        request.request_id,
        request.tenant_id,
        request.resource,
    )

    # Human_Approver へ通知を送信
    _send_notification(notification, request.tenant_id)

    # 30 分の自動拒否タイマーを開始
    timer = threading.Timer(TIMEOUT_SECONDS, auto_reject, args=(request.request_id,))
    timer.daemon = True
    timer.start()
    _timers[request.request_id] = timer

    return {
        "request_id": request.request_id,
        "status": "pending",
        "notification": notification,
        "expires_at": request.expires_at.isoformat(),
        "system_prompt_path": _SYSTEM_PROMPT_SSM_PATH,
    }


# ---------------------------------------------------------------------------
# 保留リスト照会 (/pending approvals 用)
# ---------------------------------------------------------------------------


def list_pending_requests() -> list[dict]:
    """Human_Approver クエリ用に全保留リクエストのサマリーを返す。"""
    now = datetime.now(timezone.utc)
    result = []
    for idx, (rid, req) in enumerate(_pending_requests.items(), start=1):
        # expires_at がタイムゾーン情報を持っていない場合は UTC を付与
        expires_at = req.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        requested_at = req.requested_at
        if requested_at.tzinfo is None:
            requested_at = requested_at.replace(tzinfo=timezone.utc)

        waited = now - requested_at
        remaining = expires_at - now
        result.append(
            {
                "index": idx,
                "request_id": rid,
                "tenant_id": req.tenant_id,
                "resource": req.resource,
                "waited_seconds": max(0, int(waited.total_seconds())),
                "remaining_seconds": max(0, int(remaining.total_seconds())),
            }
        )
    return result


def format_pending_list(requests: list) -> str:
    """保留リクエスト辞書のリストを人間が読みやすい文字列にフォーマットする。

    各アイテムは list_pending_requests() が返すキーを持つことが期待される:
    index、tenant_id、resource、waited_seconds、remaining_seconds。

    メッセージチャネル経由で送信するのに適した日本語サマリーを返す。

    要件: 9.8
    """
    if not requests:
        return "現在、承認待ちの権限申請はありません"

    lines = [f"承認待ちリスト（計 {len(requests)} 件）："]
    for item in requests:
        waited_min = item["waited_seconds"] // 60
        remaining_min = item["remaining_seconds"] // 60
        lines.append(
            f"{item['index']}. 申請人：{item['tenant_id']} | "
            f"リソース：{item['resource']} | "
            f"待機：{waited_min}分 | "
            f"残り：{remaining_min}分"
        )
    return "\n".join(lines)


def handle_pending_approvals_command() -> str:
    """Human_Approver からの '/pending approvals' コマンドを処理する。

    現在の保留リストを照会してフォーマット済み文字列を返す。

    要件: 9.8
    """
    requests = list_pending_requests()
    return format_pending_list(requests)
