# OpenClaw Enterprise Admin Console — PRD

日付: 2026-03-20
バージョン: v1.0
状態: 設計ドラフト

---

## 1. プロダクトの位置づけ

### 一言で言うと

企業の IT 管理者が、社員全員の AI アシスタントを一元管理するためのコンソール。
誰がどのツールや Skill を使えるか、いくら使っているか、違反がないかをまとめて確認する。

### 対象ユーザー

| 役割 | 主な目的 | 利用頻度 |
|------|---------|---------|
| IT Admin | テナント権限管理、Skill 配備、承認処理 | 毎日 |
| CISO / セキュリティ責任者 | 監査ログ、安全状態、コンプライアンス確認 | 毎週 |
| 財務 / 管理層 | コスト分析、ROI 比較、予算把握 | 毎月 |
| プラットフォーム運用者 | サービス状態、microVM 健全性、障害切り分け | 必要時 |

### プロダクト原則

1. AWS ネイティブな操作感を優先し、Cloudscape Design System を前提にする。
2. すべての画面は実データに基づき、静的設定画面にしない。
3. 初回利用時に迷わせないよう、Onboarding Wizard を用意する。
4. すべての重要操作を監査可能にし、危険操作には確認や承認を要求する。

---

## 2. 技術アーキテクチャ

```
Browser (Admin Console)
  React 19 + TypeScript + Vite + Cloudscape
        │
        ▼
Backend API (EC2 Gateway :8099)
  FastAPI
  /dashboard  /tenants  /skills  /approvals  /audit
  /usage      /security /services /playground /onboarding
        │
        ▼
AWS Services
  SSM / S3 / CloudWatch / Bedrock / AgentCore / ECR
```

### 技術スタック

| レイヤ | 技術 | 理由 |
|-------|------|------|
| フロントエンド | React 19 + TypeScript | 実績があり Cloudscape と相性が良い |
| ビルド | Vite 6 | 起動が速く設定が軽い |
| UI | Cloudscape Design System | AWS 公式の企業向け UI |
| 状態管理 | React Query | サーバー状態と自動更新に向く |
| ルーティング | React Router v7 | 標準的な選択 |
| 可視化 | Recharts | React との相性が良い |
| バックエンド | FastAPI + boto3 | AWS API と親和性が高い |
| 認証 | Gateway Token | 既存の Gateway 方式を流用 |

---

## 3. 情報アーキテクチャ

```
🦞 OpenClaw Enterprise
├── Dashboard
├── Tenants
├── Skills
├── Approvals
├── Audit Log
├── Usage & Cost
├── Security
├── Playground
├── Topology
├── Settings
└── Onboarding
```

各ページの役割:
- Dashboard: 主要指標の俯瞰
- Tenants: テナントの作成、編集、停止
- Skills: Layer 1/2/3 の Skill 管理
- Approvals: 危険操作の承認と履歴
- Audit Log: 全監査イベントの検索
- Usage & Cost: Token とコストの分析
- Security: ブロック数、注入試行、隔離状態の把握
- Playground: 任意テナントとしてテスト会話
- Topology: 組織構造の可視化
- Settings: モデル、Gateway、サービス状態の設定
- Onboarding: 初回導入ウィザード

---

## 4. 画面設計

### 4.1 Dashboard

目的: 30 秒以内に全体状況を把握すること。

主要要素:
- テナント数、アクティブユーザー数、リクエスト数、Token 数、コスト、アラート数
- 7 日間の Token 推移グラフ
- 利用量上位テナント一覧
- 最近の監査イベント
- 未処理承認一覧

データソース:
- SSM のテナント情報
- CloudWatch メトリクス
- CloudWatch Logs

更新頻度:
- KPI カードは 30 秒ごと
- グラフは 5 分ごと

### 4.2 Tenants

