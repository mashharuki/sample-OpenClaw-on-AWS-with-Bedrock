# OpenClaw Enterprise Console — PRD v3

日付: 2026-03-20
バージョン: v3.0

---

## プロダクト定義

個人向け AI アシスタントを、**組織レベルのデジタル従業員プラットフォーム**へ引き上げる。

Admin Console は単なる運用ツールではない。
組織構造を管理し、Agent を製造し、協働を編成し、知識を注入し、
コンプライアンスを統制し、利用拡大まで回すための中枢システムである。

---

## 十層アーキテクチャ

```
10. エコシステム層   多テナント / パートナー / ホワイトラベル / ISV 市場
 9. グロース層       利用率ダッシュボード / ROI / Champion 管理 / 導入支援
 8. オペレーション層 利用量 / 課金 / 予算 / 原価帰属
 7. 運用層           健康監視 / KPI / 変更管理 / 灰度リリース
 6. ガバナンス層     監査 / コンプライアンス / PII / データ主権
 5. インテリジェンス層 Knowledge / モデルルーティング / RAG
 4. 接続層           チャネル管理 / Connector 市場 / 認証情報保管
 3. 協働層           社員-Agent バインド / 承認 / 引き継ぎ / 共同作業
 2. Agent 層         Agent Factory / Workspace テンプレート / Skill 市場
 1. 組織層           組織ツリー / 職種管理 / 権限エンジン
```

---

## ナビゲーション構成

```
🦞 OpenClaw Enterprise
├── Dashboard
├── 組織管理
│   ├── 部門ツリー
│   ├── 職種管理
│   ├── 社員管理
│   └── 飛書 / 钉钉 同期
├── Agent Factory
│   ├── Agent 作成 / 設定
│   ├── SOUL Editor
│   └── テンプレート市場
├── Workspace 管理
│   ├── 三層ファイルマネージャ
│   ├── 継承の可視化
│   └── Diff 比較
├── Skill 市場
├── Binding & Routing
├── Knowledge Base
├── Monitoring Center
├── Audit Center
├── Usage & Billing
└── System Settings
```

---

## モジュール詳細設計

### 1. 組織管理（第 1 層）

#### 1.1 部門ツリー

- 組織全体をツリーで可視化する
- ドラッグで階層変更が可能
- 部門作成、編集、削除、バルク import をサポート

データ保存先: `SSM /openclaw/{stack}/org/departments/*`

#### 1.2 職種管理

各職種は Agent 設定テンプレートのアンカーとなる。

管理項目:
- 職種名
- 所属部門
- デフォルト SOUL
- デフォルト Skill
- デフォルト Knowledge
- Tool allowlist
- 所属メンバー数

#### 1.3 社員管理

管理項目:
- 氏名
- 社員 ID
- 所属職種
- チャネル（WhatsApp / Telegram / Slack / 飞书 など）
- Agent 状態
- 個人設定の要約

#### 1.4 飛書 / 钉钉 同期

機能:
- 接続状態表示
- 差分プレビュー
- 今すぐ同期
- 履歴参照
- 退職者の Agent 自動アーカイブ

### 2. Agent Factory（第 2 層）

#### 2.1 Agent 作成 / 設定 Wizard

手順:
1. 作成方式を選択
   - 職種テンプレートから作成
   - テンプレート市場から作成
   - 空の Agent を作成
2. 基本設定
   - 名前
   - バインド対象社員
   - 職種
   - 利用チャネル
3. SOUL 編集
   - 全社 / 職種 / 個人の 3 層を同時表示
4. Skill 設定
   - 継承 Skill と個別 Skill を管理
5. Knowledge 設定
   - 組織 KB、部門 KB、個人 KB を紐付け
6. テストと公開
   - テスト送信、灰度公開、全量公開

#### 2.2 SOUL Editor

主要 UX:
- 3 カラム構成（全社、職種、個人）
- 右ペインにマージ結果プレビュー
- 各段落がどのレイヤから来たかを視覚表示
- バージョン管理、差分比較、保存

