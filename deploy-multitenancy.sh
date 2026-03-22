#!/bin/bash
# =============================================================================
# OpenClaw マルチテナントプラットフォームのデプロイ — フルパイプライン
#
# このスクリプトは完全なマルチテナントプラットフォームをデプロイする:
#   1. CloudFormation スタック (EC2 + ECR + S3 + SSM + CloudWatch)
#   2. エージェントコンテナをビルドして ECR にプッシュ
#   3. SOUL.md テンプレートを S3 にアップロード
#   4. AgentCore Runtime を作成
#   5. Runtime ID を SSM に保存
#
# 使用方法: bash deploy-multitenancy.sh [STACK_NAME] [REGION]
# =============================================================================
set -euo pipefail

STACK_NAME="${1:-openclaw-multitenancy}"
REGION="${2:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "============================================"
echo "  OpenClaw マルチテナントプラットフォーム デプロイ"
echo "============================================"
echo "  スタック:   $STACK_NAME"
echo "  リージョン: $REGION"
echo "  アカウント: $ACCOUNT_ID"
echo ""

# =============================================================================
# ステップ 0: AWS CLI のアップグレード (bedrock-agentcore-control は CLI >= 2.27 が必要)
# =============================================================================
echo "[0/5] AWS CLI バージョンを確認中..."
CLI_VERSION=$(aws --version 2>&1 | grep -oP 'aws-cli/\K[0-9]+\.[0-9]+' || echo "0.0")
CLI_MAJOR=$(echo "$CLI_VERSION" | cut -d. -f1)
CLI_MINOR=$(echo "$CLI_VERSION" | cut -d. -f2)
if [ "$CLI_MAJOR" -lt 2 ] || ([ "$CLI_MAJOR" -eq 2 ] && [ "$CLI_MINOR" -lt 27 ]); then
    echo "  警告: AWS CLI $CLI_VERSION が検出されました。bedrock-agentcore-control には >= 2.27 が必要です"
    echo "  実行: pip install --upgrade awscli  または  brew upgrade awscli"
    echo "  このまま続行します — CLI が古すぎる場合はコマンドが失敗する可能性があります。"
fi

# =============================================================================
# ステップ 1: CloudFormation をデプロイ
# =============================================================================
echo "[1/5] CloudFormation スタックをデプロイ中..."

aws cloudformation create-stack \
    --stack-name "$STACK_NAME" \
    --template-body file://clawdbot-bedrock-agentcore-multitenancy.yaml \
    --capabilities CAPABILITY_NAMED_IAM \
    --region "$REGION" \
    --parameters \
        ParameterKey=KeyPairName,ParameterValue=none \
        ParameterKey=OpenClawModel,ParameterValue=global.amazon.nova-2-lite-v1:0 \
    2>/dev/null || echo "  スタックは既に存在する可能性があります。確認中..."

echo "  スタックの完了を待機中 (約 8 分かかります)..."
aws cloudformation wait stack-create-complete \
    --stack-name "$STACK_NAME" --region "$REGION" 2>/dev/null \
    || echo "  スタックは既に存在するか更新が必要です"

# 出力を取得
ECR_URI=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`MultitenancyEcrRepositoryUri`].OutputValue' \
    --output text)

EXECUTION_ROLE_ARN=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`AgentContainerExecutionRoleArn`].OutputValue' \
    --output text)

S3_BUCKET=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`TenantWorkspaceBucketName`].OutputValue' \
    --output text)

INSTANCE_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
    --output text)

echo "  ECR:        $ECR_URI"
echo "  ロール:     $EXECUTION_ROLE_ARN"
echo "  S3:         $S3_BUCKET"
echo "  インスタンス: $INSTANCE_ID"

# =============================================================================
# ステップ 2: SOUL.md テンプレートを S3 にアップロード
# =============================================================================
echo ""
echo "[2/5] SOUL.md テンプレートを S3 にアップロード中..."

aws s3 cp agent-container/templates/default.md "s3://${S3_BUCKET}/_shared/templates/default.md" --region "$REGION"
aws s3 cp agent-container/templates/intern.md "s3://${S3_BUCKET}/_shared/templates/intern.md" --region "$REGION"
aws s3 cp agent-container/templates/engineer.md "s3://${S3_BUCKET}/_shared/templates/engineer.md" --region "$REGION"
echo "  3 つのテンプレートをアップロードしました"

