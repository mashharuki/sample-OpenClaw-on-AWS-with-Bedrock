# コールドスタート最適化設計書

日付: 2026-03-19
状態: 設計レビュー

---

## 1. 現状分析

### 現在の E2E コールドスタート内訳（約 30 秒）

```
Phase 0: IM メッセージが EC2 Gateway に到着                  約 0s（常駐）
Phase 1: Gateway → AWS SDK で Bedrock 呼び出し             約 0.1s
Phase 2: H2 Proxy が受信して Tenant Router に転送          約 0.1s
Phase 3: Tenant Router → AgentCore invoke_agent_runtime   約 0.5s
Phase 4: AgentCore のスケジューリング + ECR pull + microVM 起動
                                                          約 10-15s
Phase 5: entrypoint.sh → server.py 起動 → /ping 通過       約 2-3s
Phase 6: /invocations → openclaw agent CLI 子プロセス      約 8-12s
Phase 7: Bedrock 推論                                      約 2-4s
Phase 8: 応答返却                                          約 0.5s
                                                    合計: 約 25-33s
```

### 制御できない要因

| 要因 | 所要時間 | 理由 |
|------|---------|------|
| AgentCore の microVM スケジューリング | 約 3-5s | AWS 内部処理で API から最適化できない |
| ECR イメージ pull | 約 5-8s | イメージサイズとネットワーク条件に依存 |
| OpenClaw CLI 初期化 | 約 5-8s | Node.js モジュール読み込みと内部初期化 |
| Bedrock 推論 | 約 2-4s | モデルとプロンプト長に依存 |

### 制御できる要因

| 要因 | 現状 | 改善余地 |
|------|------|---------|
| Docker イメージサイズ | 約 1.2GB（推定） | multi-stage build で 600-800MB へ削減 |
| Node.js モジュール読み込み | 約 2-3s | V8 Compile Cache で 1-2 秒短縮 |
| entrypoint.sh 初期化 | 約 1-2s | 既に軽量化済み |
| S3 workspace pull | 背景で非同期 | 既に最適化済み |
| IPv6 DNS タイムアウト | 偶発 0.5-2s | IPv4 優先で解消可能 |

---

## 2. 最適化方針

### 基本原則

1. OpenClaw 本体を改変しないゼロ侵襲設計にする。
2. 各最適化は独立したスイッチとして扱い、単独でロールバックできるようにする。
3. 低リスクなものから段階的に導入し、各段階で効果を検証する。
4. コールドスタート最適化のために、既に温まっているリクエスト経路を遅くしない。

### 最適化 A: Multi-stage Docker Build

目的: イメージサイズを削減し、ECR pull 時間を短縮する。

対象ファイル: `agent-container/Dockerfile`

設計:

```
Stage 1 (builder)
  - python:3.12-slim
  - curl, unzip, git, nodejs を導入
  - AWS CLI v2 を導入
  - npm install -g openclaw@latest
  - pip install boto3 requests
  - templates の symlink を作成

Stage 2 (runtime)
  - python:3.12-slim をベースにクリーンに構築
  - 必要なものだけ COPY
    - AWS CLI バイナリ
    - Node.js ランタイム
    - OpenClaw のグローバルモジュール
    - Python 依存
    - /app 配下のアプリケーションコード
  - git, curl, unzip, npm cache, pip cache, apt cache は含めない
```

期待効果: イメージを約 1.2GB から 600-800MB に縮小し、pull を 2-3 秒程度短縮。

リスク: 低い。ビルド工程のみ変更で、ランタイム動作は変えない。

確認項目:
- EC2 上で `openclaw agent --help` が動作すること
- `/ping` と `/invocations` が正常であること

### 最適化 B: V8 Compile Cache

目的: OpenClaw CLI の Node.js モジュールを事前コンパイルし、起動時間を短縮する。

対象ファイル: `agent-container/Dockerfile`, `agent-container/entrypoint.sh`

Dockerfile でのウォームアップ:

```dockerfile
# V8 compile cache を事前生成
RUN mkdir -p /app/.compile-cache && \
    NODE_COMPILE_CACHE=/app/.compile-cache \
    openclaw agent --help > /dev/null 2>&1 || true
```

entrypoint.sh:

