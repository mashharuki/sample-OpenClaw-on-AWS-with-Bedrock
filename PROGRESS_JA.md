# OpenClaw エンタープライズ・マルチテナント基盤 — 進捗記録

日付: 2026-03-17

---

## 全体アーキテクチャ

### 一言でいうと

EC2 上に常駐する 1 つの OpenClaw Gateway が IM ルーターとして動作し、チャネル接続と Web UI を管理します。社員からの各メッセージは Bedrock H2 Proxy で横取りされ、Tenant Router が tenant_id を導出し、必要に応じて Serverless な Firecracker microVM（Bedrock AgentCore Runtime）を起動します。その分離環境の中でネイティブな OpenClaw CLI が実行され、処理完了後に自動解放されます。OpenClaw 本体のコードは変更していません。

### アーキテクチャ図

![Architecture](images/architecture-multitenant.drawio.png)

### コアフロー

```text
社員 (WhatsApp/Telegram/Discord/Slack)
  │
  ▼
EC2 Gateway (常駐)
  ├── OpenClaw Gateway (Node.js, port 18789) — チャネル長期接続、Web UI
  │     └── Bedrock Converse API を呼び出し (AWS SDK, HTTP/2)
  │           │
  │           │ AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://localhost:8091
  │           ▼
  └── Bedrock H2 Proxy (Node.js, port 8091) — HTTP/2 リクエストを横取り
        ├── コールドスタート時: fast-path で Bedrock を直接呼び出し（約 3 秒で応答）
        ├── 同時に非同期で microVM のウォームアップを開始（バックグラウンド約 25 秒）
        └── ホットパス: ユーザーメッセージ + channel/sender を抽出して Tenant Router へ転送
  │
  └── Tenant Router (Python, port 8090) — tenant_id を導出し、AgentCore を呼び出す
        │
        │ invoke_agent_runtime(runtimeSessionId=tenant_id, payload=message)
        ▼
AgentCore Runtime (Serverless)
  └── Firecracker microVM（テナントごとに分離）
        │
        │ entrypoint.sh 起動処理:
        │ 1. openclaw.json を書き込む（Bedrock provider 設定）
        │ 2. server.py を起動する（/ping health check に即応答）
        │ 3. S3 からテナント workspace を取得（SOUL.md, MEMORY.md, Skills）
        │ 4. watchdog が 60 秒ごとに workspace を S3 へ同期
        │
        │ /invocations リクエスト到着時:
        │ 5. server.py が Plan A の system prompt を構築（権限制約）
        │ 6. openclaw agent --session-id <tenant_id> --message <text> --json を実行
        │ 7. OpenClaw CLI が Bedrock 推論を呼び出す（子プロセス、約 10 秒）
        │ 8. server.py が JSONDecoder.raw_decode で応答を解析
        │ 9. Plan E 監査（応答中の禁止ツール呼び出しを検査）
        │ 10. JSON 応答を返す
        │
        │ 終了時:
        │ SIGTERM → workspace を S3 へ flush → 解放
        ▼
応答は元の経路で返却 → H2 Proxy → Gateway → IM channel → 社員が受信
```

### ゼロ侵襲設計

OpenClaw は microVM の中でネイティブ実行されており、自分が企業向けプラットフォーム上にいることを認識しません。すべての統制は外側のレイヤーで行います。

| 統制レイヤー | 方法 | 利用している OpenClaw インターフェース |
|---|---|---|
| entrypoint.sh | S3 から workspace を取得し、S3 へ書き戻す | OpenClaw からはローカルファイルシステムに見える |
| server.py | Plan A 権限注入 + Plan E 監査 | openclaw agent CLI（子プロセス実行） |
| openclaw.json | Bedrock モデル設定 | ~/.openclaw/openclaw.json（標準設定） |
| SOUL.md | 人格、ルール、振る舞いの境界 | OpenClaw が workspace/SOUL.md をそのまま読む |
| ECR イメージ | バージョン管理 | npm install -g openclaw@latest |

OpenClaw を更新するときは、イメージを再ビルドして ECR に push するだけで、次回リクエストからすべてのテナントが新しい版を使います。

### AWS サービス選定

