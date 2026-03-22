# OpenClaw Multi-Tenant Platform on AWS

> すべての社員に AI アシスタントを。すべてのチームに AI アシスタントを。すべての部門に AI アシスタントを。明確な境界、共有可能な能力、中央集権的なガバナンスを備えたものです。これはエンタープライズ OpenClaw であり、個人向け AI ツールから組織向け AI プラットフォームへ進むための道筋です。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![AWS](https://img.shields.io/badge/AWS-Bedrock-orange.svg)](https://aws.amazon.com/bedrock/)
[![Status](https://img.shields.io/badge/Status-In%20Development-yellow.svg)]()

> ⚠️ **開発中** — コアコンポーネントは実装済みです。エンドツーエンドの統合テストを進めています。コントリビューターを募集しています。詳細は [How to Contribute](#how-to-contribute) を参照してください。

---

## 課題

OpenClaw は最も高機能なオープンソース AI アシスタントの 1 つですが、前提は「1 ユーザーが 1 台のマシンで使う」ことです。

企業では次のジレンマが生じます。

- **500 個の個別インスタンス?** API キー管理が 500 件、監査されていないエージェントが 500 件、セキュリティ事故の可能性も 500 件分になります。能力共有もできず、中央ガバナンスもありません。コストは線形に増加します。
- **1 個の共有インスタンス?** テナント分離がありません。権限制御もありません。1 人のプロンプトインジェクションで全員に影響します。OpenClaw 自身の [security policy](https://github.com/openclaw/openclaw/security) でも gateway はマルチテナントのセキュリティ境界ではないと明言されています。

どちらも不十分です。企業にはプラットフォームが必要です。

---

## なぜマルチテナントが重要か: 7 つの価値提案

### 1. 統合モデルアクセス — リソースを束ねてコストを削減

個別デプロイは個別 API コストを意味します。マルチテナント基盤では、1 つの Amazon Bedrock アカウントと IAM 認証のもとにモデルアクセスを集約します。API キーの管理、ローテーション、漏えいリスクは不要です。

コスト構造は大きく変わります。

| Approach | Cost for 50 users |
|----------|-------------------|
| ChatGPT Plus ($20/person) | **$1,000/month** |
| 50 separate OpenClaw instances | **$2,000+/month** (50 × EC2 + 50 × API keys) |
| This platform (shared infrastructure) | **$65-110/month** (~$1.30-2.20/person) |

各テナントは共有モデルプールを利用し、プラットフォーム側でテナント別に課金配賦できます。単一アカウントによる Bedrock 一括利用は、個別購読より低い単価を実現します。つまり「化零为整」、分散した個人コストを組織全体の節約へ変える構造です。

### 2. SaaS 認証情報を同梱した共有スキル

スキルは OpenClaw のキラー機能です。実世界の能力をエージェントに追加できます。マルチテナント基盤では、スキルは組織の共有資産になります。

- **IT が Jira スキルを導入**し、組織の Jira API キーを組み込む。認可された社員のエージェントは、チケット作成、スプリント照会、Issue 更新を行えるが、社員自身が Jira API キーを見ることはない。
- **Finance が SAP スキルを導入**し、SAP 接続資格情報を組み込む。財務系エージェントは財務データを問い合わせるが、資格情報はスキルコンテナから外に出ない。
- **HR が Workday スキルを導入**し、社員は「有給残日数は?」とエージェントに聞くだけでよい。認証処理はスキルが透過的に処理する。

基本パターンはこうです。**IT がスキルカタログと資格情報を管理し、社員は能力だけを利用する。** スキルはプラットフォームに 1 回インストールし、テナントプロファイルごとに認可され、各テナントの分離 microVM の中で実行されます。SaaS キーはスキルパッケージ内に留まり、テナントは「能力」を使うだけで「秘密情報」は扱いません。

### 3. テナント単位の企業ルール — 個別最適なガバナンス

各テナントは SSM Parameter Store に保存された permission profile を持ちます。プラットフォームは 2 つの手法を組み合わせてこれを強制します。

- **Plan A（ソフト強制）**: 許可されたツール一覧を system prompt に注入し、LLM に境界を認識させる
- **Plan E（監査）**: 実行後に応答を検査し、禁止ツール利用を検出したら tenant ID、tool 名、timestamp とともに CloudWatch へ記録する

現実的な例:

| Role | Allowed Tools | Blocked | Rationale |
|------|--------------|---------|-----------|
| Intern | web_search | Everything else | リスク面を最小化 |
| Finance analyst | web_search, file (read-only) | shell, code_execution | 財務データは読めるが、システム操作は不可 |
| Senior engineer | web_search, shell, file, code_execution | install_skill, eval | 開発能力はフル、サプライチェーンリスクは制限 |
| IT admin | All except install_skill, eval | — | 最大能力を持たせつつ安全策も維持 |

ルールは SSM 経由で更新でき、再デプロイは不要です。プロファイルを変更すれば、次のリクエストから即座に新ルールが反映されます。

### 4. 制御された情報共有とメモリ共有

既定ではテナントは分離されています。各テナントは Firecracker microVM 内の独立したファイルシステム、メモリ、CPU 上で実行され、テナント間データ漏えいを防ぎます。

ただし企業には「制御された共有」も必要です。本基盤では、明示的な共有シナリオをサポートします。

- **Team → Department**: チームエージェントが週次レポートを作成し、部門エージェントはその要約のみ読める。生会話やツール実行ログは読めない
- **Department → Executive**: 部門エージェントが四半期指標を作成し、経営層エージェントが部門横断サマリを集約する
- **Project → Cross-functional**: エンジニアリング、デザイン、プロダクトをまたぐプロジェクトエージェントが、project ID に紐づく範囲だけ各チーム出力を参照する
- **Knowledge base sharing**: 会社ポリシー、製品ドキュメント、承認済み手順などは全テナントで read-only 共有し、個別の会話履歴や個人メモは非公開に保つ

原則は明確です。**共有は opt-in、スコープ付き、監査可能であること。** 境界を超えたすべてのデータアクセスは記録されます。暗黙共有や「全員が全部見える」状態はありません。

### 5. スキル・マーケットプレイスのエコシステム

社内スキルだけでなく、マーケットプレイス型の発展も可能です。

- **サードパーティ開発者** が必要権限とセキュリティレビュー結果を宣言したスキルを公開
- **プラットフォーム運営者** がカタログをキュレーションし、セキュリティ観点で承認・却下・保留を判断
- **テナント** はスキルを閲覧し、利用申請する。承認されたスキルだけがその permission profile 内で使える

言い換えると「AI エージェント用アプリストア」です。各スキルは以下を宣言します。
- 必要ツール（shell、file_write、API access など）
- アクセスするデータ
- 同梱する SaaS 資格情報
- セキュリティ監査状況

これは OpenClaw エコシステムの土台です。公開スキルが増えるほどプラットフォーム価値が高まり、各組織はコミュニティの成果を活用できます。

### 6. 企業ワークロード向けの弾性コンピュート

AgentCore Runtime はゼロから数千同時実行の Firecracker microVM までスケールできます。単一 EC2 では不可能な企業ワークロードが可能になります。

- **夜間バッチ処理**: 1 万件の顧客サポートチケットを一晩で分析。100 microVM を並列起動し、処理後に停止。常時稼働 EC2 ではなく、必要時間分だけ課金
- **定期レポート**: 毎週月曜 8 時に 50 部門エージェントが同時に週報生成。待ち行列やボトルネックなし
- **バースト対応**: 新製品発売日に通常の 10 倍のメッセージ流量。AgentCore が自動スケールし、事前容量設計や過剰プロビジョニングが不要
- **重い計算**: コードレビューエージェントが 100 ファイル規模の PR を深い推論で解析。8GB RAM と 5 分の計算が必要でも、専用 microVM で他テナントに影響なし

使った分だけ支払うモデルです。遊休コストも、容量計画も不要です。

### 7. エージェント階層 — 組織の神経系

```text
┌─────────────────────────────────────────────────────────────┐
│  Organization Agent                                         │
│  (company-wide policies, cross-department coordination)     │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────┐ │
│  │ Engineering Dept │  │ Finance Dept    │  │ Sales Dept │ │
│  │ Agent            │  │ Agent           │  │ Agent      │ │
│  │                  │  │                 │  │            │ │
│  │ ┌──┐ ┌──┐ ┌──┐ │  │ ┌──┐ ┌──┐      │  │ ┌──┐ ┌──┐ │ │
│  │ │A │ │B │ │C │ │  │ │D │ │E │      │  │ │F │ │G │ │ │
│  │ └──┘ └──┘ └──┘ │  │ └──┘ └──┘      │  │ └──┘ └──┘ │ │
│  └─────────────────┘  └─────────────────┘  └────────────┘ │
└─────────────────────────────────────────────────────────────┘

A-G = 個々の社員エージェント
各ボックス = 独自の権限、メモリ、ID を持つ分離 microVM
ボックス間の矢印 = 制御・監査された通信チャネル
```

各エージェントは以下を持ちます。
- **固有の ID**: tenant_id、permission profile、session history
- **固有の権限**: アクセスできるツール、データ、API
- **固有のメモリ**: 会話履歴、メモ、学習済みの嗜好
- **制御された通信**: 共有状態ではなく、明示的なチャネル越しに他エージェントとやり取り

チームエージェントはメンバーのエージェントへ進捗確認を依頼でき、部門エージェントはチーム出力を集約し、経営エージェントは部門横断の要約を作れます。ただし Alice のエージェントが Bob の個人会話を読むことはできず、営業部エージェントが開発部のデプロイ用ツールを実行することもできません。

**これが将来像です。** 単なるチャットボットではなく、組織の神経系。OpenClaw-the-tool ではなく OpenClaw-the-platform。これがエンタープライズ OpenClaw SaaS の姿であり、OpenClaw MSP（Managed Service Provider）が提供する価値です。

![OpenClaw Multi-Tenant Admin Console](images/20260305-214028.jpeg)

### 今すぐ試す

```bash
# 視覚的な admin console（AWS 不要）
python3 demo/console.py
# http://localhost:8099 を開く

# ターミナルデモ（7 シナリオ）
python3 demo/run_demo.py

# AWS デモ（実際の Bedrock 推論、EC2 必須）
bash demo/setup_aws_demo.sh
python3 demo/aws_demo.py
```

Admin Console では、テナント管理、権限編集、申請承認、監査ログ確認、異なるテナントとしてのライブメッセージ送信をすべてブラウザから行えます。**[→ Demo Guide](demo/README.md)**

---

## 現時点での動作方式

```text
Users (WhatsApp / Telegram / Discord / Slack)
  │
  ▼
┌──────────────────────────────────────────────────────┐
│  EC2 Gateway (常駐)                                  │
│                                                      │
│  OpenClaw Gateway (Node.js, port 18789)              │
│  ├── IM channel 管理 (WhatsApp/Telegram/Discord)     │
│  ├── Web UI + Control UI                             │
│  └── Bedrock Converse API 呼び出し（H2 Proxy が横取り）│
│                                                      │
│  Bedrock H2 Proxy (Node.js, port 8091)               │
│  ├── AWS SDK HTTP/2 の Bedrock リクエストを横取り     │
│  ├── ユーザーメッセージ + channel/sender を抽出       │
│  ├── コールドスタート: fast-path で Bedrock 直呼び（約 3 秒）│
│  ├── 同時に非同期で microVM を予熱（バックグラウンド）│
│  └── ホットパス: Tenant Router へ転送                 │
│                                                      │
│  Tenant Router (Python, port 8090)                   │
│  ├── derive_tenant_id(channel, user_id) → 33+ chars  │
│  └── AgentCore Runtime を invoke（sessionId=tenant_id）│
└──────────────────────┬───────────────────────────────┘
                       │ AWS_ENDPOINT_URL_BEDROCK_RUNTIME
                       │ → H2 Proxy → Tenant Router
                       │ → AgentCore invoke_agent_runtime
                       ▼
┌──────────────────────────────────────────────────────┐
│  AgentCore Runtime（serverless Firecracker microVM） │
│  各 tenant は独立 microVM（sessionId ごと）           │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  Agent Container                               │  │
│  │  entrypoint.sh:                                │  │
│  │    1. openclaw.json を書き込む（Bedrock 設定） │  │
│  │    2. server.py を起動（health check ready）   │  │
│  │    3. S3 から workspace を pull               │  │
│  │    4. Watchdog が workspace を S3 へ sync     │  │
│  │                                                │  │
│  │  server.py /invocations:                       │  │
│  │    1. headers/payload から tenant_id を抽出    │  │
│  │    2. 権限を注入（Plan A）                     │  │
│  │    3. openclaw agent --session-id <tenant_id>  │  │
│  │       --message <text> --json を実行           │  │
│  │    4. 応答を監査（Plan E）                     │  │
│  │    5. JSON 応答を返す                          │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  AgentCore が自動管理:                               │
│  ├── 同じ sessionId → 既存 microVM を再利用（秒単位応答）│
│  ├── 新規 sessionId → fast-path で直 Bedrock（約 3 秒）+ バックグラウンドで microVM 起動 │
│  └── idle 15 分 → SIGTERM → S3 flush → 解放         │
└──────────────────────────────────────────────────────┘

重要な設計: ゼロ侵襲
├── OpenClaw Gateway は proxy 相手と認識していない（AWS_ENDPOINT_URL 環境変数だけで切替）
├── microVM 内の OpenClaw は企業基盤上にいることを認識していない（標準 CLI 呼び出し）
├── IM channel 設定は通常の単一ユーザー構成と完全に同じ
└── OpenClaw 更新はイメージ再ビルド + ECR push のみ。全テナントが次回起動時に新バージョンを利用
```

### 検証済み E2E フロー（2026-03-19）

コールドスタート fast-path を含め、完全経路は検証済みです。

```text
Cold Start（体感約 3 秒）:
  ユーザー最初のメッセージ → Gateway → H2 Proxy
    → tenant status=cold
    → 並列実行:
      1. fast-path: Bedrock Converse API を直接呼ぶ → 3.4 秒で応答 ✅
      2. async: Tenant Router → AgentCore → microVM を予熱（バックグラウンド約 32 秒）
    → tenant status=warm

Warm Path（約 5 秒）:
  以降のメッセージ → Gateway → H2 Proxy
    → tenant status=warm
    → Tenant Router → AgentCore → microVM → OpenClaw CLI → Bedrock
    → 5.2 秒で応答（完全な OpenClaw。SOUL.md / memory / skills を含む）✅
```

| 指標 | 数値 |
|------|------|
| コールドスタート（体感） | 約 3 秒（fast-path で Bedrock 直呼び、SOUL.md / memory なし） |
| コールドスタート（実 microVM） | 約 25 秒（バックグラウンド予熱、ユーザー待機なし） |
| ホットリクエスト | 約 5〜10 秒（microVM 起動済み、openclaw agent CLI 実行） |
| microVM idle timeout | 15 分（設定可能） |
| 最大ライフタイム | 8 時間（設定可能） |

### セキュリティモデル

| Layer | Mechanism | 防ぐもの |
|-------|-----------|----------|
| **VM Isolation** | テナントごとの Firecracker microVM | テナント間データ漏えい |
| **Plan A** | system prompt への allowed tools 注入 | 未許可ツール利用 |
| **Plan E** | 実行後の応答監査 | Plan A をすり抜けた違反 |
| **Always Blocked** | `install_skill`, `load_extension`, `eval` をハードコードで禁止 | [ClawHub](https://www.onyx.app/insights/openclaw-enterprise-evaluation-framework) 型のサプライチェーン攻撃 |
| **Input Validation** | メッセージ切り詰め、path traversal check、13 種類の injection pattern 検出 | プロンプトインジェクション、メモリ汚染 |
| **Auth Agent Validation** | 承認フロー向け 7 種類の injection pattern 検出 | 承認フロー操作 |
| **Centralized Audit** | テナント単位の CloudWatch 構造化 JSON ログ | SOC2、HIPAA、PCI-DSS などのコンプライアンス |

> Plan A はソフト強制であり、理論上は prompt injection により回避される可能性があります。Plan E はその抜け漏れを検出します。AgentCore Gateway MCP mode によるハード強制は [Roadmap](ROADMAP.md) を参照してください。

### OpenClaw 単体に対して追加される価値

| | OpenClaw alone | This platform |
|---|---|---|
| Users | 1 | Unlimited, isolated |
| Execution | Local process | Serverless microVM per tenant |
| Cold start | N/A | 約 3 秒体感（fast-path）、約 25 秒で実 microVM |
| Model access | Individual API keys | Unified Bedrock, per-tenant metering |
| Permissions | None | Per-tenant SSM profiles, Plan A + E |
| Audit | None | CloudWatch + CloudTrail per tenant |
| Approval workflow | None | Human-in-the-loop, 30-min auto-reject |
| Memory safety | None | 13 injection patterns detected |
| Skills | Per-instance, manual | Shared catalog, bundled SaaS credentials |
| Cost model | Fixed per instance | Shared infrastructure, per-tenant metering |
| Scalability | Single machine | Auto-scaling microVMs, burst capacity |

---

## リポジトリ構成

```text
agent-container/           # AgentCore Runtime 用 Docker イメージ
├── server.py              # HTTP wrapper: openclaw agent CLI subprocess + Plan A/E
├── entrypoint.sh          # microVM lifecycle: config → server.py → S3 sync
├── permissions.py         # SSM profile read/write, permission checks
├── safety.py              # Input validation, memory poisoning detection
├── identity.py            # ApprovalToken lifecycle (max 24h TTL)
├── memory.py              # Optional AgentCore Memory persistence
├── observability.py       # Structured CloudWatch JSON logs
├── openclaw.json          # OpenClaw config template (Bedrock provider, no gateway)
├── Dockerfile             # Multi-stage ARM64: Python 3.12 + AWS CLI + Node.js 22 + OpenClaw + V8 cache
└── build-on-ec2.sh        # Remote build when local Docker unavailable

auth-agent/                # Authorization Agent
├── server.py              # HTTP entry point with input validation
├── handler.py             # Approval flow, risk assessment, injection detection
├── approval_executor.py   # Execute approve/reject, update SSM
└── permission_request.py  # PermissionRequest dataclass

src/gateway/
├── tenant_router.py       # Gateway → AgentCore routing (tenant derivation + invocation)
├── bedrock_proxy_h2.js    # HTTP/2 proxy: intercepts Bedrock calls, fast-path for cold start, forwards to Tenant Router
├── bedrock_proxy.py       # HTTP/1.1 proxy (for curl testing, not used in production)
└── start_multitenant.sh   # Service startup helper script

src/utils/
└── agentcore.ts           # SessionKey derivation, response formatting

cloudformation/clawdbot-bedrock-agentcore-multitenancy.yaml  # CloudFormation: EC2 + ECR + SSM + CloudWatch
```

---

## デプロイ

### 前提条件

- CloudFormation、EC2、VPC、IAM、ECR、Bedrock AgentCore、SSM、CloudWatch を扱える AWS CLI 権限
- ローカルに Docker がインストール済み
- [Bedrock Console](https://console.aws.amazon.com/bedrock/) で Bedrock モデル利用を有効化済み

### フェーズ 1: 基盤デプロイ

```bash
aws cloudformation create-stack \
  --stack-name openclaw-multitenancy \
  --template-body file://cloudformation/clawdbot-bedrock-agentcore-multitenancy.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1 \
  --parameters \
    ParameterKey=KeyPairName,ParameterValue=your-key-pair \
    ParameterKey=OpenClawModel,ParameterValue=global.amazon.nova-2-lite-v1:0

aws cloudformation wait stack-create-complete \
  --stack-name openclaw-multitenancy --region us-east-1
```

### フェーズ 2: Agent Container を build & push

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1

ECR_URI=$(aws cloudformation describe-stacks \
  --stack-name openclaw-multitenancy --region $REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`MultitenancyEcrRepositoryUri`].OutputValue' \
  --output text)

aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com

docker build --platform linux/arm64 -f agent-container/Dockerfile -t $ECR_URI:latest .
docker push $ECR_URI:latest
```

### フェーズ 3: AgentCore Runtime を作成

```bash
EXECUTION_ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name openclaw-multitenancy --region $REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`AgentContainerExecutionRoleArn`].OutputValue' \
  --output text)

RUNTIME_ID=$(aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name "openclaw_multitenancy_runtime" \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"'$ECR_URI':latest"}}' \
  --role-arn "$EXECUTION_ROLE_ARN" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --environment-variables "STACK_NAME=openclaw-multitenancy,AWS_REGION=$REGION" \
  --region $REGION \
  --query 'agentRuntimeId' --output text)

aws ssm put-parameter \
  --name "/openclaw/openclaw-multitenancy/runtime-id" \
  --value "$RUNTIME_ID" --type String --overwrite --region $REGION
```

### フェーズ 4: Tenant Router 起動

```bash
INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name openclaw-multitenancy --region $REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)

aws ssm start-session --target $INSTANCE_ID --region $REGION
# EC2 上で実行:
sudo su - ubuntu
export STACK_NAME=openclaw-multitenancy AWS_REGION=us-east-1
nohup python3 /path/to/tenant_router.py > /tmp/tenant-router.log 2>&1 &
```

### フェーズ 5: Gateway にアクセス

```bash
aws ssm start-session --target $INSTANCE_ID --region $REGION \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["18789"],"localPortNumber":["18789"]}'

TOKEN=$(aws ssm get-parameter \
  --name "/openclaw/openclaw-multitenancy/gateway-token" \
  --region $REGION --with-decryption --query 'Parameter.Value' --output text)

echo "http://localhost:18789/?token=$TOKEN"
```

### フェーズ 6: Enterprise Profiles（任意）

```bash
STACK_NAME=openclaw-multitenancy REGION=us-east-1 bash setup-enterprise-profiles.sh
```

| Role | Tools | Use case |
|---|---|---|
| `readonly-agent` | web_search | 一般社員向け |
| `finance-agent` | web_search, shell (read-only), file | 財務問い合わせ |
| `web-agent` | All tools | Web 開発 |
| `erp-agent` | web_search, shell, file, file_write | ERP 業務 |

---

## Day-2 Operations

```bash
# Auth Agent の挙動を更新（再デプロイ不要、SSM からホットリロード）
aws ssm put-parameter \
  --name "/openclaw/openclaw-multitenancy/auth-agent/system-prompt" \
  --type String --overwrite --value "Your updated instructions..."

# テナントログ確認
aws logs filter-log-events \
  --log-group-name "/openclaw/openclaw-multitenancy/agents" \
  --filter-pattern '{ $.tenant_id = "wa__8613800138000" }'

# コンテナ更新（AgentCore は次回 invocation から新イメージを利用）
docker build --platform linux/arm64 -f agent-container/Dockerfile -t $ECR_URI:latest .
docker push $ECR_URI:latest
```

---

## コスト

| Component | Cost |
|---|---|
| EC2 Gateway (c7g.large) | 約 $35/月 |
| EBS 30GB | 約 $2.40/月 |
| VPC Endpoints (optional) | 約 $29/月 |
| AgentCore Runtime | 呼び出し課金 |
| Bedrock Nova 2 Lite | 100 万トークンあたり $0.30/$2.50 |

**50 人チームの場合**: 基盤約 $40-60/月 + Bedrock 約 $25-50/月 = **約 $1.30-2.20/人/月**

| Comparison | 50 users | 500 users |
|---|---|---|
| ChatGPT Plus | $1,000/月 | $10,000/月 |
| 個別 OpenClaw インスタンス | $2,000+/月 | $20,000+/月 |
| **This platform** | **$65-110/月** | **$200-400/月** |

ユーザー数が増えるほど経済性は良くなります。これが MSP モデルです。

---

## クリーンアップ

```bash
aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id $RUNTIME_ID --region us-east-1
aws cloudformation delete-stack --stack-name openclaw-multitenancy --region us-east-1
```

---

## How to Contribute

エンタープライズ OpenClaw プラットフォームをオープンに構築しています。現時点で特に重要な領域は次の通りです。

| Area | 必要な作業 | Difficulty |
|------|-----------|------------|
| **End-to-end testing** | Gateway → Router → AgentCore → Container の全メッセージ経路を検証 | Medium |
| **Auth Agent delivery** | 承認通知を WhatsApp / Telegram で送る実装（現状の logging stub を置換） | Medium |
| **Skills marketplace** | スキル配布形式、権限宣言、カタログ API の設計 | Hard |
| **Agent orchestration** | エージェント間通信プロトコル、テナント間データ共有ポリシー | Hard |
| **Cost benchmarking** | 10 / 100 / 1000 会話 / 日での AgentCore vs EC2 コスト実測 | Easy |
| **Documentation** | デプロイガイド、アーキテクチャ詳細、セキュリティ監査レポート | Easy |

組織導入を検討するエンタープライズアーキテクトでも、スキルを作りたい開発者でも、穴を探したいセキュリティ研究者でも歓迎です。

**[→ Roadmap](ROADMAP.md)** · **[→ Contributing Guide](CONTRIBUTING.md)** · **[→ GitHub Issues](https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock/issues)**

---

## Resources

- [OpenClaw Docs](https://docs.openclaw.ai/) · [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime.html) · [Session Isolation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)
- [Microsoft OpenClaw Security Guidance](https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk/)
- [OpenClaw on Lightsail](https://aws.amazon.com/blogs/aws/introducing-openclaw-on-amazon-lightsail-to-run-your-autonomous-private-ai-agents/)（単一ユーザー版。このプロジェクトはそれをマルチテナントへ拡張）

---

*これは「個人 AI アシスタント」から「企業 AI プラットフォーム」への道筋です。1 ユーザー 1 マシンから、組織の神経系へ。OpenClaw を書き換えることなく、ベンダーロックインなく、自分で制御できる基盤の上で実現します。これが OpenClaw SaaS であり、エンタープライズ OpenClaw MSP です。*