Tenant List:
- 検索、ソート、ページング対応の Cloudscape Table
- 名前、ロール、部門、チャネル、ツール、利用可能 Skill 数、状態、最終アクティブ、当日 Token を表示

Tenant Detail / Edit:
- 権限トグル
- SOUL テンプレート選択
- ロール管理
- 最近のアクティビティ
- 保存、テンプレートへリセット

API:
- `GET /api/v1/tenants`
- `GET /api/v1/tenants/{id}`
- `POST /api/v1/tenants`
- `PUT /api/v1/tenants/{id}`
- `DELETE /api/v1/tenants/{id}`

### 4.3 Skills

Skill Catalog:
- Layer 1, Layer 2, Layer 3 ごとにカード表示
- フィルタと検索を提供
- インストール状態と公開範囲を表示

Skill Detail:
- 説明、作者、バージョン
- allowedRoles / blockedRoles
- API Key 一覧（マスク表示）
- 対象テナント数
- 更新、アンインストール

API:
- `GET /api/v1/skills`
- `GET /api/v1/skills/{id}`
- `POST /api/v1/skills`
- `PUT /api/v1/skills/{id}`
- `DELETE /api/v1/skills/{id}`
- `GET /api/v1/skills/{id}/keys`
- `PUT /api/v1/skills/{id}/keys/{key}`
- `DELETE /api/v1/skills/{id}/keys/{key}`

### 4.4 Approvals

構成:
- 左に申請一覧
- 右に詳細パネル

表示内容:
- 申請者
- リスクレベル
- 申請理由
- 自動失効までの残り時間
- 一時承認、恒久承認、却下ボタン

API:
- `GET /api/v1/approvals?status=pending`
- `GET /api/v1/approvals?status=resolved`
- `POST /api/v1/approvals/{id}/approve`
- `POST /api/v1/approvals/{id}/reject`

### 4.5 Audit Log

- テーブル形式で時刻、イベント種別、テナント、リソース、結果、レイテンシ、詳細を表示
- イベント種別、テナント、期間でフィルタ可能

API:
- `GET /api/v1/audit?tenant={id}&event={type}&from={ts}&to={ts}&limit=50`

### 4.6 Usage & Cost

主要要素:
- 入力 Token、出力 Token、当日コスト、ChatGPT Plus 比較
- 日別利用推移
- テナント別内訳
- コスト試算ツール

API:
- `GET /api/v1/usage/daily?days=30`
- `GET /api/v1/usage/tenants`
- `GET /api/v1/usage/calculate?users=50&msgs=100&model=nova-lite`

### 4.7 Security Center

表示内容:
- Plan A ブロック数
- Plan E 検知数
- プロンプト注入試行数
- コンプライアンス状態
- ブロック上位ツール
- 常時禁止ツール
- 隔離方式の説明

API:
- `GET /api/v1/security/summary`
- `GET /api/v1/security/events?days=30`

### 4.8 Playground

目的: 管理者が任意テナントとして会話し、権限と実行経路を確認できるようにする。

構成:
- 左: チャット
- 右: Pipeline Inspector

表示する詳細:
- tenant_id
- Permission Profile
- Plan A システム制約
- Plan E 監査結果
- 利用可能 Skill
- Token 使用量

API:
- `POST /api/v1/playground/send`

### 4.9 Topology

- Org → Department → Team → Individual のツリー表示
- 各ノードに名前、ロール、チャネル、権限数、稼働状態を表示

API:
- `GET /api/v1/topology`

### 4.10 Settings

子画面:
- Model Selection
- Gateway Config
- Service Status

API:
- `GET /api/v1/settings/model`
- `PUT /api/v1/settings/model`
- `GET /api/v1/settings/services`
- `GET /api/v1/settings/gateway`

### 4.11 Onboarding Wizard

初回アクセス時に表示する。

手順:
1. Welcome
2. Model Selection
3. Channel 接続
4. 最初の Tenant 作成
5. テストメッセージ送信
6. 完了