| データ種別 | AWS サービス | 理由 |
|---|---|---|
| SOUL / 権限設定 | SSM Parameter Store | 無料、暗号化、ホット更新可能 |
| テナント workspace | S3 | 安価、バージョン管理、増分同期 |
| コンテナイメージ | ECR | バージョン管理、ARM64 対応 |
| モデル推論 | Amazon Bedrock | IAM 認証、10+ モデル、API Key 不要 |
| 監査ログ | CloudWatch Logs | 構造化 JSON、tenant_id ごとの絞り込み |
| API 監査 | CloudTrail | Bedrock 呼び出しを自動記録 |
| 会話履歴（計画中） | DynamoDB | マルチターン文脈、TTL 自動期限切れ |
| リソース分離 | IAM | microVM ごとの最小権限、S3 パス分離 |

---

## コアコードファイル

### agent-container/entrypoint.sh — microVM のエントリポイント

コンテナ起動時に最初に実行されるスクリプトで、ライフサイクル全体を管理します。

```text
Phase 0:   openclaw.json を書き込む（AWS_REGION/BEDROCK_MODEL_ID 環境変数を sed で展開）
Phase 1:   まず server.py を起動し、/ping health check に即応答（AgentCore 要件）
Phase 2:   S3 からテナント workspace を取得（SOUL.md, MEMORY.md, memory/*.md, skills）
           新規テナントなら、SSM からロールテンプレートを読み、S3 テンプレートから SOUL.md を初期化
Phase 3:   watchdog バックグラウンドスレッドを起動し、60 秒ごとに aws s3 sync で書き戻し
Phase 4:   trap SIGTERM → watchdog 停止 → server.py 停止 → 最終同期 → exit
```

### agent-container/server.py — HTTP ラッパー（Plan A + Plan E）

AgentCore が呼び出す HTTP エンドポイントです。重要な経路は 2 つあります。

- `GET /ping` → `{"status":"Healthy"}` を返し、AgentCore はこれでコンテナ存活を確認
- `POST /invocations` → リクエスト受信後に以下を実施
  1. headers / payload から tenant_id を抽出（AgentCore セッションヘッダー優先）
  2. SSM から permission profile を読み、Plan A system prompt を構築
  3. `openclaw agent --session-id <tenant_id> --message <text> --json` を子プロセスで実行
  4. `JSONDecoder.raw_decode` で OpenClaw の JSON 出力を解析
  5. Plan E として、応答文に禁止ツール利用が含まれていないかを検査
  6. 監査ログを CloudWatch に記録

コンテナ内で root 実行される場合は `/usr/bin/openclaw` を直接呼び、EC2 上で root 実行される場合は `sudo -u ubuntu env ...` でユーザーを切り替えて実行します。

### agent-container/openclaw.json — OpenClaw 設定テンプレート

Bedrock provider の設定です。`${AWS_REGION}` と `${BEDROCK_MODEL_ID}` を環境変数で展開します。server.py 起動時に `~/.openclaw/openclaw.json` へ書き込みます。

### agent-container/Dockerfile — コンテナイメージ（Multi-stage）

```text
Stage 1 (builder):
  Python 3.12-slim + curl + unzip + git
  + AWS CLI v2（aarch64/x86_64 を自動判定）
  + Node.js 22（nodesource）
  + OpenClaw（npm install -g openclaw@latest）
  + Python 依存（boto3, requests）
  + V8 Compile Cache ウォームアップ（openclaw agent --help）

Stage 2 (runtime):
  Python 3.12-slim + jq（git/curl/unzip/build tools なし）
  + COPY --from=builder: AWS CLI, Node.js, OpenClaw, Python deps, V8 cache
  + アプリコード: server.py, entrypoint.sh, openclaw.json, permissions.py, safety.py
  + イメージサイズ: 1.55GB（最適化前 2.24GB、31% 削減）
ENTRYPOINT: /app/entrypoint.sh
```

### src/gateway/tenant_router.py — Gateway から AgentCore へのルーティング

EC2 上で動く Python HTTP サービス（port 8090）です。

- `derive_tenant_id(channel, user_id)` → 33 文字以上の tenant_id を生成（AgentCore 要件）
- `invoke_agent_runtime(tenant_id, message)` → `bedrock-agentcore` SDK で `invoke_agent_runtime` を実行
- STS から account_id を取得し、Runtime ARN を自動生成
- demo モード（ローカル Agent Container 直結）と本番モード（AgentCore API 呼び出し）の両方に対応

### clawdbot-bedrock-agentcore-multitenancy.yaml — CloudFormation

