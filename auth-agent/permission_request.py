"""
Authorization_Agent ワークフロー用の PermissionRequest データクラス。

エージェントコンテナが PermissionDeniedError を検出すると、PermissionRequest を構築して
Authorization_Agent セッションに転送し、Human_Approver がリクエストをレビューして
承認または拒否できるようにする。

要件: 9.1, 9.2
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Optional


@dataclass
class PermissionRequest:
    """Authorization_Agent に送信されるランタイム権限リクエストを表す。"""

    request_id: str  # UUID、このリクエストを一意に識別する
    tenant_id: str  # 権限を必要とするテナント
    resource_type: Literal["tool", "data_path", "api_endpoint"]
    resource: str  # リクエストされているツール名、データパス、または API エンドポイント
    reason: str  # エージェントがこの権限を必要とする理由
    duration_type: Literal["temporary", "persistent"]
    suggested_duration_hours: Optional[int]  # 一時的な付与にのみ関連する
    requested_at: datetime
    expires_at: datetime  # requested_at の 30 分後; この時刻以降に自動拒否される
    status: Literal["pending", "approved", "rejected", "partial", "timeout"]