# =============================================================================
# ステップ 3: エージェントコンテナをビルドして ECR にプッシュ
# =============================================================================
echo ""
echo "[3/5] エージェントコンテナをビルドして ECR にプッシュ中..."

aws ecr get-login-password --region "$REGION" | \
    docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "  Docker イメージをビルド中 (platform=linux/arm64)..."
docker build --platform linux/arm64 -f agent-container/Dockerfile -t "${ECR_URI}:latest" .

echo "  ECR にプッシュ中..."
docker push "${ECR_URI}:latest"
echo "  イメージをプッシュしました: ${ECR_URI}:latest"

# =============================================================================
# ステップ 4: AgentCore Runtime を作成
# =============================================================================
echo ""
echo "[4/5] AgentCore Runtime を作成中..."

RUNTIME_ID=$(aws bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name "${STACK_NAME//-/_}_runtime" \
    --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"'"${ECR_URI}:latest"'"}}' \
    --role-arn "$EXECUTION_ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --lifecycle-configuration '{"idleRuntimeSessionTimeout":300,"maxLifetime":3600}' \
    --environment-variables STACK_NAME="${STACK_NAME}",AWS_REGION="${REGION}",S3_BUCKET="${S3_BUCKET}",BEDROCK_MODEL_ID="global.amazon.nova-2-lite-v1:0" \
    --region "$REGION" \
    --query 'agentRuntimeId' --output text 2>&1) || {
    echo "  create-agent-runtime 失敗: $RUNTIME_ID"
    echo "  SSM から既存のランタイム ID を取得しようとしています..."
    RUNTIME_ID=$(aws ssm get-parameter \
        --name "/openclaw/${STACK_NAME}/runtime-id" \
        --query Parameter.Value --output text \
        --region "$REGION" 2>/dev/null || echo "UNKNOWN")
}

echo "  ランタイム ID: $RUNTIME_ID"

# =============================================================================
# ステップ 5: AgentCore Runtime エンドポイントを作成
# =============================================================================
echo ""
echo "[5/6] AgentCore Runtime エンドポイントを作成中..."

ENDPOINT_NAME="${STACK_NAME//-/_}_endpoint"
aws bedrock-agentcore-control create-agent-runtime-endpoint \
    --agent-runtime-id "$RUNTIME_ID" \
    --name "$ENDPOINT_NAME" \
    --region "$REGION" \
    --query 'agentRuntimeEndpointArn' --output text 2>&1 || {
    echo "  エンドポイントは既に存在するか、ランタイムがまだ準備できていません。"
    echo "  ランタイムのステータスが READY になってから後で作成できます。"
}

# =============================================================================
# ステップ 6: Runtime ID を SSM に保存
# =============================================================================
echo ""
echo "[6/6] SSM に Runtime ID を保存中..."

aws ssm put-parameter \
    --name "/openclaw/${STACK_NAME}/runtime-id" \
    --value "$RUNTIME_ID" \
    --type String \
    --overwrite \
    --region "$REGION"

echo "  /openclaw/${STACK_NAME}/runtime-id に保存しました"

# =============================================================================
# 完了
# =============================================================================
echo ""
echo "============================================"
echo "  デプロイ完了!"
echo "============================================"
echo ""
echo "  スタック:      $STACK_NAME"
echo "  ランタイム ID: $RUNTIME_ID"
echo "  S3 バケット:   $S3_BUCKET"
echo "  インスタンス:  $INSTANCE_ID"
echo ""
echo "  次のステップ:"
echo "  1. EC2 に接続: aws ssm start-session --target $INSTANCE_ID --region $REGION"
echo "  2. OpenClaw Web UI で Telegram ボットを設定"
echo "  3. テナントルーターを起動:"
echo "     export STACK_NAME=$STACK_NAME AWS_REGION=$REGION AGENTCORE_RUNTIME_ID=$RUNTIME_ID"
echo "     python3 src/gateway/tenant_router.py"
echo "  4. Telegram でメッセージを送信してテスト!"
echo ""
