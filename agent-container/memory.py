"""
AgentCore メモリ — セッション横断メモリ向けオプションのクラウド永続化レイヤー。

openclaw のネイティブメモリ (Markdown + SQLite) はコンテナのライフサイクル内で
引き続き機能する。このモジュールは、コンテナが破棄されても残るよう AWS に
サマリーを永続化する *オプションの* AgentCore Memory 統合を提供する。

要件: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
"""

import logging
import os
import sys
import time
from typing import Optional

import boto3

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

logger = logging.getLogger(__name__)

# 環境変数からメモリストア ID を取得 (要件 6.1)
MEMORY_STORE_ID = os.environ.get("MEMORY_STORE_ID", "default")


def _memory_client():
    """
    bedrock-agentcore-memory boto3 クライアントのファクトリ。

    モジュールレベルのシングルトンではなくファクトリを使うことで、
    テストでのモックが容易になる — 呼び出し元が `memory._memory_client` を monkeypatch できる。
    """
    return boto3.client(
        "bedrock-agentcore-memory",
        region_name=os.environ.get("AWS_REGION", "us-east-1"),
    )


def _namespace(tenant_id: str) -> str:
    """テナントのメモリ名前空間を返す (要件 6.1)。"""
    return f"tenant_{tenant_id}"


async def load_memory_on_session_start(tenant_id: str) -> Optional[str]:
    """
    セッション開始時に *tenant_id* の過去のメモリサマリーを取得する。

    どんな例外でも WARNING をログ出力し None を返すことで、
    セッションはメモリコンテキストなしで継続する (グレースフルデグレード, 要件 6.6)。

    要件: 6.2, 6.6
    """
    try:
        client = _memory_client()
        response = client.retrieve_memories(
            memoryId=MEMORY_STORE_ID,
            namespace=_namespace(tenant_id),
            maxResults=10,
        )
        summaries = [m["content"] for m in response.get("memories", [])]
        return "\n".join(summaries) if summaries else None
    except Exception as e:
        logger.warning(
            "AgentCore Memory 读取失败，降级继续 tenant_id=%s error=%s",
            tenant_id,
            e,
        )
        return None  # グレースフルデグレード — セッションはメモリなしで継続


async def save_memory_on_session_end(tenant_id: str, session_summary: str) -> None:
    """
    セッション終了後に *session_summary* をテナントのメモリ名前空間に永続化する。

    書き込み前にメモリポイズニング安全チェックを実行する。サマリーにプロンプトインジェクション
    パターンが含まれている場合は破棄して失敗をログ出力する — レスポンスには影響しない (要件 6.6)。

    要件: 6.3, 6.6
    """
    # 安全チェック: インジェクションパターンを含むサマリーを拒否
    try:
        from safety import check_memory_safety
        check_memory_safety(session_summary, tenant_id)
    except Exception as safety_err:
        logger.error(
            "Memory write blocked — safety violation tenant_id=%s error=%s",
            tenant_id,
            safety_err,
        )
        return  # ポイズニングされたコンテンツは書き込まない

    try:
        client = _memory_client()
        client.store_memory(
            memoryId=MEMORY_STORE_ID,
            namespace=_namespace(tenant_id),
            content=session_summary,
            metadata={"tenant_id": tenant_id, "timestamp": time.time()},
        )
        logger.info(
            "AgentCore Memory 写入成功 tenant_id=%s namespace=%s",
            tenant_id,
            _namespace(tenant_id),
        )
    except Exception as e:
        logger.error(
            "AgentCore Memory 写入失败 tenant_id=%s error=%s",
            tenant_id,
            e,
        )


async def clear_tenant_memory(tenant_id: str) -> bool:
    """
    *tenant_id* のすべてのメモリエントリをクリアする (``/memory clear``
    コマンドをサポート、要件 6.7)。

    成功時は True、失敗時は False を返す (失敗は ERROR レベルでログ出力)。

    要件: 6.7
    """
    try:
        client = _memory_client()
        client.delete_memories(
            memoryId=MEMORY_STORE_ID,
            namespace=_namespace(tenant_id),
        )
        logger.info(
            "AgentCore Memory 已清除 tenant_id=%s namespace=%s",
            tenant_id,
            _namespace(tenant_id),
        )
        return True
    except Exception as e:
        logger.error(
            "AgentCore Memory 清除失败 tenant_id=%s error=%s",
            tenant_id,
            e,
        )
        return False