```bash
# V8 Compile Cache (Node.js 22+)
if [ -d /app/.compile-cache ]; then
    export NODE_COMPILE_CACHE=/app/.compile-cache
fi
```

期待効果: `openclaw agent` の起動を約 2 秒短縮。

リスク: 極めて低い。Node.js 22 の公式機能であり、cache miss 時は通常動作にフォールバックする。

### 最適化 C: IPv4 優先

目的: VPC 環境で発生する Node.js 22 の IPv6 DNS タイムアウトを回避する。

対象ファイル: `agent-container/entrypoint.sh`

```bash
# Force IPv4 for Node.js 22 VPC compatibility
# Node.js 22 Happy Eyeballs tries IPv6 first and may stall in IPv4-only VPCs
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first"
```

期待効果: 偶発的に発生する 0.5-2 秒の DNS 遅延を解消。

リスク: 極めて低い。DNS の解決順序だけを変える。

### 最適化 D: openclaw agent 子プロセス再試行

目的: 一時的な CLI 失敗から自動回復して、信頼性を上げる。

対象ファイル: `agent-container/server.py`

設計例:

```python
def invoke_openclaw(tenant_id, message, timeout=300, max_retries=2):
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            return _invoke_openclaw_once(tenant_id, message, timeout)
        except RuntimeError as error:
            last_error = error
            if attempt < max_retries:
                wait = (attempt + 1) * 2
                logger.warning(
                    "openclaw retry %d/%d after %ds: %s",
                    attempt + 1,
                    max_retries,
                    wait,
                    error,
                )
                time.sleep(wait)
    raise last_error
```

再試行対象は空出力、JSON 解析失敗、タイムアウトなどの `RuntimeError` に限定する。

期待効果: 一時的な CLI 失敗時にユーザーへ 500 を返さずに済む。

### 最適化 E: H2 Proxy Fast-Path

目的: 実際のコールドスタートは残っても、ユーザー体感では 2-3 秒で初回返信を返す。

対象ファイル: `src/gateway/bedrock_proxy_h2.js`

#### 中核アイデア

tenant ごとの状態を H2 Proxy がメモリ上に保持し、microVM がまだ冷えているときは以下を並行実行する。

1. Bedrock Converse API を直接叩いて簡易回答を返す。
2. 同時に Tenant Router へ非同期で投げて microVM を温める。

#### 状態管理

```javascript
const tenantState = new Map();
// key: `${channel}__${userId}`
// value: { status: 'cold' | 'warming' | 'warm', lastSeen: timestamp }
```

状態遷移:

```
cold    → warming: 初回リクエスト受信時
warming → warm:   Tenant Router が正常応答したとき
warm    → cold:   20 分間アクセスがなければ期限切れ
```

#### Fast-Path 実装例

```javascript
async function fastPathBedrock(userText) {
    const response = await bedrockClient.converse({
        modelId: process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0',
        messages: [{ role: 'user', content: [{ text: userText }] }],
        system: [{ text: 'You are a helpful AI assistant. Be concise.' }],
    });
    return response.output.message.content[0].text;
}
```

#### リクエストフロー

```
リクエストが H2 Proxy に到着
  │
  ├─ channel, userId, userText を抽出
  ├─ tenantState を確認
  │
  ├─ warm:
  │   └─ 既存ロジックどおり Tenant Router へ転送
  │
  ├─ warming:
  │   ├─ まず Tenant Router を試す
  │   └─ 失敗またはタイムアウトなら fast-path にフォールバック
  │
  └─ cold:
      ├─ 状態を warming に変更
      ├─ 非同期で Tenant Router に投げて microVM を起動
      └─ 同期で fast-path Bedrock を呼び出してユーザーへ返答
```

#### 設計上の判断

- Fast-path は最初の 1 メッセージだけに限定する。
- Fast-path は SOUL.md や skills を使わないため、口調差は受け入れる。
- warming 中の連投はまず通常経路を試し、間に合わない場合のみ Fast-path に戻す。
- 追加 IAM 権限は不要で、Gateway の Bedrock 権限を再利用できる。
- Bedrock コストは増えるが、コールドスタートの初回だけなので影響は小さい。

#### リスク

- 中程度。状態管理と並列処理が増える。
- `@aws-sdk/client-bedrock-runtime` が追加依存になる。
- Proxy が無状態ではなくなる。