API:
- `POST /api/v1/onboarding/model`
- `POST /api/v1/onboarding/channel`
- `POST /api/v1/onboarding/tenant`
- `POST /api/v1/onboarding/test`

---

## 5. API 契約一覧

### 認証

すべての API は `Authorization: Bearer {gateway_token}` を要求する。
Token は SSM の `/openclaw/{stack}/gateway-token` から取得する。

### ベース URL

`http://localhost:8099/api/v1/`

### エンドポイント一覧

| Method | Path | 説明 |
|--------|------|------|
| GET | /dashboard | 全体ダッシュボード |
| GET | /tenants | テナント一覧 |
| GET | /tenants/{id} | テナント詳細 |
| POST | /tenants | テナント作成 |
| PUT | /tenants/{id} | テナント更新 |
| DELETE | /tenants/{id} | テナント停止 |
| GET | /skills | Skill 一覧 |
| GET | /skills/{id} | Skill 詳細 |
| POST | /skills | Skill 導入 |
| PUT | /skills/{id} | Skill 更新 |
| DELETE | /skills/{id} | Skill 削除 |
| GET | /approvals | 承認一覧 |
| POST | /approvals/{id}/approve | 承認 |
| POST | /approvals/{id}/reject | 却下 |
| GET | /audit | 監査ログ |
| GET | /usage/daily | 日次利用量 |
| GET | /usage/tenants | テナント別利用量 |
| GET | /usage/calculate | コスト試算 |
| GET | /security/summary | セキュリティ要約 |
| GET | /security/events | セキュリティ推移 |
| POST | /playground/send | テスト送信 |
| GET | /topology | 組織トポロジー |
| GET | /settings/model | モデル設定取得 |
| PUT | /settings/model | モデル切替 |
| GET | /settings/services | サービス状態 |
| GET | /settings/gateway | Gateway 設定 |
| POST | /onboarding/* | 初回導入設定 |

---

## 6. プロジェクト構成

```
admin-console/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── api/
│   ├── pages/
│   ├── components/
│   ├── hooks/
│   └── theme/
└── README.md
```

主要ディレクトリ:
- `api/`: フロントエンド API クライアント
- `pages/`: 画面単位の実装
- `components/`: 共通 UI コンポーネント
- `hooks/`: React Query ベースの取得ロジック
- `theme/`: Cloudscape 上書きテーマ

---

## 7. 実施計画

### Phase 1: 骨組み + Dashboard（3 日）

- Vite + React + TypeScript + Cloudscape の初期化
- AppLayout、ナビゲーション、ルーティング
- Dashboard 画面
- FastAPI `/dashboard`

### Phase 2: Tenants + Skills（4 日）

- Tenant List
- Tenant Detail / Edit
- Skill Catalog
- Skill Detail
- `/tenants` と `/skills` API

### Phase 3: Approvals + Audit + Usage（3 日）

- Approval Queue
- Audit Log
- Usage & Cost
- `/approvals`, `/audit`, `/usage`

### Phase 4: Security + Playground + Settings（3 日）

- Security Center
- Playground
- Settings
- Onboarding Wizard

### Phase 5: 配備 + 統合試験（2 日）

- フロントエンド build
- FastAPI の EC2 配備
- E2E 試験
- ドキュメント更新

---

## 8. v1.0 で実施しないもの

| 項目 | 理由 | 将来計画 |
|------|------|---------|
| 多言語対応 | 初版は単一言語で十分 | v1.1 |
| モバイル最適化 | 利用主体がデスクトップ | v2.0 |
| WebSocket 常時 push | 初版はポーリングで十分 | v1.1 |
| Cognito 認証 | まずは Gateway Token を継続利用 | v1.1 |
| 複数クラスタ管理 | 初版は単一環境に集中 | v2.0 |
| カスタムダッシュボード | 固定レイアウトで十分 | v2.0 |
