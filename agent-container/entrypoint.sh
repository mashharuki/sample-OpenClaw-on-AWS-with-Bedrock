#!/bin/bash
# =============================================================================
# エージェントコンテナ エントリポイント
# 設計: server.py を即座に起動 (数秒でヘルスチェックが応答可能になる)。
# OpenClaw はリクエストごとに CLI サブプロセス経由で呼び出す — 長時間稼動プロセスなし。
# S3 同期はサーバー起動後にバックグラウンドで実行される。
# =============================================================================
set -eo pipefail

TENANT_ID="${SESSION_ID:-${sessionId:-unknown}}"
S3_BUCKET="${S3_BUCKET:-openclaw-tenants-000000000000}"
S3_BASE="s3://${S3_BUCKET}/${TENANT_ID}"
WORKSPACE="/tmp/workspace"
SYNC_INTERVAL="${SYNC_INTERVAL:-60}"
STACK_NAME="${STACK_NAME:-dev}"
AWS_REGION="${AWS_REGION:-us-east-1}"

echo "[entrypoint] START tenant=${TENANT_ID} bucket=${S3_BUCKET}"

# =============================================================================
# ステップ 0: Node.js ランタイムの最適化 (openclaw 呼び出しの前に実行)
# =============================================================================

# V8 コンパイルキャッシュ (Node.js 22+) — Docker ビルド時に事前ウォームアップ済み
if [ -d /app/.compile-cache ]; then
    export NODE_COMPILE_CACHE=/app/.compile-cache
    echo "[entrypoint] V8 compile cache enabled"
fi

# Node.js 22 VPC 互換性のために IPv4 を強制
# Node.js 22 の Happy Eyeballs は先に IPv6 を試みるが、IPv6 のない VPC ではタイムアウトする
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first"

# ワークスペースを準備
mkdir -p "$WORKSPACE" "$WORKSPACE/memory" "$WORKSPACE/skills"
echo "$TENANT_ID" > /tmp/tenant_id

# =============================================================================
# ステップ 0.5: openclaw.json 設定を書き込む (環境変数を置換)
# =============================================================================
OPENCLAW_CONFIG_DIR="$HOME/.openclaw"
mkdir -p "$OPENCLAW_CONFIG_DIR"
sed -e "s|\${AWS_REGION}|${AWS_REGION}|g" \
    -e "s|\${BEDROCK_MODEL_ID}|${BEDROCK_MODEL_ID:-global.amazon.nova-2-lite-v1:0}|g" \
    /app/openclaw.json > "$OPENCLAW_CONFIG_DIR/openclaw.json"
echo "[entrypoint] openclaw.json written to $OPENCLAW_CONFIG_DIR/openclaw.json"

# =============================================================================
# ステップ 1: server.py を即座に起動 — ヘルスチェックは数秒以内に応答が必要
# =============================================================================
export OPENCLAW_WORKSPACE="$WORKSPACE"
export OPENCLAW_SKIP_ONBOARDING=1

python /app/server.py &
SERVER_PID=$!
echo "[entrypoint] server.py PID=${SERVER_PID}"

# =============================================================================
# ステップ 2: S3 同期をバックグラウンドで実行 (ノンブロッキング)
# =============================================================================
(
    echo "[bg] S3 からワークスペースを取得中..."
    aws s3 sync "${S3_BASE}/workspace/" "$WORKSPACE/" --quiet 2>/dev/null || true

    # 新規テナントの SOUL.md を初期化
    if [ ! -f "$WORKSPACE/SOUL.md" ]; then
        ROLE=$(aws ssm get-parameter \
            --name "/openclaw/${STACK_NAME}/tenants/${TENANT_ID}/soul-template" \
            --query Parameter.Value --output text --region "$AWS_REGION" 2>/dev/null || echo "default")
        aws s3 cp "s3://${S3_BUCKET}/_shared/templates/${ROLE}.md" "$WORKSPACE/SOUL.md" \
            --quiet 2>/dev/null || echo "You are a helpful AI assistant." > "$WORKSPACE/SOUL.md"
    fi

    # =========================================================================
    # スキルローダー: レイヤー 2 (S3 ホットロード) + レイヤー 3 (ビルド済みバンドル)
    # レイヤー 1 (ビルトイン) は Docker イメージ内の ~/.openclaw/skills/ に既に存在する
    # =========================================================================
    echo "[bg] エンタープライズスキルを読み込み中..."
    python /app/skill_loader.py \
        --tenant "$TENANT_ID" \
        --workspace "$WORKSPACE" \
        --bucket "$S3_BUCKET" \
        --stack "$STACK_NAME" \
        --region "$AWS_REGION" 2>&1 || echo "[bg] skill_loader.py 失敗 (非致命的)"

    # スキル API キーを環境に取り込む (後続の openclaw 呼び出し用)
    if [ -f /tmp/skill_env.sh ]; then
        . /tmp/skill_env.sh
        echo "[bg] スキル API キーを読み込みました"
    fi

    echo "[bg] ワークスペースとスキルの準備完了"
    echo "WORKSPACE_READY" > /tmp/workspace_status

    # ウォッチドッグ: SYNC_INTERVAL 秒ごとに同期して書き戻す
    while true; do
        sleep "$SYNC_INTERVAL"
        aws s3 sync "$WORKSPACE/" "${S3_BASE}/workspace/" \
            --exclude "node_modules/*" --exclude "skills/_shared/*" \
            --quiet 2>/dev/null || true
    done
) &
BG_PID=$!
echo "[entrypoint] Background sync PID=${BG_PID}"

# =============================================================================
# ステップ 3: グレースフルシャットダウン
# =============================================================================
cleanup() {
    echo "[entrypoint] SIGTERM — ワークスペースをフラッシュ中"
    kill "$BG_PID" 2>/dev/null || true
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    aws s3 sync "$WORKSPACE/" "${S3_BASE}/workspace/" \
        --exclude "node_modules/*" --exclude "skills/_shared/*" \
        --quiet 2>/dev/null || true
    echo "[entrypoint] 完了"
    exit 0
}
trap cleanup SIGTERM SIGINT

echo "[entrypoint] 待機中..."
wait "$SERVER_PID" || true