1 つの YAML で必要な基盤を一括作成します。
- VPC + Subnet + Security Group
- EC2（Graviton ARM）+ IAM Role（Bedrock + SSM + ECR + S3 + AgentCore）
- ECR Repository
- S3 Bucket（openclaw-tenants-{AccountId}、バージョニング有効）
- SSM Parameters（gateway token、デフォルト権限プロファイル）
- CloudWatch Log Group

### deploy-multitenancy.sh — ワンクリックデプロイスクリプト

5 ステップを実行します。CloudFormation → S3 テンプレートアップロード → Docker build + push → AgentCore Runtime 作成 → Runtime ID を SSM に保存。

### agent-container/build-on-ec2.sh — リモートビルド

ローカル Docker が使えない場合（企業セキュリティ基準など）に、コードを S3 経由で EC2 に送り、EC2 上で build + push します。

---

## 完了済み項目

### 1. 設計確定

- アーキテクチャ設計: EC2 Gateway（常駐 OpenClaw）+ AgentCore Runtime（必要時に起動する microVM）+ S3 workspace sync
- ゼロ侵襲原則: OpenClaw のコードは 1 行も変更せず、すべて外部レイヤーで制御
- ファイル永続化: SOUL.md / MEMORY.md / Skills は S3 に保存し、microVM 起動時に取得、実行中は watchdog sync、終了時に flush
- 権限執行: Plan A（system prompt 注入）+ Plan E（応答監査）+ IAM（AWS リソース分離）
- 承認フロー: Auth Agent は独立セッションで動き、30 分無応答なら自動拒否
- Cron: Gateway 側の OpenClaw が集中スケジューリングし、時刻到達時に microVM を起動して実行

### 2. 基盤デプロイ（us-east-1）

| リソース | 状態 | 識別子 |
|---|---|---|
| CloudFormation stack | CREATE_COMPLETE | openclaw-multitenancy |
| EC2 Gateway | 稼働中 | i-0aa07bd9a04fa2255 |
| ECR イメージリポジトリ | 作成済み | openclaw-multitenancy-multitenancy-agent |
| S3 テナントバケット | 作成済み | openclaw-tenants-263168716248 |
| AgentCore Runtime | READY | openclaw_multitenancy_runtime-olT3WX54rJ |
| SOUL.md テンプレート | アップロード済み | _shared/templates/{default,intern,engineer}.md |
| Docker イメージ | push 済み | Multi-stage、1.55GB（V8 cache + IPv4 + CLI retry） |
| Tenant Router | 稼働中 | EC2 port 8090 |
| OpenClaw Gateway | 稼働中 | EC2 port 18789 |

### 3. パス検証

| 経路 | 状態 | 補足 |
|---|---|---|
| IM → EC2 Gateway → Bedrock → 応答 | ✅ 稼働 | 単一ユーザーモード、本番利用可 |
| Tenant Router → AgentCore invoke | ✅ 稼働 | tenant_id を正しく導出（33 文字以上） |
| AgentCore → Firecracker microVM 起動 | ✅ 稼働 | コンテナ起動成功 |
| entrypoint.sh → S3 pull workspace | ✅ 稼働 | SOUL.md をテンプレートから初期化 |
| server.py → /ping health check | ✅ 稼働 | `{"status":"Healthy"}` を返す |
| server.py → /invocations → OpenClaw CLI → Bedrock | ✅ 稼働 | AI 応答を返却、Nova 2 Lite、約 12 秒 |
| OpenClaw がコンテナ内で完全動作 | ✅ 稼働 | gateway 不要、openclaw agent CLI 子プロセスで実行 |
| Tenant Router → AgentCore → microVM → Bedrock → 応答 | ✅ 稼働 | E2E 33 秒（コールドスタート含む）、2026-03-16 検証 |
| IM → Tenant Router → AgentCore → 応答 | ✅ 稼働 | H2 Proxy による Bedrock リクエスト横取りで検証、2026-03-16 |

### 4. ドキュメントとデモ

| 成果物 | 配置 |
|---|---|
| 2 ページ構成の提案書 | OpenClaw-企业多租户方案一页纸.md |
| 3 プロジェクト比較 | AgentCore-OpenClaw-对比.md |
| アーキテクチャ図（Draw.io） | images/architecture-multitenant.drawio.png |
| シーケンス図（Mermaid） | images/sequence-diagrams.md（5 枚） |
| Admin Console（CloudFront） | https://d2mv4530orbo0c.cloudfront.net |
| Admin Console（ローカル） | python3 demo/console.py → localhost:8099 |
| デプロイスクリプト | deploy-multitenancy.sh |
| 静的サイトビルド | demo/build_static.py |
| 静的サイト CFN | demo/deploy-static-site.yaml |