確認項目:
1. コールドスタート初回応答が 5 秒未満になること。
2. warm 経路の挙動が変わらないこと。
3. 複数ユーザー同時起動で干渉しないこと。
4. 20 分無通信後に cold へ戻ること。

### 最適化 F: STS Scoped Credentials

目的: microVM ごとに自分の S3 namespace だけへアクセスさせる。

対象ファイル: `agent-container/entrypoint.sh`, `agent-container/server.py`

位置づけ: これは主にセキュリティ強化であり、コールドスタート短縮とは独立して Week 2 で扱う。

```bash
# STS AssumeRole で scoped credentials を生成
aws sts assume-role \
  --role-arn "$EXECUTION_ROLE_ARN" \
  --role-session-name "tenant-${TENANT_ID}" \
  --policy '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:*","Resource":["arn:aws:s3:::"'"${S3_BUCKET}"'"/"'"${TENANT_ID}"'"/*"]}]}' \
  > /tmp/scoped-creds.json

export AWS_ACCESS_KEY_ID=$(jq -r .Credentials.AccessKeyId /tmp/scoped-creds.json)
export AWS_SECRET_ACCESS_KEY=$(jq -r .Credentials.SecretAccessKey /tmp/scoped-creds.json)
export AWS_SESSION_TOKEN=$(jq -r .Credentials.SessionToken /tmp/scoped-creds.json)
```

注意点: Bedrock 呼び出し権限を失わないよう、scoped policy の設計を慎重に行う必要がある。

---

## 3. 実装順序

```
Phase 1（低リスク、すぐ着手可能）
  - A: Multi-stage Docker Build
  - B: V8 Compile Cache
  - C: IPv4 優先
  期待値: 実コールドスタート 30s → 22-25s

Phase 2（低リスク）
  - D: openclaw agent 子プロセス再試行
  期待値: 一時失敗からの自動回復

Phase 3（中リスク）
  - E: H2 Proxy Fast-Path
  期待値: 体感初回応答 2-3s

Phase 4（Week 2）
  - F: STS Scoped Credentials
  期待値: テナント間の S3 分離強化
```

---

## 4. 最適化後の目標アーキテクチャ

```
ユーザーのメッセージ
  → Gateway
  → H2 Proxy
      ├─ warm   → Tenant Router → AgentCore → microVM → 約 10s で応答
      └─ cold   → 並列実行
          ├─ fast-path Bedrock → 2-3s で応答
          └─ async Tenant Router → microVM を予熱
```

### 目標時間指標

| シナリオ | 現状 | 目標 | 改善 |
|---------|------|------|------|
| 実コールドスタート | 約 30s | 約 22-25s | 5-8 秒短縮 |
| 体感コールドスタート | 約 30s | 約 2-3s | 約 27 秒短縮 |
| 温まった後の通常リクエスト | 約 10s | 約 10s | 変化なし |
| CLI 一時失敗 | 500 応答 | 自動再試行 | 信頼性向上 |

---

## 5. ロールバック計画

| 施策 | ロールバック方法 |
|------|----------------|
| A: Multi-stage Build | Dockerfile を元へ戻して再ビルド |
| B: V8 Cache | entrypoint.sh の 2 行と Dockerfile の cache 手順を削除 |
| C: IPv4 優先 | `NODE_OPTIONS` の追加を削除 |
| D: 子プロセス再試行 | `invoke_openclaw` を元へ戻す |
| E: Fast-Path | H2 Proxy の fast-path ロジックを削除 |
| F: STS Scoped Credentials | STS 関連ロジックを削除 |

---

## 6. 対象外とする案

| 案 | 採用しない理由 |
|----|---------------|
| OpenAI proxy で Bedrock を置き換える | 中間層が増え、OpenClaw 設定にも侵襲がある |
| WebSocket bridge | OpenClaw の内部プロトコルに依存し、バージョン結合が強い |
| 軽量 agent shim を自作する | 実質的に OpenClaw を再実装することになる |
| OpenClaw ソースコードの改変 | ゼロ侵襲方針に反する |
| Lambda webhook で Gateway を置換 | WhatsApp や Discord の長時間接続に不向き |
| OpenClaw のバージョン固定 | 将来の追従性を損なう |
