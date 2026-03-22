# OpenClaw 企業向け Skill プラットフォーム設計

日付: 2026-03-20
状態: 設計ドラフト

---

## 1. 企業シナリオでの位置づけ

### 個人利用と企業利用の Skill 差分

| 観点 | 個人ユーザー | 企業ユーザー |
|------|-------------|-------------|
| 導入方法 | `clawhub install xxx` を自分で実行 | IT が一括配備し、社員はそのまま利用 |
| API Key | 各自が取得し `.env` に保存 | 企業が一括管理し、役割単位で付与 |
| 利用範囲 | 自分だけ | 全社、部門、チーム単位で制御 |
| 監査 | 基本なし | 呼び出しごとに tenant_id と skill_name を記録 |
| バージョン管理 | 好きなタイミングで更新 | IT が検証後に一斉更新 |
| 依存管理 | 各自で npm/pip 競合を解決 | 事前ビルドしてランタイムでインストール不要 |
| 認証情報保護 | `.env` に平文保存されがち | SSM + CloudTrail + 失効可能な構成 |

### 企業版の価値提案

本質は「社員が何をインストールできるかを制限すること」ではなく、
「社員が何もインストールしなくても使える状態にすること」にある。

- IT が一度 Jira skill と企業用 Jira API Key を登録すれば、500 人が即利用可能。
- 財務部向けに SAP skill を登録すれば、財務部メンバーだけがそのまま使える。
- 新入社員はロールに応じた skill 一式を初日から自動取得する。
- 退職時は権限だけを剥奪すればよく、API Key は本人に見えない。

---

## 2. 三層 Skill アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│ Layer 3: Skill Marketplace（事前ビルド + 必要時ロード） │
│  ├─ ClawHub コミュニティ Skill                          │
│  ├─ 企業内製 Skill                                      │
│  └─ tar.gz 化して S3 に保存し、高速展開                 │
│                                                         │
│ Layer 2: S3 Hot-Load Skills（スクリプト級・依存なし）   │
│  ├─ 純粋な JS/Python Skill                              │
│  ├─ S3 に保存し entrypoint.sh で取得                    │
│  └─ API Key は SSM から環境変数として注入               │
│                                                         │
│ Layer 1: Image Built-in Skills（イメージ内蔵）          │
│  ├─ Docker build 時に clawhub install                  │
│  ├─ 全員共有でコールドスタート負荷ゼロ                 │
│  └─ IT の検証後にイメージ再ビルドで更新                 │
└─────────────────────────────────────────────────────────┘
```

### Layer 1: イメージ内蔵 Skill

位置づけ: 全社員に共通で提供する標準機能。

特徴:
- Docker build 時に `clawhub install` で導入する。
- npm 依存は build 時に解決し、ランタイムでの追加インストールは不要。
- すべての microVM が同一イメージを共有するため整合性が高い。
- 更新はイメージ再ビルドと ECR 反映でよい。

主なユースケース:
- `web_search`, `jina-reader`, `deep-research` などの汎用機能
- S3 共有ファイル、社内ドキュメント検索などの基盤 Skill
- セキュリティ監査やログ検索など全社共通ツール

管理フロー:

```
IT が Skill を評価
  → セキュリティ審査
  → Dockerfile の SKILLS_PREINSTALL に追加
  → イメージ再ビルド
  → 全員へ順次反映
```

設定例:

```dockerfile
# 企業標準 Skill（IT 管理）
ARG SKILLS_PREINSTALL="jina-reader deep-research-pro"
RUN for skill in $SKILLS_PREINSTALL; do \
      clawhub install "$skill" --no-input --force || true; \
    done
```

### Layer 2: S3 Hot-Load Skill

位置づけ: 部門、チーム、個人向けの柔軟な追加能力。

特徴:
- 依存のない JS/Python スクリプト Skill を想定する。
- S3 に置き、microVM 起動時に entrypoint で取り込む。
- API Key は SSM Parameter Store から環境変数として注入する。
- 全社、部門、個人の 3 スコープに対応できる。

S3 構成例:

```
s3://openclaw-tenants-{account}/
  _shared/
    skills/
      jira-query/
        skill.json
        tool.js
      sap-finance/
        skill.json
        tool.js
  {tenant_id}/
    skills/
      my-custom-tool/
        skill.json
        tool.js
```

manifest 例:

```json
{
  "name": "jira-query",
  "version": "1.0.0",
  "description": "Query Jira issues and create tickets",
  "author": "IT Team",
  "scope": "global",
  "requires": {
    "env": ["JIRA_API_TOKEN", "JIRA_BASE_URL"],
    "tools": ["web_fetch"]
  },
  "permissions": {
    "allowedRoles": ["*"],
    "blockedRoles": ["intern"]
  }
}
```

キー注入フロー:

```
microVM 起動
  → entrypoint.sh が manifest を読む
  → 必要なキーを SSM から取得
  → 環境変数として export
  → Skill は process.env から参照