---

## 主な課題

### ~~課題 1: OpenClaw コンテナ内のコールドスタートタイムアウト~~ ✅ 解決済み（2026-03-16）

**解決策**: OpenClaw gateway プロセスは起動せず、server.py が `openclaw agent --session-id <tenant_id> --message <text> --json` を直接子プロセス実行する方式に変更。各 `/invocations` リクエストで 1 つの openclaw プロセスを起動し、実行後に自動終了するため、gateway の起動待ちが不要になりました。

主要修正:
- server.py: HTTP proxy から CLI 子プロセス実行（`subprocess.run`）へ変更
- JSON 解析: `json.loads` から `JSONDecoder.raw_decode` へ変更（OpenClaw が複数 JSON オブジェクトを出力するため）
- EC2 モード: `sudo -u ubuntu env PATH=... HOME=... openclaw agent ...` で root からユーザー切替
- コンテナモード: `/usr/bin/openclaw agent ...` を直接実行
- openclaw.json: gateway 設定を削除（コンテナ内では不要、かつ新しい OpenClaw は `gateway.bind` の検証が厳格）
- entrypoint.sh: openclaw.json 書き込み後、すぐに server.py を起動し、`openclaw doctor --fix` は実行しない

### ~~課題 2: tenant_id の受け渡し~~ ✅ 解決済み

**解決策**: server.py が `/invocations` の HTTP headers と payload から tenant_id を抽出。優先順位は `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header > payload `runtimeSessionId` > payload `sessionId` > payload `tenant_id` > `/tmp/tenant_id` > `"unknown"`。

### ~~課題 4: AgentCore SDK タイムアウト~~ ✅ 解決済み（2026-03-16）

**現象**: Tenant Router が boto3 SDK 経由で AgentCore を呼ぶと 500（RuntimeClientError）になる一方、AWS CLI からの直接呼び出しは成功していた。

**原因**: boto3 の既定 `read_timeout=60s` では、AgentCore のコールドスタート + OpenClaw 実行（30〜60 秒）に加えてネットワーク遅延が乗ると足りなかった。

**解決策**: `_agentcore_client()` に `Config(read_timeout=300, connect_timeout=10, retries={"max_attempts": 0})` を設定。

### 課題 3: IM → マルチテナント経路のブリッジ ✅ 解決済み（2026-03-16）

**解決策**: Bedrock Converse API 用の HTTP/2 ローカルプロキシ（`bedrock_proxy_h2.js`, port 8091）を導入。

`AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://localhost:8091` を設定し、Gateway OpenClaw の AWS SDK が Bedrock HTTP/2 リクエストをローカル proxy に送るようにした。Proxy はリクエストを横取りし、ユーザーメッセージと channel/sender を抽出して Tenant Router → AgentCore → microVM に転送し、戻り値を Bedrock Converse API 形式に変換して返す。OpenClaw コードは無変更。

重要な発見:
- OpenClaw の `auth: "aws-sdk"` モードでは `baseUrl` は無視され、AWS SDK が直接 Bedrock endpoint を呼ぶ
- endpoint 上書きには `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` 環境変数が必須
- AWS SDK は Bedrock に HTTP/2 で接続するため、Python `http.server` では対応できず、Node.js `http2.createServer()` が必要
- `tenant_router.py` では、AgentCore SDK の response body key は `response`（StreamingBody）であり、`body` や `payload` ではない
- Gateway と Proxy は systemd 管理にし、SSM RunShellScript の fd ブロック問題を回避

---

## 踏んだ落とし穴

### AWS CLI バージョン
- `bedrock-agentcore-control` には AWS CLI >= 2.27 が必要
- EC2 上の boto3 も更新が必要（`pip3 install --upgrade boto3`）
- サービス名は `bedrock-agentcore` であり、`bedrock-agentcore-runtime` ではない

### AgentCore API パラメータ
- `--agent-runtime-name` は `[a-zA-Z][a-zA-Z0-9_]{0,47}` のみ許可。ハイフン不可
- `runtimeSessionId` は最低 33 文字必要。短い tenant_id は hash で補う
- `--environment-variables` の shorthand 形式は `Key=Value,Key=Value`
- `agentRuntimeArn` には runtime ID ではなく完全な ARN が必要
- Runtime と Endpoint は別作成（create-agent-runtime + create-agent-runtime-endpoint）

