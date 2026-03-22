"""
AgentCore アイデンティティ — トークン発行と検証。

設計ドキュメントに記述された @requires_access_token パターンを反映した
軽量インメモリ承認トークンストアを実装する。

要件: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# 実行前に承認トークンが必要なツール (要件 5.6)
REQUIRES_TOKEN_TOOLS = ["shell", "file_write", "code_execution"]

# トークンの最大有効期間 (時間単位) (要件 5.5)
MAX_TOKEN_TTL_HOURS = 24

# (tenant_id, resource) をキーとするインメモリトークンストア
_token_store: Dict[Tuple[str, str], "ApprovalToken"] = {}


@dataclass
class ApprovalToken:
    """保護されたツール/リソース向けの時間制限付き承認トークンを表す。"""

    token_id: str
    tenant_id: str
    resource: str
    issued_at: datetime
    expires_at: datetime


def issue_approval_token(
    tenant_id: str,
    resource: str,
    ttl_hours: int,
) -> ApprovalToken:
    """
    *tenant_id* が *resource* にアクセスするための承認トークンを発行する。

    有効な TTL は ``min(ttl_hours, MAX_TOKEN_TTL_HOURS)`` 時間であり、
    トークンが 24 時間を超えて有効になることはない (要件 5.5)。

    同一の (tenant_id, resource) ペアに既存トークンがある場合は置き換えられる —
    自動更新はなく、呼び出し元が明示的に新しいトークンを要求する必要がある (要件 5.7)。

    要件: 5.4, 5.5
    """
    effective_ttl = min(ttl_hours, MAX_TOKEN_TTL_HOURS)
    now = datetime.now(timezone.utc)
    token = ApprovalToken(
        token_id=str(uuid.uuid4()),
        tenant_id=tenant_id,
        resource=resource,
        issued_at=now,
        expires_at=now + timedelta(hours=effective_ttl),
    )
    _token_store[(tenant_id, resource)] = token
    logger.info(
        "Approval token issued tenant_id=%s resource=%s ttl_hours=%d expires_at=%s",
        tenant_id,
        resource,
        effective_ttl,
        token.expires_at.isoformat(),
    )
    return token


def validate_token(tenant_id: str, resource: str) -> bool:
    """
    *tenant_id* / *resource* に対して有効な (期限切れでない) 承認トークンが存在する場合は
    True を返し、それ以外は False を返す。

    トークンが存在しないか期限切れの場合、認可が必要であることを示すメッセージを記録し
    False を返す — 呼び出し元が認可リクエストフローを開始する責任を持つ (要件 5.3)。
    期限切れトークンは自動更新されない (要件 5.7)。

    要件: 5.2, 5.3, 5.7
    """
    token: Optional[ApprovalToken] = _token_store.get((tenant_id, resource))

    if token is None:
        logger.info(
            "No approval token found — authorization required "
            "tenant_id=%s resource=%s",
            tenant_id,
            resource,
        )
        return False

    now = datetime.now(timezone.utc)
    if now >= token.expires_at:
        logger.info(
            "Approval token expired — re-authorization required "
            "tenant_id=%s resource=%s expired_at=%s",
            tenant_id,
            resource,
            token.expires_at.isoformat(),
        )
        # 古いトークンを削除; 自動更新なし (要件 5.7)
        del _token_store[(tenant_id, resource)]
        return False

    return True


def revoke_token(tenant_id: str, resource: str) -> None:
    """(tenant_id, resource) のトークンが存在する場合は削除する。"""
    _token_store.pop((tenant_id, resource), None)
    logger.info("Approval token revoked tenant_id=%s resource=%s", tenant_id, resource)


def clear_all_tokens() -> None:
    """インメモリトークンストア全体をクリアする (テスト用に有用)。"""
    _token_store.clear()