```

権限制御:

```
1. _shared/skills を列挙
2. tenant profile を読む
3. allowedRoles / blockedRoles でフィルタ
4. {tenant_id}/skills を追加取得
5. workspace/skills に統合
```

### Layer 3: Skill Marketplace（事前ビルド）

位置づけ: npm 依存がある高機能 Skill を企業運用可能にする層。

問題設定:
- ClawHub の Skill は `package.json` を含むことがある。
- 毎回 `npm install` すると microVM 起動ごとに 30 秒から 2 分かかる。

解決策:

```
管理者が Admin Console で Skill を選択
  → Lambda / CodeBuild を起動
  → clawhub install + npm install
  → skill-{name}-{version}.tar.gz を作成
  → S3 の _shared/skill-bundles/ へ保存
  → 起動時は tar.gz を展開するだけにする
```

bundle 形式:

```
skill-jira-query-1.0.0.tar.gz
  └─ jira-query/
     ├─ skill.json
     ├─ tool.js
     ├─ node_modules/
     └─ package.json
```

読み込み例:

```bash
CATALOG=$(aws ssm get-parameters-by-path \
  --path "/openclaw/${STACK_NAME}/skill-catalog" \
  --query 'Parameters[*].[Name,Value]' --output text)

for skill in $CATALOG; do
  aws s3 cp "s3://${S3_BUCKET}/_shared/skill-bundles/${skill}.tar.gz" - \
    | tar xzf - -C "$WORKSPACE/skills/"
done
```

---

## 3. ユーザー体験設計

### 3.1 社員視点（Skill 利用者）

社員は Skill の存在を意識せず、AI に自然言語で依頼するだけでよい。

```
社員: "JIRA-1234 の状態を確認して"
AI:   （jira-query を自動実行）
      "JIRA-1234: Fix login timeout
       状態: In Progress
       担当: Alice
       優先度: High
       予定完了: 3 月 25 日"

社員: "先月の出張精算合計を SAP で確認して"
AI:   （sap-finance を自動実行）
      "2026 年 2 月の出張精算合計は ¥45,230 です"
```

社員ができること:
- IT が許可した Skill を追加操作なしで使う。
- 「何ができるの？」と尋ねて利用可能機能を確認する。
- 新しい Skill を要望し、承認フローへ送る。

社員ができないこと:
- ClawHub Skill を自分でインストールすること。
- API Key を閲覧または変更すること。
- 許可されていない Skill を使うこと。

### 3.2 IT 管理者視点（Skill 管理者）

IT は Admin Console または CLI から Skill のライフサイクルを管理する。

例:

```
Skill Catalog
  Built-in (Layer 1): 5 skills
  Department Skills (Layer 2): 3 skills
  Marketplace (Layer 3): 2 skills
```

新しい Skill の導入フロー:

```
1. Add Skill を押す
2. 取得元を選ぶ（ClawHub / アップロード / GitHub URL）
3. 自動スキャンとレビューを実施
4. API Key を入力し SSM に保存
5. 利用可能な部門・ロールを指定
6. Layer 2 なら S3 へ配置、Layer 3 ならビルドを起動
7. 次回 microVM 起動時から有効化
```

API Key 管理:
- Add: SecureString として SSM に登録する。
- Rotate: 値を更新し、次回起動から反映する。
- Revoke: SSM から削除し、Skill 呼び出し時に認証エラーにする。

### 3.3 Skill 開発者視点

社内開発者はチーム向け Skill を次のように作る。

```
my-internal-api/
  skill.json
  tool.js
```

`skill.json` には必要な環境変数、ツール名、パラメータ定義を記述する。

公開フロー:

```
1. Skill を開発し内部 repo に push
2. IT がコードレビューして承認
3. S3 に sync
4. SSM に API Key を登録
5. SSM に roles を登録
6. 対象社員へ反映
```

---

## 4. 技術実装ロードマップ

### Phase 1: Layer 1 をイメージ内蔵化（Week 1, 1-2 日）

対象: `agent-container/Dockerfile`

```dockerfile
# builder stage の末尾に追加
ARG SKILLS_PREINSTALL="jina-reader deep-research-pro transcript"
RUN for skill in $SKILLS_PREINSTALL; do \
      clawhub install "$skill" --no-input --force 2>&1 | tail -3 || true; \
    done

# runtime stage で Skill ディレクトリをコピー
COPY --from=builder /root/.openclaw/skills /root/.openclaw/skills
```

検証:
- イメージ再ビルド
- ECR 反映
- 新しい microVM で `openclaw agent` 実行確認

### Phase 2: Layer 2 の S3 ロードと SSM Key 注入（Week 1-2, 3-5 日）

対象: `agent-container/entrypoint.sh`, `agent-container/skill_loader.py`

`skill_loader.py` の役割:
- グローバル Skill の取得
- tenant profile の読込
- ロールベースのフィルタ
- 個人 Skill の追加取得
- manifest から必要 env を判定
- SSM からキーを取得して `/tmp/skill_env.sh` を生成

entrypoint.sh 例:

```bash
# Step 2.5: Load skills and inject API keys
python /app/skill_loader.py \
  --tenant "$TENANT_ID" \
  --workspace "$WORKSPACE" \
  --bucket "$S3_BUCKET" \
  --stack "$STACK_NAME" \
  --region "$AWS_REGION"