### OpenClaw 設定
- 設定ファイルのパスは `~/.openclaw/openclaw.json`。`--config` CLI 引数は非対応
- スキーマ変更が頻繁で、旧 key の `auth.type`、`sessions`、`model` などは非対応になっていることがある
- `docs/reference/templates/` がないと `Missing workspace template` で起動失敗
- 起動コマンドは `openclaw gateway --port 18789` であり、`openclaw --config xxx` ではない

### Docker ビルド
- ローカル Docker Desktop は企業セキュリティ基準で使えない場合がある。その場合は EC2 ビルドが代替手段
- OpenClaw の npm install には `git` が必要（依存の一部が git clone ベース）
- AWS CLI インストールでは aarch64/x86_64 の判定が必要
- `hypothesis` を本番用 requirements.txt に含めるべきではない

### AgentCore コンテナ要件
- 0.0.0.0:8080 を listen する必要がある
- ARM64 イメージである必要がある
- `/ping` は `{"status":"Healthy"}` または `{"status":"HealthyBusy"}` を返す必要がある
- health check はコンテナ起動数秒後に来るため、HTTP サーバーを最優先で起動する必要がある
- health check に失敗するとコンテナは繰り返し再起動される
- AgentCore のログは `/aws/bedrock-agentcore/runtimes/<runtime_id>-DEFAULT` に出る。独自 log group ではない
- boto3 SDK の `invoke_agent_runtime` は `read_timeout=300` が必要。既定 60 秒ではコールドスタート時に不足
- コンテナ内 openclaw.json に gateway 設定があると、新版 OpenClaw の `gateway.bind` 検証で exit=1 になる
- `openclaw doctor --fix` は 5〜10 秒かかるため、server.py 起動前にブロック実行してはいけない
- コンテナ内 OpenClaw 出力は複数 JSON オブジェクトになることがあり、最初の 1 つを `JSONDecoder.raw_decode` で解析する必要がある

### CloudFormation
- `AWS::EC2::KeyPair::KeyName` 型は key pair の存在を検証し、空値で失敗するため、String + Condition に変更した
- `ecr:GetAuthorizationToken` の Resource は `*` でなければならず、特定 repo ARN に絞れない
- EC2 Role に ECR push 権限（PutImage、InitiateLayerUpload など）が必要。EC2 上ビルドで必要

### S3 ログ
- S3 アクセスログは同一バケットには書けない。設定すると静かに停止する
- Athena で新規データが見えない場合は、まず partition、その次にログ配信設定を確認する

### IM ブリッジ（Bedrock H2 Proxy）
- OpenClaw `auth: "aws-sdk"` モードでは `baseUrl` は無視され、AWS SDK が AWS endpoint を直接使う
- Bedrock endpoint を上書きするには `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` が必要
- AWS SDK for JS v3 は Bedrock に HTTP/2 で接続するため、Python `http.server` は不可 → Node.js 必須
- OpenClaw にはメッセージレベルの hook はない（`gateway:startup`、`command`、`agent:bootstrap` のみ）
- OpenClaw WebSocket RPC（port 18792）には origin チェックがあり、外部接続は拒否される
- `openclaw gateway` は長時間プロセスであり、SSM RunShellScript の nohup / setsid / disown では適切に常駐化できない → systemd を使う

---

## コールドスタート最適化（2026-03-19）

### 実装済みの最適化

| 最適化 | 変更ファイル | 期待効果 | リスク |
|------|---------|---------|------|
| Multi-stage Docker Build | Dockerfile | イメージ約 40% 縮小、ECR pull -2〜3 秒 | 低 |
| V8 Compile Cache | Dockerfile + entrypoint.sh | openclaw CLI 起動 -2 秒 | 極小 |
| IPv4 強制 | entrypoint.sh | VPC IPv6 タイムアウト解消 | 極小 |
| openclaw CLI 子プロセス retry | server.py | 一時失敗から自動回復 | 低 |
| H2 Proxy Fast-Path | bedrock_proxy_h2.js | コールドスタートの体感を 2〜3 秒へ短縮 | 中 |

### Fast-Path 設計

