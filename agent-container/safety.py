"""
入力安全性検証 — プロンプトインジェクションとメモリポイズニングを防御する。

OpenClaw を安全に実行するための Microsoft Security Blog ガイダンスに基づく:
https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk

2つの攻撃面を防御する:
1. メモリポイズニング: 攻撃者がセッションサマリーに命令を注入し、
   セッションをまたいで将来のエージェントの動作に影響を与える。
2. メッセージ入力経由のプロンプトインジェクション: エージェントのシステムプロンプトを
   上書きしようとする過大または命令を含んだメッセージ。
"""

import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# メモリポイズニングパターン
# メモリへの永続的な命令注入の試みを示すフレーズ。
# AgentCore Memory に書き込む前にセッションサマリーに対してチェックされる。
# ---------------------------------------------------------------------------
_MEMORY_INJECTION_PATTERNS = [
    r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions",
    r"you\s+are\s+now\s+",
    r"new\s+system\s+prompt",
    r"forget\s+(everything|all|your\s+instructions)",
    r"disregard\s+(your|all|previous)",
    r"override\s+(your|the)\s+(instructions|rules|guidelines)",
    r"act\s+as\s+(if\s+you\s+are|a\s+)",
    r"pretend\s+(you\s+are|to\s+be)",
    r"your\s+new\s+(role|persona|identity|instructions)",
    r"from\s+now\s+on\s+you\s+(will|must|should)",
    r"<\s*system\s*>",           # XML スタイルのシステムタグ注入
    r"\[INST\]",                  # Llama 命令注入
    r"###\s*instruction",         # Markdown 命令ヘッダー注入
]

_COMPILED_MEMORY_PATTERNS = [
    re.compile(p, re.IGNORECASE | re.DOTALL)
    for p in _MEMORY_INJECTION_PATTERNS
]

# ---------------------------------------------------------------------------
# 入力バリデーションの制限値
# ---------------------------------------------------------------------------
MAX_MESSAGE_LENGTH = 32_000   # 約 8k トークン、正当な利用には十分な余裕
MAX_TOOL_NAME_LENGTH = 64
MAX_RESOURCE_PATH_LENGTH = 512


class SafetyViolation(Exception):
    """入力が安全チェックに失敗した場合に発生する。"""

    def __init__(self, reason: str, field: str):
        self.reason = reason
        self.field = field
        super().__init__(f"Safety violation in {field}: {reason}")


def check_memory_safety(summary: str, tenant_id: str) -> bool:
    """
    メモリへ書き込む前にセッションサマリーのプロンプトインジェクションパターンを確認する。

    安全な場合は True を返す。
    ポイズニングパターンが検出された場合は SafetyViolation を発生させる。

    このチェックは意図的に保守的 — 誤検知 (正当なサマリーをブロック) は
    見逃し (攻撃者制御の命令を永続化) より望ましい。
    """
    for pattern in _COMPILED_MEMORY_PATTERNS:
        match = pattern.search(summary)
        if match:
            logger.warning(
                "Memory poisoning attempt blocked tenant_id=%s pattern=%r matched=%r",
                tenant_id,
                pattern.pattern,
                match.group(0)[:80],
            )
            raise SafetyViolation(
                reason=f"Injection pattern detected: {match.group(0)[:40]!r}",
                field="session_summary",
            )
    return True


def validate_message(message: str) -> str:
    """
    受信メッセージを検証してサニタイズする。

    - MAX_MESSAGE_LENGTH を超えるメッセージを切り詰める (警告をログ出力)。
    - (切り詰められた可能性のある) メッセージを返す。
    """
    if len(message) > MAX_MESSAGE_LENGTH:
        logger.warning(
            "Message truncated: length=%d exceeds limit=%d",
            len(message),
            MAX_MESSAGE_LENGTH,
        )
        return message[:MAX_MESSAGE_LENGTH]
    return message


def validate_tool_name(tool_name: str) -> str:
    """
    ツール名を検証する — 英数字とアンダースコアのみ、最大 64 文字。
    無効な入力の場合は SafetyViolation を発生させる。
    """
    if len(tool_name) > MAX_TOOL_NAME_LENGTH:
        raise SafetyViolation(
            reason=f"Tool name too long: {len(tool_name)} > {MAX_TOOL_NAME_LENGTH}",
            field="tool_name",
        )
    if not re.match(r"^[a-zA-Z0-9_]+$", tool_name):
        raise SafetyViolation(
            reason=f"Tool name contains invalid characters: {tool_name!r}",
            field="tool_name",
        )
    return tool_name


def validate_resource_path(resource: Optional[str]) -> Optional[str]:
    """
    リソースパスを検証する — 最大 512 文字、ヌルバイトやパストラバーサルは不可。
    resource が None の場合は None を返す。
    無効な入力の場合は SafetyViolation を発生させる。
    """
    if resource is None:
        return None
    if len(resource) > MAX_RESOURCE_PATH_LENGTH:
        raise SafetyViolation(
            reason=f"Resource path too long: {len(resource)} > {MAX_RESOURCE_PATH_LENGTH}",
            field="resource",
        )
    if "\x00" in resource:
        raise SafetyViolation(reason="Null byte in resource path", field="resource")
    if ".." in resource.split("/"):
        raise SafetyViolation(reason="Path traversal attempt in resource", field="resource")
    return resource