if [ -f /tmp/skill_env.sh ]; then
    . /tmp/skill_env.sh
fi
```

SSM パス例:

```
/openclaw/{stack}/skill-keys/jira-query/JIRA_API_TOKEN
/openclaw/{stack}/skill-keys/jira-query/JIRA_BASE_URL
/openclaw/{stack}/skill-roles/jira-query
```

### Phase 3: Layer 3 の事前ビルド Bundle（Week 3-4, 5-7 日）

追加コンポーネント:
- `skill-builder/` Lambda
- `skill-builder/buildspec.yml`
- Admin Console の Skill Marketplace 画面

ビルドフロー:

```
Admin Console → Install from ClawHub
  → API Gateway
  → Lambda: skill-builder
  → CodeBuild:
      1. clawhub install
      2. npm install --omit=dev
      3. tar.gz 化
      4. S3 へアップロード
      5. SSM の skill-catalog を更新
```

読み込みロジックは `skill_loader.py` 内で bundle をダウンロードし、workspace/skills へ展開する。

---

## 5. データフロー全体像

```
Admin Console / CLI
  ├─ Layer 1: Dockerfile の SKILLS_PREINSTALL を更新
  ├─ Layer 2: skill/ を S3 の _shared/skills/ に配置
  ├─ Layer 3: Install を押して Lambda / CodeBuild を起動
  ├─ Key 管理: SSM の skill-keys 配下を更新
  └─ 権限管理: SSM の skill-roles 配下を更新

microVM 起動
  1. Layer 1 の内蔵 Skill は既に存在
  2. Layer 2 を S3 から pull
  3. Layer 3 bundle を S3 から pull して展開
  4. SSM から Key を取得して env に export
  5. OpenClaw が標準ディレクトリをスキャンして利用開始
```

OpenClaw から見えるものは標準の Skill ディレクトリと環境変数だけであり、
それが S3 由来か事前ビルドかを知る必要はない。

---

## 6. セキュリティ設計

### API Key ライフサイクル

```
作成: Admin Console → SSM put-parameter（SecureString, KMS 暗号化）
利用: microVM 起動 → SSM get-parameter → env export → Skill が利用
ローテーション: SSM update → 次回起動から自動反映
失効: SSM delete → Skill 実行時に認証不可
監査: CloudTrail が get-parameter を記録
```

### Skill セキュリティレビュー

Layer 2:
- IT によるコードレビュー
- 危険 API（`fs.writeFile`, `child_process.exec`, `eval` など）の静的検査
- 必要なら外部 URL へのアクセス先を制約

Layer 3:
- `npm audit` を CodeBuild で実行
- ClawHub / VirusTotal 系の検査を通す
- ビルドサンドボックスでテストを走らせる

### 権限分離

例:

```
tenant A（engineering, senior）
  - Layer 1: すべて利用可
  - Layer 2: jira-query は可, sap-finance は不可
  - Layer 3: github-pr-review は可

tenant B（finance, analyst）
  - Layer 1: すべて利用可
  - Layer 2: sap-finance は可, jira-query は不可
  - Layer 3: github-pr-review は不可
```

---

## 7. 実装スケジュール

```
Week 1 (Mar 20-23)
  - Layer 1: Dockerfile に SKILLS_PREINSTALL を追加
  - Layer 2: skill.json 形式を確定
  - Layer 2: skill_loader.py の初版を作成

Week 2 (Mar 24-30)
  - Layer 2: ロールベース制御を追加
  - Layer 2: Admin Console に Skill 管理画面を追加
  - Jira Skill で E2E 検証

Week 3 (Mar 31 - Apr 6)
  - Layer 3: CodeBuild パイプライン構築
  - bundle 形式の確定と読み込みロジック実装
  - Admin Console に Install from ClawHub を追加

Week 4 (Apr 7-13)
  - セキュリティスキャンと依存監査
  - Skill 開発者向けガイド整備
  - 10 本以上の Skill で E2E 検証
```

---

## 8. 対象外とする事項

| 案 | 採用しない理由 |
|----|---------------|
| ランタイム `npm install` | 遅すぎてコールドスタートを壊す |
| OpenClaw の Skill 読み込みロジック改変 | 侵襲的でバージョン依存が強い |
| 独自 Skill registry の構築 | 過剰設計であり ClawHub の資産を活用すべき |
| 社員自身による ClawHub Skill 導入 | サプライチェーンリスクが高い |
| Skill 間通信 | 複雑度が高く、v2.0 以降の検討項目 |
| microVM 再起動なしの Skill hot reload | OpenClaw が現状サポートしていない |
