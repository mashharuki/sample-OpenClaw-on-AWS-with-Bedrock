#!/bin/bash
# EC2 Gateway 上のマルチテナントサービスをすべて起動する
# 使用方法: bash start_multitenant.sh [start|stop|status]

ACTION="${1:-start}"
export AWS_REGION=us-east-1
export STACK_NAME=openclaw-multitenancy

case "$ACTION" in
  stop)
    echo "サービスを停止中..."
    pkill -f 'bedrock_proxy' 2>/dev/null
    pkill -f 'tenant_router' 2>/dev/null
    echo "プロキシとルーターを停止しました (ゲートウェイは継続稼動)"
    ;;

  status)
    echo "=== サービス ==="
    ss -tlnp | grep -E '(18789|18792|8090|8091)' || echo "No services"
    ;;

  start)
    echo "マルチテナントサービスを起動中..."

    # 1. Bedrock プロキシ (ポート 8091)
    pkill -f 'bedrock_proxy' 2>/dev/null
    sleep 1
    TENANT_ROUTER_URL=http://127.0.0.1:8090 PROXY_PORT=8091 \
      python3 /home/ubuntu/bedrock_proxy.py >> /tmp/bedrock_proxy.log 2>&1 &
    echo "Bedrock Proxy PID=$!"

    # 2. テナントルーター (ポート 8090)
    pkill -f 'tenant_router' 2>/dev/null
    sleep 1
    python3 /home/ubuntu/tenant_router.py >> /tmp/tenant_router.log 2>&1 &
    echo "Tenant Router PID=$!"

    sleep 2
    echo "=== ポート ==="
    ss -tlnp | grep -E '(8090|8091)'

    # 3. OpenClaw をプロキシに切り替える (ゲートウェイが稼動中の場合)
    if ss -tlnp | grep -q 18789; then
      echo "ゲートウェイは既に稼動中です。baseUrl を更新します..."
      source /home/ubuntu/.nvm/nvm.sh
      openclaw config set models.providers.amazon-bedrock.baseUrl http://localhost:8091 2>/dev/null
      echo "baseUrl をプロキシに設定しました。変更を反映するにはゲートウェイの再起動が必要です。"
      echo "実行: openclaw gateway restart"
    fi
    echo "完了"
    ;;
esac
