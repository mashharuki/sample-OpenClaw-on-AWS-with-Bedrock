"""
CloudWatch オブザーバビリティ向け構造化ログユーティリティ。

すべてのログエントリは Python 標準の logging モジュール経由で以下の形式で出力される:
    STRUCTURED_LOG {json_string}

このプレフィックスにより、テストやログプロセッサが構造化エントリを確実にパースできる。

要件: 8.1, 8.2, 8.3, 8.4
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import List, Optional

# agent-container 内で動作中に auth-agent から PermissionRequest をインポートできるようにする
_auth_agent_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "auth-agent")
if _auth_agent_path not in sys.path:
    sys.path.insert(0, _auth_agent_path)

try:
    from permission_request import PermissionRequest  # noqa: E402
except ImportError:
    PermissionRequest = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)


def log_agent_invocation(
    tenant_id: str,
    tools_used: List[str],
    duration_ms: int,
    status: str,
) -> None:
    """
    AgentCore Runtime の各呼び出しに対して構造化ログエントリを記録する。

    ログストリームは ``log_stream`` フィールドが
    ``tenant_{tenant_id}`` (要件 8.4) に設定されることで識別される。

    出力フィールド (要件 8.1):
    - tenant_id
    - session_id  (= tenant_id)
    - tools_used  (リスト)
    - duration_ms
    - status
    - timestamp
    - event_type  = "agent_invocation"
    - log_stream  = "tenant_{tenant_id}"

    要件: 8.1, 8.4
    """
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "log_stream": f"tenant_{tenant_id}",
        "tenant_id": tenant_id,
        "session_id": tenant_id,
        "event_type": "agent_invocation",
        "tools_used": tools_used,
        "duration_ms": duration_ms,
        "status": status,
    }
    logger.info("STRUCTURED_LOG %s", json.dumps(entry))


def log_permission_denied(
    tenant_id: str,
    tool_name: str,
    cedar_decision: str,
    request_id: Optional[str] = None,
) -> None:
    """
    ツール呼び出しがパーミッションシステムによって拒否された際に監査ログエントリを記録する。

    ログストリームは ``log_stream`` フィールドが
    ``tenant_{tenant_id}`` (要件 8.4) に設定されることで識別される。

    出力フィールド (要件 8.2):
    - tenant_id
    - tool_name
    - cedar_decision
    - request_id   (オプションのパーミッションリクエスト UUID)
    - timestamp
    - event_type   = "permission_denied"
    - log_stream   = "tenant_{tenant_id}"

    要件: 8.2, 8.4
    """
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "log_stream": f"tenant_{tenant_id}",
        "tenant_id": tenant_id,
        "event_type": "permission_denied",
        "tool_name": tool_name,
        "cedar_decision": cedar_decision,
        "request_id": request_id,
    }
    logger.warning("STRUCTURED_LOG %s", json.dumps(entry))


def log_approval_decision(
    request: "PermissionRequest",
    decision: str,
    approver_note: Optional[str] = None,
) -> None:
    """
    Authorization_Agent によるすべての承認決定に対して監査ログエントリを記録する。

    ログストリームはテナント名プレフィックスなしの ``auth-agent`` (このイベントが
    テナントセッションではなく Authorization_Agent セッションから発生するため)。

    出力フィールド (要件 8.3):
    - request_id
    - tenant_id
    - resource
    - decision
    - approver_note
    - timestamp
    - event_type  = "approval_decision"
    - log_stream  = "auth-agent"

    要件: 8.3
    """
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "log_stream": "auth-agent",
        "event_type": "approval_decision",
        "request_id": request.request_id,
        "tenant_id": request.tenant_id,
        "resource": request.resource,
        "decision": decision,
        "approver_note": approver_note,
    }
    logger.info("STRUCTURED_LOG %s", json.dumps(entry))