#### 2.3 テンプレート市場

表示内容:
- SA、SDE、PM、Sales、HR、CS、DevOps などのテンプレート
- 各テンプレートの Skill 数、Knowledge 数、利用回数、評価
- カスタムテンプレート作成
- GitHub からの import

### 3. Workspace 管理（第 2 層）

#### 3.1 三層ファイルマネージャ

左ペイン:
- Global
- Position
- Personal

右ペイン:
- 選択したファイルの表示 / 編集

主な対象ファイル:
- `SOUL.md`
- `AGENTS.md`
- `TOOLS.md`
- `skills/`
- `knowledge/`
- `USER.md`
- `MEMORY.md`

#### 3.2 継承可視化

- Global → Position → Personal の継承経路を明示
- `🔒` 読み取り専用、`✏️` 編集可能、`📎` 追記のみを区別

#### 3.3 Diff 比較

用途:
- ロールバック前確認
- A/B 比較
- 監査用の変更確認

### 4. Skill 市場（第 2 層）

#### 4.1 Skill の分類

| 種別 | 取得元 | 管理方法 |
|------|-------|---------|
| 内蔵 | Docker イメージ | イメージ再ビルド |
| 内製 | 社内開発 | S3 へ配置して承認 |
| コミュニティ | ClawHub | 事前ビルド bundle を承認配布 |

#### 4.2 職種別推薦

例:
- SA 向け: アーキテクチャ図生成、コスト計算、Well-Architected レビュー
- Sales 向け: 顧客要約、提案生成、メール作成
- Finance 向け: SAP 問い合わせ、予算分析

#### 4.3 承認付き公開フロー

```
開発者提出
  → 自動セキュリティスキャン
  → IT レビュー
  → Sandbox テスト
  → 承認
  → 対象職種へ配布
```

### 5. Binding & Routing（第 3-4 層）

#### 5.1 社員 ↔ Agent バインド

サポートする形:
- 1:1 Private Agent
- N:1 Shared Agent
- 1:N Multi-Agent

管理機能:
- バインド作成
- Position 単位で一括割当
- チャネルごとの紐付け切り替え

#### 5.2 ルーティングルール

例:
- `channel=telegram` かつ `dept=Engineering` なら個人 SA Agent へ
- `channel=discord` かつ `/helpdesk` で始まるなら IT Help Desk Agent へ
- `channel=slack` かつ `role=Finance` なら Finance Agent へ
- それ以外はデフォルト 1:1 Agent へ

#### 5.3 可視化トポロジー

- ノード: 社員、Agent、チャネル
- エッジ: バインド関係、委譲関係
- 色: Active / Idle / Error
- クリックで詳細表示

### 6. Knowledge Base（第 5 層）

#### 6.1 文書管理

- 組織 Knowledge
- 部門 Knowledge
- プロジェクト Knowledge
- 個人 Knowledge

操作:
- Upload
- Confluence 同期
- Notion 同期
- 索引再生成

#### 6.2 索引状態

各 KB に対して以下を表示する。
- 文書数
- 索引状態
- 最終更新
- ベクトル数
- 使用容量

#### 6.3 権限マッピング

例:
- Company Policies: 全社員
- Arch Standards: Engineering のみ
- Case Studies: Sales と SA
- HR Policies: HR のみ
- Financial Reports: Finance と経営層

#### 6.4 検索テスト

管理者が任意クエリを入力し、
検索結果、参照元文書、関連度を確認する。

### 7. Monitoring Center（第 7 層）

#### 7.1 Agent 健康ダッシュボード

監視軸:
- 稼働状態
- レイテンシ
- Tool 成功率
- 品質
- コスト

#### 7.2 Live Session 監視

表示内容:
- 現在アクティブな会話
- チャネル
- 継続時間
- 現在処理中のメッセージ
- 管理者による Take Over ボタン

#### 7.3 アラート

