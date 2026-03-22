"""
Authorization_Agent — 承認結果の実行。

Human_Approver の決定を実行する execute_approval() を実装する:
  - approve_temporary : identity.py 経由で時間制限付き ApprovalToken を発行する
  - approve_persistent: テナントの SSM Cedar Policy にリソースを追加する
  - reject            : エージェントコンテナに通知して理由を記録する

すべての決定は構造化 CloudWatch エントリとしてログ出力される。

要件: 9.5, 9.6
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Optional

# auth-agent 内から実行する場合に agent-container からのインポートを許可する
_agent_container_path = os.path.join(os.path.dirname(__file__), "..", "agent-container")
if _agent_container_path not in sys.path:
    sys.path.insert(0, _agent_container_path)

try:
    from .permission_request import PermissionRequest
except ImportError:
    from permission_request import PermissionRequest  # type: ignore[no-redef]

from identity import issue_approval_token  # noqa: E402
from permissions import write_permission_profile, read_permission_profile  # noqa: E402

import boto3  # noqa: E402

logger = logging.getLogger(__name__)

STACK_NAME = os.environ.get("STACK_NAME", "dev")


# ---------------------------------------------------------------------------
# SSM クライアントファクトリ (テストでモック可能)
# ---------------------------------------------------------------------------

def _ssm_client():
    return boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "us-east-1"))


# ---------------------------------------------------------------------------
# CloudWatch ロギング
# ---------------------------------------------------------------------------

def _log_approval_decision(
    request: PermissionRequest,
    decision: str,
    approver_note: Optional[str],
) -> None:
    """承認決定の構造化 CloudWatch ログエントリを出力する。"""
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "log_stream": "auth-agent",
        "event_type": "approval_decision",
        "request_id": request.request_id,
        "tenant_id": request.tenant_id,
        "resource": request.resource,
        "resource_type": request.resource_type,
        "decision": decision,
        "approver_note": approver_note,
    }
    logger.info("APPROVAL_DECISION %s", json.dumps(entry, ensure_ascii=False))


# ---------------------------------------------------------------------------
# エージェントコンテナへの通知 (実際のチャネル統合はスコープ外)
# ---------------------------------------------------------------------------

def _notify_agent_container(
    tenant_id: str,
    status: str,
    token=None,
    reason: Optional[str] = None,
) -> None:
    """エージェントコンテナへ送信する通知をログ出力する。"""
    logger.info(
        "[auth-agent] AGENT_NOTIFY tenant_id=%s status=%s token_id=%s reason=%s",
        tenant_id,
        status,
        token.token_id if token else None,
        reason or "",
    )


# ---------------------------------------------------------------------------
# 永続的承認ヘルパー
# ---------------------------------------------------------------------------

def _update_cedar_policy(tenant_id: str, resource: str, resource_type: str) -> None:
    """
    SSM 上のテナントの許可ツールリストに *resource* を追加する。

    現在の Permission_Profile を読み込み、リソースがまだ存在しない場合は追記して
    書き戻す。SSM パス:
        /openclaw/{stack}/tenants/{tenant_id}/permissions
    """
    profile = read_permission_profile(tenant_id)

    if resource_type == "tool":
        tools: list = profile.get("tools", [])
        if resource not in tools:
            tools.append(resource)
            profile["tools"] = tools
    elif resource_type in ("data_path", "api_endpoint"):
        data_perms: dict = profile.setdefault("data_permissions", {})
        key = "file_paths" if resource_type == "data_path" else "api_endpoints"
        paths: list = data_perms.get(key, [])
        if resource not in paths:
            paths.append(resource)
            data_perms[key] = paths

    profile["updated_at"] = datetime.now(timezone.utc).isoformat()
    profile["updated_by"] = "auth-agent"
    write_permission_profile(tenant_id, profile)
    logger.info(
        "Cedar Policy updated tenant_id=%s resource=%s resource_type=%s",
        tenant_id,
        resource,
        resource_type,
    )


# ---------------------------------------------------------------------------
# メインエントリポイント
# ---------------------------------------------------------------------------

def execute_approval(
    request: PermissionRequest,
    decision: str,
    approver_note: Optional[str] = None,
) -> None:
    """
    PermissionRequest に対する Human_Approver の決定を実行する。

    パラメータ
    ----------
    request:       元の PermissionRequest。
    decision:      "approve_temporary"、"approve_persistent"、"reject" のいずれか。
    approver_note: Human_Approver からの任意の自由記述メモ。

    要件: 9.5, 9.6
    """
    if decision == "approve_temporary":
        duration_hours = request.suggested_duration_hours or 1
        effective_ttl = min(duration_hours, 24)  # 要件 9.5 / 5.5
        token = issue_approval_token(
            tenant_id=request.tenant_id,
            resource=request.resource,
            ttl_hours=effective_ttl,
        )
        _notify_agent_container(request.tenant_id, "approved_temporary", token=token)

    elif decision == "approve_persistent":
        _update_cedar_policy(
            tenant_id=request.tenant_id,
            resource=request.resource,
            resource_type=request.resource_type,
        )
        _notify_agent_container(request.tenant_id, "approved_persistent")

    elif decision == "reject":
        _notify_agent_container(
            request.tenant_id, "rejected", reason=approver_note
        )
        logger.warning(
            "[auth-agent] REJECTED request_id=%s tenant_id=%s resource=%s reason=%s",
            request.request_id,
            request.tenant_id,
            request.resource,
            approver_note or "(理由なし)",
        )

    else:
        logger.error(
            "[auth-agent] Unknown decision=%s request_id=%s", decision, request.request_id
        )

    # すべての決定を記録する (要件 9.6)
    _log_approval_decision(request, decision, approver_note)
