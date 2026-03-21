# OpenClaw on AWS with Bedrock

> AWS 上で動く、あなただけの AI アシスタント。WhatsApp、Telegram、Discord、Slack に接続できます。Amazon Bedrock を使用。API キー不要。ワンクリックでデプロイ。月額およそ 40 ドル。

English | [简体中文](README_CN.md) | 日本語

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![AWS](https://img.shields.io/badge/AWS-Bedrock-orange.svg)](https://aws.amazon.com/bedrock/)
[![CloudFormation](https://img.shields.io/badge/IaC-CloudFormation-blue.svg)](https://aws.amazon.com/cloudformation/)

## このプロジェクトの目的

[OpenClaw](https://github.com/openclaw/openclaw) は、急成長中のオープンソース AI アシスタントです。自分のハードウェア上で動作し、メッセージングアプリと接続し、実際に作業をこなします。メール管理、Web 閲覧、コマンド実行、タスクのスケジュールまで可能です。

問題は、セットアップ時に複数プロバイダーの API キー管理、VPN の設定、セキュリティ対策をすべて自分で担う必要があることです。

このプロジェクトはそこを解決します。1 つの CloudFormation スタックで、以下をまとめて構築できます。

- **Amazon Bedrock** によるモデル利用。10 種類のモデル、統一 API、IAM 認証を提供し、API キーは不要です
- **Graviton ARM インスタンス** により、x86 より 20〜40% 安価です
- **SSM Session Manager** により、ポートを開放せず安全にアクセスできます
- **VPC エンドポイント** により、通信を AWS のプライベートネットワーク内に留められます
- **CloudTrail** により、すべての API 呼び出しが自動で監査されます

デプロイは約 8 分。スマートフォンから利用できます。

## クイックスタート

### ワンクリックデプロイ

1. 利用するリージョンの "Launch Stack" をクリック
2. EC2 キーペアを選択
3. 約 8 分待機
4. Outputs タブを確認

| Region | Launch |
|--------|--------|
| **US West (Oregon)** | [![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-west-2#/stacks/create/review?stackName=openclaw-bedrock&templateURL=https://sharefile-jiade.s3.cn-northwest-1.amazonaws.com.cn/clawdbot-bedrock.yaml) |
| **US East (Virginia)** | [![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?stackName=openclaw-bedrock&templateURL=https://sharefile-jiade.s3.cn-northwest-1.amazonaws.com.cn/clawdbot-bedrock.yaml) |
| **EU (Ireland)** | [![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/create/review?stackName=openclaw-bedrock&templateURL=https://sharefile-jiade.s3.cn-northwest-1.amazonaws.com.cn/clawdbot-bedrock.yaml) |
| **Asia Pacific (Tokyo)** | [![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/review?stackName=openclaw-bedrock&templateURL=https://sharefile-jiade.s3.cn-northwest-1.amazonaws.com.cn/clawdbot-bedrock.yaml) |

> **前提条件**: 対象リージョンで EC2 キーペアを作成し、[Bedrock Console](https://console.aws.amazon.com/bedrock/) で Bedrock モデルを有効化してください。

### デプロイ後

![CloudFormation Outputs](images/20260305-215111.png)

> 🦞 **Web UI を開いて、まずは話しかけてください。** すべてのメッセージングプラグイン（WhatsApp、Telegram、Discord、Slack、Feishu）は事前インストール済みです。接続したいプラットフォームを OpenClaw に伝えると、設定手順を最初から最後まで案内してくれます。手動設定は不要です。

```bash
# 1. SSM Session Manager Plugin をインストール（初回のみ）
#    https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html

# 2. ポートフォワーディングを開始（このターミナルは開いたままにする）
INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name openclaw-bedrock \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text --region us-west-2)

aws ssm start-session \
  --target $INSTANCE_ID \
  --region us-west-2 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["18789"],"localPortNumber":["18789"]}'

# 3. トークンを取得（別ターミナル）
TOKEN=$(aws ssm get-parameter \
  --name /openclaw/openclaw-bedrock/gateway-token \
  --with-decryption \
  --query Parameter.Value \
  --output text --region us-west-2)

# 4. ブラウザで開く
echo "http://localhost:18789/?token=$TOKEN"
```

### CLI デプロイ（代替）

```bash
aws cloudformation create-stack \
  --stack-name openclaw-bedrock \
  --template-body file://clawdbot-bedrock.yaml \
  --parameters ParameterKey=KeyPairName,ParameterValue=your-keypair \
  --capabilities CAPABILITY_IAM \
  --region us-west-2

aws cloudformation wait stack-create-complete \
  --stack-name openclaw-bedrock --region us-west-2
```

### 🎯 Kiro AI でデプロイ

対話型の案内がほしい場合は、[Kiro](https://kiro.dev/) を使えます。このリポジトリをワークスペースとして開き、"help me deploy OpenClaw" と伝えてください。

**[→ Kiro デプロイガイド](QUICK_START_KIRO.md)**

---

## メッセージングプラットフォーム接続

デプロイ後、Web UI の "Channels" から利用したいプラットフォームを接続します。

| Platform | Setup | Guide |
|----------|-------|-------|
| **WhatsApp** | スマートフォンで QR コードを読み取る | [docs](https://docs.openclaw.ai/channels/whatsapp) |
| **Telegram** | [@BotFather](https://t.me/botfather) で bot を作成し、トークンを貼り付ける | [docs](https://docs.openclaw.ai/channels/telegram) |
| **Discord** | Developer Portal でアプリを作成し、bot トークンを貼り付ける | [docs](https://docs.openclaw.ai/channels/discord) |
| **Slack** | api.slack.com でアプリを作成し、ワークスペースにインストールする | [docs](https://docs.openclaw.ai/channels/slack) |
| **Microsoft Teams** | Azure Bot の設定が必要 | [docs](https://docs.openclaw.ai/channels/msteams) |
| **Lark / Feishu** | コミュニティプラグイン: [openclaw-feishu](https://www.npmjs.com/package/openclaw-feishu) | — |

**完全なプラットフォームドキュメント**: [docs.openclaw.ai](https://docs.openclaw.ai/)

---

## OpenClaw にできること

接続が完了したら、そのままメッセージを送るだけです。

```text
You: 東京の天気を教えて
You: この PDF を要約して [ファイル添付]
You: 毎朝 9 時にメール確認をリマインドして
You: google.com を開いて "AWS Bedrock pricing" を検索して
```

| Command | 内容 |
|---------|------|
| `/status` | モデル、使用トークン数、コストを表示 |
| `/new` | 新しい会話を開始 |
| `/think high` | 深い推論モードを有効化 |
| `/help` | 使用可能コマンドを一覧表示 |

音声メッセージは WhatsApp と Telegram で利用可能です。OpenClaw が音声を文字起こしし、応答します。

---

## アーキテクチャ

```text
あなた (WhatsApp/Telegram/Discord)
  │
  ▼
┌─────────────────────────────────────────────┐
│  AWS Cloud                                  │
│                                             │
│  EC2 (OpenClaw)  ──IAM──▶  Bedrock         │
│       │                   (Nova/Claude)     │
│       │                                     │
│  VPC Endpoints        CloudTrail            │
│  (private network)    (audit logs)          │
└─────────────────────────────────────────────┘
  │
  ▼
あなた (応答を受信)
```

- **EC2**: OpenClaw gateway を実行（約 1GB RAM）
- **Bedrock**: IAM 経由でモデル推論を実行（API キー不要）
- **SSM**: パブリックポートを開けずに安全にアクセス
- **VPC Endpoints**: Bedrock への通信をプライベートネットワークで実行（任意、+22 ドル/月）

---

## モデル

CloudFormation パラメータを 1 つ変えるだけでモデルを切り替えられます。コード変更は不要です。

| Model | Input/Output per 1M tokens | 最適な用途 |
|-------|---------------------------|------------|
| **Nova 2 Lite** (default) | $0.30 / $2.50 | 日常タスク。Claude より 90% 安価 |
| Nova Pro | $0.80 / $3.20 | バランス重視。マルチモーダル対応 |
| Claude Sonnet 4.5 | $3.00 / $15.00 | 複雑な推論、コーディング |
| Claude Haiku 4.5 | $1.00 / $5.00 | 高速かつ効率的 |
| DeepSeek R1 | $0.55 / $2.19 | オープンソース推論 |
| Llama 3.3 70B | — | オープンソースの代替 |
| Kimi K2.5 | $0.60 / $3.00 | マルチモーダル・エージェント型、262K コンテキスト |

> [Global CRIS profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html) を使用しています。どのリージョンにデプロイしても、リクエストは最適なロケーションへ自動ルーティングされます。

---

## コスト

### 典型的な月額コスト（軽負荷利用）

| Component | Cost |
|-----------|------|
| EC2 (t4g.medium, Graviton) | $24 |
| EBS (30GB gp3) | $2.40 |
| VPC Endpoints (optional) | $22 |
| Bedrock (Nova 2 Lite, ~100 conv/day) | $5-8 |
| **Total** | **$31-56** |

### コストを抑える方法

- Claude の代わりに Nova 2 Lite を使う → 90% 安価
- x86 の代わりに Graviton (ARM) を使う → 20〜40% 安価
- VPC エンドポイントを省略する → 月 22 ドル削減（その分セキュリティは低下）
- AWS Savings Plans を使う → EC2 が 30〜40% 割引

### 他の選択肢との比較

| Option | Cost | 得られるもの |
|--------|------|--------------|
| ChatGPT Plus | $20/人/月 | 単一ユーザー、統合なし |
| This project (5 users) | ~$10/人/月 | マルチユーザー、WhatsApp/Telegram/Discord、完全な制御 |
| Local Mac Mini | サーバー費 $0 + API 費 $20-30 | ハードウェア費用、自己運用 |

---

## 設定

### インスタンスタイプ

| Type | Monthly | RAM | Architecture | Use case |
|------|---------|-----|-------------|----------|
| t4g.small | $12 | 2GB | Graviton ARM | 個人利用 |
| **t4g.medium** | **$24** | **4GB** | **Graviton ARM** | **小規模チーム（デフォルト）** |
| t4g.large | $48 | 8GB | Graviton ARM | 中規模チーム |
| c7g.xlarge | $108 | 8GB | Graviton ARM | 高性能用途 |
| t3.medium | $30 | 4GB | x86 | x86 互換性が必要な場合 |

### パラメータ

| Parameter | Default | Description |
|-----------|---------|-------------|
| `OpenClawModel` | Nova 2 Lite | Bedrock モデル ID |
| `InstanceType` | c7g.large | EC2 インスタンスタイプ |
| `CreateVPCEndpoints` | true | プライベートネットワークを使用（+22 ドル/月） |
| `EnableSandbox` | true | コード実行用の Docker 分離 |
| `CreateS3Bucket` | true | ファイル共有スキル用 S3 バケット |
| `InstallS3FilesSkill` | true | S3 ファイル共有を自動インストール |
| `KeyPairName` | none | EC2 キーペア（任意。緊急時 SSH 用） |

---

## デプロイオプション

### Standard (EC2) — この README の対象

ほとんどのユーザーに最適です。固定コスト、完全制御、24 時間 365 日稼働。

### マルチテナントプラットフォーム（AgentCore Runtime） — [README_AGENTCORE.md](README_AGENTCORE.md)

> ✅ **E2E 検証済み** — IM → Gateway → Bedrock H2 Proxy → Tenant Router → AgentCore Firecracker microVM → OpenClaw CLI → Bedrock → 応答、までフルパイプラインで動作確認済みです。[デモガイド →](demo/README.md)

OpenClaw を単一ユーザー向けツールから企業向けプラットフォームへ拡張します。各社員は Firecracker microVM 上で分離された AI アシスタントを持ち、共有スキル、中央統制、テナント単位の権限制御を利用できます。OpenClaw のコード変更は不要です。

```text
Telegram/WhatsApp のメッセージ
  → OpenClaw Gateway (IM channels, Web UI)
  → Bedrock H2 Proxy (AWS SDK の HTTP/2 呼び出しを横取り)
  → Tenant Router (社員ごとに tenant_id を導出)
  → AgentCore Runtime (Firecracker microVM、テナント分離)
  → OpenClaw CLI → Bedrock Nova 2 Lite
  → 応答が社員の IM に返る
```

| 提供機能 | 方法 | 状態 |
|---|---|---|
| テナント分離 | ユーザーごとに Firecracker microVM (AgentCore Runtime) | ✅ Verified |
| モデルアクセス共有 | 1 つの Bedrock アカウントを共有し、テナント別にメータリング（約 $1-2/人/月） | ✅ Verified |
| テナント別権限プロファイル | SSM ベースのルール、Plan A（プロンプト注入）+ Plan E（監査） | ✅ Verified |
| IM チャネル管理 | 単一ユーザー版と同じ方法で設定（WhatsApp/Telegram/Discord） | ✅ Verified |
| OpenClaw コード変更ゼロ | すべて外部レイヤー（proxy、router、entrypoint）で制御 | ✅ Verified |
| SaaS キー同梱の共有スキル | 一度だけインストールし、テナントごとに認可 | 🔜 Next |
| 人手承認ワークフロー | Auth Agent → 管理者通知 → 承認 / 却下 | 🔜 Next |
| 弾性コンピュート | Auto-scaling microVM、バースト対応、従量課金 | ✅ Verified |

| Metric | Value |
|--------|-------|
| Cold start (user-perceived) | 約 3 秒（fast-path で Bedrock 直呼び） |
| Cold start (real microVM) | 約 22〜25 秒（バックグラウンドで起動し、ユーザーは待たない） |
| Warm request | 約 5〜10 秒 |
| 50 ユーザー時のコスト | 約 $65-110/月（約 $1.30-2.20/人） |
| ChatGPT Plus 50 人分との比較 | $1,000/月 |

**[→ 完全なマルチテナントガイド](README_AGENTCORE.md)** · **[→ デモガイド](demo/README.md)** · **[→ ロードマップ](ROADMAP.md)**

### macOS (Apple Silicon) — iOS/macOS 開発向け

| Type | Chip | RAM | Monthly |
|------|------|-----|---------|
| mac2.metal | M1 | 16GB | $468 |
| mac2-m2.metal | M2 | 24GB | $632 |
| mac2-m2pro.metal | M2 Pro | 32GB | $792 |

> 最低 24 時間の割り当てが必要です。Apple 開発ワークフロー専用として使ってください。一般用途では Linux の方が 12 倍安価です。

| Region | Launch |
|--------|--------|
| **US West (Oregon)** | [![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-west-2#/stacks/create/review?stackName=openclaw-mac&templateURL=https://sharefile-jiade.s3.cn-northwest-1.amazonaws.com.cn/clawdbot-bedrock-mac.yaml) |
| **US East (Virginia)** | [![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?stackName=openclaw-mac&templateURL=https://sharefile-jiade.s3.cn-northwest-1.amazonaws.com.cn/clawdbot-bedrock-mac.yaml) |

### 🇨🇳 AWS 中国（北京 / 寧夏）

Bedrock の代わりに SiliconFlow（DeepSeek、Qwen、GLM）を使用します。SiliconFlow API キーが必要です。

| Region | Launch |
|--------|--------|
| **cn-north-1 (Beijing)** | [![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://cn-north-1.console.amazonaws.cn/cloudformation/home?region=cn-north-1#/stacks/create/review?stackName=openclaw-china&templateURL=https://sharefile-jiade.s3.cn-northwest-1.amazonaws.com.cn/clawdbot-china.yaml) |
| **cn-northwest-1 (Ningxia)** | [![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://cn-northwest-1.console.amazonaws.cn/cloudformation/home?region=cn-northwest-1#/stacks/create/review?stackName=openclaw-china&templateURL=https://sharefile-jiade.s3.cn-northwest-1.amazonaws.com.cn/clawdbot-china.yaml) |

**[→ China Deployment Guide (中国区部署指南)](DEPLOYMENT_CN.md)**

---

## セキュリティ

| Layer | 内容 |
|-------|------|
| **IAM Roles** | API キー不要。認証情報は自動ローテーション |
| **SSM Session Manager** | パブリックポート不要、セッションログ取得可 |
| **VPC Endpoints** | Bedrock 通信をプライベートネットワーク内に維持 |
| **SSM Parameter Store** | Gateway トークンを SecureString として保存し、ディスクへ残さない |
| **Supply-chain protection** | Docker は GPG 署名済みリポジトリ経由、NVM はダウンロード後に実行（`curl \| sh` なし） |
| **Docker Sandbox** | グループチャットでのコード実行を分離 |
| **CloudTrail** | すべての Bedrock API 呼び出しを監査 |

**[→ 完全なセキュリティガイド](SECURITY.md)**

---

## コミュニティスキル

OpenClaw 用の拡張機能です。

- [S3 Files Skill](skills/s3-files-skill/) — 事前署名 URL を使って S3 経由でファイルをアップロード・共有（デフォルトで自動インストール）
- [Kiro CLI Skill](skills/openclaw-kirocli-skill/) — Kiro CLI による AI 支援コーディング
- [AWS Backup Skill](https://github.com/genedragon/openclaw-aws-backup-skill) — 任意で KMS 暗号化も使える S3 バックアップ / リストア

---

## SSM による SSH ライクなアクセス

```bash
# 対話セッションを開始
aws ssm start-session --target i-xxxxxxxxx --region us-east-1

# ubuntu ユーザーへ切り替え
sudo su - ubuntu

# OpenClaw コマンドを実行
openclaw --version
openclaw gateway status
```

---

## トラブルシューティング

よくある問題と対処法: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

手順ごとの詳細デプロイガイド: [DEPLOYMENT.md](DEPLOYMENT.md)

---

## コントリビュート

単一ユーザー向けデプロイからマルチテナント SaaS まで、エンタープライズ OpenClaw プラットフォームをオープンに構築しています。エンタープライズアーキテクト、スキル開発者、セキュリティ研究者、あるいは単により良い AI アシスタントを求める人まで、参加できる余地があります。

特に支援を必要としている領域:
- エンドツーエンドのマルチテナント検証
- SaaS 資格情報同梱型のスキル（Jira、Salesforce、SAP）
- エージェント間オーケストレーション
- コストベンチマーク（AgentCore と EC2 の比較）
- セキュリティ監査とペネトレーションテスト

**[→ ロードマップ](ROADMAP.md)** · **[→ コントリビュートガイド](CONTRIBUTING.md)** · **[→ GitHub Issues](https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock/issues)**

## リソース

- [OpenClaw Docs](https://docs.openclaw.ai/) · [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [Amazon Bedrock Docs](https://docs.aws.amazon.com/bedrock/) · [SSM Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
- [OpenClaw on Lightsail](https://aws.amazon.com/blogs/aws/introducing-openclaw-on-amazon-lightsail-to-run-your-autonomous-private-ai-agents/)（公式 AWS ブログ）

## サポート

- **このプロジェクト**: [GitHub Issues](https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock/issues)
- **OpenClaw**: [GitHub Issues](https://github.com/openclaw/openclaw/issues) · [Discord](https://discord.gg/openclaw)
- **AWS Bedrock**: [AWS re:Post](https://repost.aws/tags/bedrock)

---

**Built with Kiro** 🦞