| 種別 | 条件 | 対応 |
|------|------|------|
| Crash loop | 5 分で 3 回再起動 | 通知 + 自動降格 |
| 認証期限切れ | WhatsApp / Telegram token 失効 | 管理者通知 |
| Memory 膨張 | `MEMORY.md` が閾値超過 | ユーザー通知 |
| Context 逼迫 | 利用率 90% 超 | 自動 compaction |
| 予算超過 | 部門予算 80% 超 | 通知 |
| PII 検知 | 機微情報検知 | ブロック + 通知 |

### 8. Audit Center（第 6 層）

#### 8.1 会話監査

機能:
- 社員、Agent、期間で検索
- キーワード検索
- 機微情報のハイライト
- 暗号化 PDF / CSV 出力

#### 8.2 危険操作ログ

監査対象:
- shell / ファイル操作 / API 呼び出し
- 権限変更
- SOUL / AGENTS 変更
- Knowledge 参照
- 承認判断

#### 8.3 コンプライアンスレポート

ワンクリック出力対象:
- SOC 2
- 等保 2.0
- GDPR

### 9. Usage & Billing（第 8 層）

#### 9.1 多次元利用分析

軸:
- 組織
- 部門
- 社員
- Agent
- 期間

表示内容:
- 入力 / 出力 Token 推移
- コスト内訳
- ChatGPT Plus との比較

#### 9.2 予算管理

- 部門別予算
- 個人別予算
- 予測消費
- アラート
- モデル自動ダウングレードやレート制限のポリシー

### 10. システム設定

#### 10.1 LLM Provider 設定

管理項目:
- デフォルトモデル
- フォールバックモデル
- 職種別モデル上書き
- 利用可能モデル一覧

#### 10.2 全社セキュリティポリシー

- 常時禁止ツール
- PII 検知モード
- データ主権設定
- 会話保持期間

#### 10.3 SSO / IdP 統合

対応候補:
- SAML 2.0
- OIDC
- 飛書 SSO
- 钉钉 SSO
- AWS IAM Identity Center

---

## グロース層とエコシステム層

### グロース層（v1.1+）

| 機能 | 内容 |
|------|------|
| 利用率ダッシュボード | DAU / WAU / MAU、部門別利用ヒートマップ |
| ROI 計算機 | 人員数、工数削減を入れて年次 ROI を算出 |
| 導入支援ウィザード | 新入社員の初回利用を支援 |
| Champion 管理 | 利用率の高いユーザーを社内推進役として育成 |

### エコシステム層（v2.0+）

| 機能 | 内容 |
|------|------|
| 多テナント MSP | 複数企業を 1 つのプラットフォームで運用 |
| パートナー管理 | ISV 連携、収益分配、共同ソリューション |
| ホワイトラベル | OpenClaw ブランドを差し替え可能にする |
| ISV 市場 | Skill / Template / Connector の外部市場 |

---

## 実装優先度

### v1.0（4 週間）

| 週 | 対象 | 成果物 |
|---|------|--------|
| W1 | 組織管理 + Agent Factory | 部門ツリー、職種管理、Agent 作成 Wizard、SOUL Editor |
| W2 | Workspace + Skill 市場 | 三層ファイル管理、継承可視化、Skill カタログ |
| W3 | Binding + Knowledge + Monitoring | バインド管理、トポロジー、KB CRUD、健康ダッシュボード |
| W4 | Audit + Billing + Settings | 監査、利用量分析、設定画面 |

### v1.1（4 週間）

- 飛書 / 钉钉 同期
- Agent→Agent 委譲
- A/B テストと灰度配布
- グロース機能
- SSO 統合

### v2.0

- MSP 多テナント
- ISV 市場
- ホワイトラベル
- Hallucination 検知
- モバイル対応

---

## 技術スタック（変更なし）

```
Frontend: React 19 + TypeScript + Vite + Cloudscape Design System
Backend:  Python FastAPI + boto3
Storage:  SSM + S3 + CloudWatch + DynamoDB
Auth:     Gateway Token → Cognito → SSO
Deploy:   EC2 serve または S3 + CloudFront
```
