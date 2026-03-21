# デプロイガイド

## 前提条件

### 1. AWS CLI をインストール

**macOS:**
```bash
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg AWSCLIV2.pkg -target /
```

**Linux:**
```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
```

### 2. SSM Session Manager Plugin をインストール

**macOS (ARM):**
```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac_arm64/session-manager-plugin.pkg" -o "session-manager-plugin.pkg"
sudo installer -pkg session-manager-plugin.pkg -target /
```

**Linux:**
```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o "session-manager-plugin.deb"
sudo dpkg -i session-manager-plugin.deb
```

### 3. AWS CLI を設定

```bash
aws configure
# AWS Access Key ID を入力
# AWS Secret Access Key を入力
# デフォルトリージョンを入力（例: us-west-2）
# デフォルト出力形式を入力（json）
```

### 4. EC2 キーペアを作成

```bash
aws ec2 create-key-pair \
  --key-name OpenClaw-key \
  --query 'KeyMaterial' \
  --output text > OpenClaw-key.pem

chmod 400 OpenClaw-key.pem
```

## デプロイ

### ワンクリックデプロイ（推奨）

GitHub リポジトリにアクセスし、対象リージョンの "Launch Stack" ボタンをクリックしてください。

https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock

### CLI による手動デプロイ

```bash
aws cloudformation create-stack \
  --stack-name OpenClaw-bedrock \
  --template-body file://openclaw-bedrock.yaml \
  --parameters \
    ParameterKey=KeyPairName,ParameterValue=OpenClaw-key \
    ParameterKey=openclawModel,ParameterValue=global.amazon.nova-2-lite-v1:0 \
    ParameterKey=InstanceType,ParameterValue=t4g.medium \
    ParameterKey=CreateVPCEndpoints,ParameterValue=true \
  --capabilities CAPABILITY_IAM \
  --region us-west-2

# 完了まで待機（約 8 分）
aws cloudformation wait stack-create-complete \
  --stack-name OpenClaw-bedrock \
  --region us-west-2
```

**デフォルト構成:**
- **Model**: Nova 2 Lite（Claude より 90% 安価で、日常用途に十分高性能）
- **Instance**: t4g.medium（Graviton ARM。t3.medium より 20% 安価）
- **VPC Endpoints**: 有効（プライベートネットワークでより安全）

## OpenClaw へのアクセス

### Step 1: インスタンス ID を取得

```bash
INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name OpenClaw-bedrock \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text \
  --region us-west-2)

echo $INSTANCE_ID
```

### Step 2: ポートフォワーディング開始

```bash
aws ssm start-session \
  --target $INSTANCE_ID \
  --region us-west-2 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["18789"],"localPortNumber":["18789"]}'
```

このターミナルは開いたままにしてください。

### Step 3: Gateway トークンを取得

新しいターミナルを開いて実行します。

```bash
# インスタンスへ接続
aws ssm start-session --target $INSTANCE_ID --region us-west-2

# ubuntu ユーザーへ切り替え
sudo su - ubuntu

# SSM Parameter Store からトークンを取得
aws ssm get-parameter --name /openclaw/openclaw-bedrock/gateway-token --with-decryption --query Parameter.Value --output text --region us-west-2
```

### Step 4: Web UI を開く

ブラウザで以下を開きます。
```text
http://localhost:18789/?token=<your-token>
```

## メッセージングプラットフォームの接続