H2 Proxy は tenant 状態テーブル（cold / warming / warm）を管理します。
- cold: 初回リクエスト → Bedrock Converse API を直接呼ぶ（約 2〜3 秒で応答）+ 非同期で microVM をウォームアップ
- warming: Tenant Router を 8 秒タイムアウトで試行。超過時は fast-path fallback
- warm: 通常ルートで Tenant Router → AgentCore（ホットパス、約 10 秒）
- 20 分間アクティビティがなければ cold に戻る（AgentCore idle timeout は 15 分）

fast-path は SOUL.md / memory / skills を使わない素の Bedrock 呼び出しです。OpenClaw には一切侵襲しません。
`FAST_PATH_ENABLED=false` 環境変数で完全に無効化できます。

### 最適化後の目標（2026-03-19 検証済み）

| シナリオ | 最適化前 | 最適化後 | 実測 |
|------|--------|--------|------|
| コールドスタート（体感） | 約 30 秒 | 約 2〜3 秒 | 3.4 秒 ✅ |
| ホットリクエスト | 約 10 秒 | 約 5〜10 秒 | 5.2 秒 ✅ |
| microVM 予熱（バックグラウンド） | N/A | 約 25 秒 | 32 秒 ✅ |
| Docker イメージサイズ | 2.24GB | 約 1.5GB | 1.55GB ✅ |

### 競合案との比較

参考: `github.com/aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore`
- その案: 軽量 agent shim（17 tools）+ OpenAI proxy + WebSocket bridge + Lambda webhook
- 侵襲性が高い: OpenClaw provider 設定変更、WebSocket 内部プロトコル依存、複数箇所でバージョン結合
- 本案: CLI 子プロセス + ネイティブ Bedrock + 環境変数による横取り + fast-path 直 Bedrock
- ゼロ侵襲: OpenClaw コード変更なし。更新はイメージ再ビルドのみ

参考にした最適化（ゼロ侵襲で導入可能）: V8 Compile Cache、Multi-stage build、IPv4 強制、Proxy JIT warm-up
採用しなかったもの: OpenAI proxy（中間層増加）、WebSocket bridge（プロトコル結合）、Lambda webhook（WhatsApp / Discord の長期接続に不向き）

詳細設計は `docs/cold-start-optimization-design.md` を参照。

---

## 次の優先課題

1. **EC2 デプロイ検証** — Docker イメージ再ビルド（multi-stage）、H2 Proxy（fast-path）配備、E2E テスト
2. **第 2 テナント試験** — 異なる tenant_id の隔離性を確認（別社員のメッセージが独立 microVM に入ることを確認）
3. **S3 workspace 書き戻し検証** — MEMORY.md 更新が S3 に同期されることを確認
4. **STS Scoped Credentials** — テナントごとの S3 パス分離（Week 2）
5. **Admin Console 統合** — 管理者が役割・権限・監査ログを扱える UI 統合

---

## 主要ファイル一覧

| ファイル | 用途 |
|---|---|
| agent-container/entrypoint.sh | microVM エントリポイント。openclaw.json 書き込み + server.py 起動 + S3 sync |
| agent-container/server.py | HTTP ラッパー。health check + Plan A/E + openclaw agent CLI 子プロセス |
| agent-container/openclaw.json | OpenClaw 設定テンプレート（Bedrock provider、gateway 設定なし） |
| agent-container/Dockerfile | コンテナイメージ。Multi-stage、Python 3.12 + AWS CLI + Node.js 22 + OpenClaw + V8 cache |
| agent-container/build-on-ec2.sh | EC2 上で Docker イメージをリモートビルドするスクリプト |
| agent-container/templates/*.md | SOUL.md ロールテンプレート（default / intern / engineer） |
| src/gateway/tenant_router.py | Tenant Router。tenant_id 導出 + AgentCore invoke（port 8090） |
| src/gateway/bedrock_proxy_h2.js | Bedrock H2 Proxy。HTTP/2 横取り、fast-path 最適化、Tenant Router 転送（port 8091） |
| src/gateway/bedrock_proxy.py | Bedrock HTTP/1.1 Proxy（curl テスト用。本番未使用） |
| clawdbot-bedrock-agentcore-multitenancy.yaml | CloudFormation。EC2 + ECR + S3 + SSM + IAM |
| deploy-multitenancy.sh | ワンクリックデプロイスクリプト |
| docs/cold-start-optimization-design.md | コールドスタート最適化設計書（6 施策、4 フェーズ実装） |