詳細は [OpenClaw Documentation](https://docs.molt.bot/channels/) を参照してください。

### WhatsApp
1. Web UI で Channels → Add Channel → WhatsApp を開く
2. WhatsApp で QR コードを読み取る
3. テストメッセージを送信

### Telegram
1. [@BotFather](https://t.me/botfather) で bot を作成: `/newbot`
2. bot トークンを取得
3. Web UI で Telegram チャネルにトークンを設定
4. bot に `/start` を送信

### Discord
1. [Discord Developer Portal](https://discord.com/developers/applications) で bot を作成
2. bot トークンを取得し、Message Content intent を有効化
3. Web UI で Discord チャネルを設定
4. bot を自分のサーバーに招待

### Slack
1. [Slack API](https://api.slack.com/apps) でアプリを作成
2. bot token scopes（chat:write、channels:history）を設定
3. Web UI で Slack チャネルを設定
4. bot を各チャネルに招待

### Microsoft Teams

**Microsoft Teams 連携には Azure Bot の設定が必要です。**

📖 **完全ガイド**: https://docs.molt.bot/channels/msteams

## 動作確認

### セットアップ状態の確認

```bash
# SSM 経由で接続
aws ssm start-session --target $INSTANCE_ID --region us-west-2

# 状態確認
sudo su - ubuntu
cat ~/.openclaw/setup_status.txt

# セットアップログを確認
tail -100 /var/log/openclaw-setup.log

# サービス状態を確認
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user status openclaw-gateway
```

### Bedrock 接続テスト

```bash
# インスタンス上で実行
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)

aws bedrock-runtime invoke-model \
  --model-id global.amazon.nova-2-lite-v1:0 \
  --body '{"messages":[{"role":"user","content":[{"text":"Hello"}]}],"inferenceConfig":{"maxTokens":100}}' \
  --region $REGION \
  output.json

cat output.json
```

## 設定変更

### モデルを変更する

```bash
# インスタンスへ接続
sudo su - ubuntu

# 設定を編集
nano ~/.openclaw/openclaw.json

# models.providers.amazon-bedrock.models[0] の "id" を変更
# 利用可能なモデル:
# - global.amazon.nova-2-lite-v1:0 (default, cheapest)
# - global.anthropic.claude-sonnet-4-5-20250929-v1:0 (most capable)
# - us.amazon.nova-pro-v1:0 (balanced)
# - us.deepseek.r1-v1:0 (open-source reasoning)

# agents.defaults.model.primary も更新
# 例: "amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0"

# 再起動
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart openclaw-gateway
```

### インスタンスタイプを変更する

CloudFormation スタックを更新し、新しい `InstanceType` パラメータを指定します。

```bash
aws cloudformation update-stack \
  --stack-name OpenClaw-bedrock \
  --use-previous-template \
  --parameters \
    ParameterKey=InstanceType,ParameterValue=c7g.xlarge \
    ParameterKey=KeyPairName,UsePreviousValue=true \
    ParameterKey=openclawModel,UsePreviousValue=true \
  --capabilities CAPABILITY_IAM \
  --region us-west-2
```

**インスタンス選択肢:**
- **Graviton (ARM)**: t4g.small/medium/large/xlarge、c7g.large/xlarge（推奨）
- **x86**: t3.small/medium/large、c5.xlarge（代替）

## アップデート

### OpenClaw を更新

```bash
# SSM 経由で接続
sudo su - ubuntu

# 最新版へ更新
npm update -g openclaw

# サービス再起動
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart openclaw-gateway

# バージョン確認
openclaw --version
```

### CloudFormation テンプレートを更新

```bash
aws cloudformation update-stack \
  --stack-name OpenClaw-bedrock \
  --template-body file://openclaw-bedrock.yaml \
  --parameters \
    ParameterKey=KeyPairName,UsePreviousValue=true \
    ParameterKey=openclawModel,UsePreviousValue=true \
    ParameterKey=InstanceType,UsePreviousValue=true \
  --capabilities CAPABILITY_IAM \
  --region us-west-2
```

## クリーンアップ

```bash
# スタック削除（すべてのリソースを削除）
aws cloudformation delete-stack \
  --stack-name OpenClaw-bedrock \
  --region us-west-2

# 削除完了まで待機
aws cloudformation wait stack-delete-complete \
  --stack-name OpenClaw-bedrock \
  --region us-west-2
```

## コスト最適化

### 安価なモデルを使う
- **Nova 2 Lite**（デフォルト）: 100 万トークンあたり $0.30/$2.50。Claude より 90% 安価
- **Nova Pro**: 100 万トークンあたり $0.80/$3.20。Claude より 73% 安価
- **DeepSeek R1**: 100 万トークンあたり $0.55/$2.19。オープンソース代替

### Graviton インスタンスを使う（推奨）
- **t4g.medium**: $24/月（t3.medium は $30/月）で 20% 節約
- **c7g.xlarge**: $108/月（c5.xlarge は $122/月）で 11% 節約
- すべてのワークロードで優れた価格性能比

### VPC エンドポイントを無効化
`CreateVPCEndpoints=false` を設定すると月 22 ドル節約できます。ただしセキュリティは低下し、通信はインターネット経由になります。

### 小さいインスタンスを使う
- **t4g.small**: $12/月（個人利用なら十分）

### Savings Plans を使う
1 年または 3 年の Savings Plans を購入すると、EC2 コストを 30〜40% 割引できます。

## 次のステップ

- メッセージングチャネルを設定: https://docs.molt.bot/channels/
- スキルを確認: `openclaw skills list`
- 自動化を設定: `openclaw cron add "0 9 * * *" "Daily summary"`
- 高度な機能を試す: https://docs.molt.bot/

トラブルシューティングは [TROUBLESHOOTING.md](TROUBLESHOOTING.md) を参照してください。
