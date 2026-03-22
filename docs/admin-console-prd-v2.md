# OpenClaw Enterprise Admin Console — PRD v2

日付: 2026-03-20
バージョン: v2.0
状態: 設計ドラフト

---

## 0. プロダクト位置づけの更新

### v1 の課題

v1 は Admin Console を「IT の管理画面」として定義していた。
しかし企業向け OpenClaw の本質は、権限やログを眺めることだけではなく、
組織に合わせて AI エージェントを設計、継承、運用することにある。

### v2 の定義

**個人用 AI アシスタントを、組織レベルのデジタル従業員に進化させる。**

OpenClaw の核はファイル駆動の Agent 構成にある。

- `SOUL.md`: 人格、価値観、ふるまいの境界
- `AGENTS.md`: ワークフロー、行動規範、判断基準
- `MEMORY.md`: 長期記憶
- `TOOLS.md`: ツール設定と API 接続
- `skills/`: 能力拡張

企業版ではこの上に、組織レベルの管理層を追加する。

- 全社 → 職種 → 個人の三層継承
- 組織構造に沿った権限エンジン
- Agent のライフサイクル管理
- 知識ベースの深い統合

### コア差分

| 観点 | 個人版 OpenClaw | 企業版 OpenClaw |
|------|----------------|----------------|
| アイデンティティ | 単一の SOUL.md | 全社 → 職種 → 個人の三層継承 |
| 権限 | ほぼ個人任せ | 組織ツリー + 職種テンプレート + 細粒度制御 |
| 記憶 | 個人私有 | 個人記憶 + 組織知識の注入 |
| Skill | 手動導入 | 三層 Skill 構成 + 職種別デフォルト |
| 協働 | 基本 1 人 1 Agent | 1:1 / N:1 / 1:N / Agent→Agent |
| 運用 | 手動 | 監視、灰度、A/B、ロールバック |

---

## 1. モジュール 1: 組織構造と権限エンジン

### 組織ツリーモデル

単純な RBAC ではなく、実際の企業組織に沿った四層モデルを採用する。

```
組織 (Org)
  └─ 部門 (Department)
      └─ 職種 / ロール (Position)
          └─ メンバー (Member)
```

各 Position にはデフォルト Agent テンプレートがぶら下がり、
所属メンバーはその構成を継承する。

### 権限粒度

| 権限タイプ | 内容 | 継承ルール |
|-----------|------|-----------|
| Agent 管理 | Agent の作成、編集、削除 | 部門管理者 + IT Admin |
| Workspace ファイル | `SOUL.md` や `AGENTS.md` の編集 | Position 管理者。ただし全社ルールは上書き不可 |
| チャネル接続 | どのチャネルで Agent と対話できるか | Position の標準値 + 個別申請 |
| Knowledge 参照 | どの知識ベースにアクセスできるか | 組織階層に追従し、離職時に回収 |
| Tool 権限 | 利用可能な tools / skills | 全社 → 職種 → 個人で継承 |
| 承認権限 | 危険操作の承認チェーン | 上長 → 部門管理者 → IT Admin |

### 組織構造画面

主な機能:
- 部門ツリー表示
- Position 一覧とメンバー数
- 各メンバーのチャネル、状態、利用 Skill 数表示
- 外部ディレクトリからの同期

操作:
- 部門追加、編集、削除
- Position 作成、複製
- Member の割り当てと移動
- 飛書、钉钉、AD からの import / sync

---

## 2. モジュール 2: 職種テンプレート管理

### 三層継承モデル

```
全社テンプレート
├── SOUL.md
├── AGENTS.md
├── TOOLS.md
└── skills/

職種テンプレート
├── SOUL.md
├── AGENTS.md
├── skills/
└── knowledge/

個人レイヤ
├── USER.md
├── MEMORY.md
└── memory/
```

例:
- SA: アーキテクチャレビュー、コスト最適化、Well-Architected を重視
- Sales: 顧客対応、提案、CRM、メール作成を重視
- HR: 機密性、候補者対応、入社手続き重視
- Finance: 正確性、承認フロー、帳票作成重視

### マージルール

| ファイル | ルール | 備考 |
|---------|-------|------|
| SOUL.md | 追記型。全社の遵守事項は上書き不可 | セキュリティ境界を保つ |
| AGENTS.md | 全社ルール常時有効、職種は追加のみ | 流程追加は可、削除は不可 |
| TOOLS.md | 合成。ただし全社禁止ツールは解禁不可 | `install_skill` など |
| skills/ | 全社 + 職種 + 個人を統合 | 三層とも利用可能 |
| knowledge/ | 全社 + 職種 | 個人が組織 KB を勝手に追加不可 |
| MEMORY.md | 個人専用 | 管理者は不可視 |
| USER.md | 個人が自由に編集 | 嗜好設定 |

### 職種テンプレート編集画面

主要タブ:
- SOUL.md
- AGENTS.md
- Skills
- Knowledge
- Members

編集体験:
- 全社レイヤは read-only 表示
- 職種レイヤを編集
- マージ後プレビューを即時確認
- 版管理、ドラフト保存、Publish、Rollback を提供

---

## 3. モジュール 3: 社員と Agent の協働管理

### 割り当てモデル

| モデル | 説明 | 例 |
|-------|------|----|
| 1:1 | 各社員に専用 Agent | 個人作業支援 |
| N:1 | 1 つの Agent を複数人で共有 | Help Desk、共通窓口 |
| 1:N | 1 人が複数の専門 Agent を使い分ける | 文書、コード、分析の分業 |
| Agent→Agent | Agent が別 Agent へ委譲 | SA Agent がコスト計算 Agent を呼ぶ |

### 協働画面

表示要素:
- Collaboration Map
- Active Sessions
- 過去 24 時間の Agent チェーン
- 共有 Agent の接続関係

管理操作:
- Binding 作成
- Position 単位で一括割り当て
- 個別 Agent の有効 / 無効切り替え

---

## 4. モジュール 4: Agent 健全性と運用監視

### 健全性ダッシュボード

監視軸:
- インスタンス状態: Gateway、チャネル接続、heartbeat、Session 数
- 性能: 初回応答時間、完了応答時間、tool 成功率、sub-agent 成功率
- 品質: 会話満足度、Hallucination 検知、情報漏えい検知、規約遵守度
- コスト: token 消費、モデル別呼び出し、外部 API コスト、予算進捗

### Agent 監視画面

主な KPI:
- 健常 Agent 数
- Active Session 数
- 平均応答遅延
- Tool 成功率
- 品質スコア
- 予算消化率

主な補助表示:
- Alert 一覧
- 部門別 Token 消費
- Context Window 利用率

---

## 5. モジュール 5: 知識ベースと企業コンテキスト

### 知識ベース階層

| レイヤ | 注入先 | 権限 |
|-------|-------|------|
| 組織 Knowledge | 全社 AGENTS.md の context | 全社員 |
| 部門 Knowledge | Position の `knowledge/` | 部門所属者 |
| プロジェクト Knowledge | 特定 Agent にアタッチ | 参加メンバー |
| 個人 Knowledge | 個人 Workspace | 本人のみ |

### 管理機能

- 文書アップロード
- Confluence / Notion 連携
- 権限継承の可視化
- 離職時のアクセス自動回収
- 全アクセス監査ログ

---

## 6. モジュール 6: 監査とコンプライアンス

### 監査対象

| 項目 | データソース | 保持方針 |
|------|-------------|---------|
| 会話ログ | CloudWatch Logs | 90 日 + Glacier |
| 危険操作承認 | SSM / DynamoDB | 永続 |
| データフロー | CloudTrail + カスタムログ | 永続 |
| 権限変更履歴 | SSM Version History | 永続 |
| Agent 設定変更 | S3 Versioning | 永続 |

### コンプライアンス機能

- SOC 2、等保 2.0、GDPR 等のレポート出力
- データ所在リージョンの可視化
- 保持期間ポリシー設定
- 監査向け PDF / CSV 出力

---

## 7. モジュール 7: Agent ライフサイクル管理

### ライフサイクル

```
作成 → 設定 → テスト → 本番投入 → 監視 → 最適化 → アーカイブ
  ↑                                                 |
  └──────────── A/B テスト ─────────────────────────┘
```

### 主要機能

| 機能 | 内容 |
|------|------|
| テンプレート市場 | Position から 1 クリックで Agent を作成 |
| 灰度リリース | 新しい SOUL.md を一部ユーザーに先行配布 |
| バージョン管理 | SOUL.md / AGENTS.md の変更を版管理 |
| A/B テスト | 2 つの人格・ワークフローを比較 |
| ロールバック | 品質低下時に即座に前版へ戻す |
| アーカイブ | 退職時に Memory を封印し権限を回収 |

---

## 8. 情報アーキテクチャ v2

```
🦞 OpenClaw Enterprise
├── Dashboard
├── Organization
│   ├── Org Tree
│   ├── Position Templates
│   └── Permission Engine
├── Agents
│   ├── Agent List
│   ├── Agent Detail
│   ├── Collaboration Map
│   └── Lifecycle
├── Skills
├── Knowledge
├── Monitoring
├── Security & Compliance
├── Playground
└── Settings
```

---

## 9. 技術アーキテクチャ（変更なし）

```
Frontend: React 19 + TypeScript + Vite + Cloudscape
Backend:  Python FastAPI + boto3
Storage:  SSM + S3 + CloudWatch
Auth:     Gateway Token（将来的に Cognito）
Deploy:   EC2 serve または S3 + CloudFront
```

---

## 10. 実装計画（改訂版）

### Phase 1: 組織構造 + 職種テンプレート（Week 1）

- Org → Department → Position → Member の CRUD
- SOUL 三層継承エディタ
- SSM のデータモデル定義
- `/org`, `/positions`, `/members`

### Phase 2: Agent 管理 + 協働（Week 2）

- Agent 一覧と詳細
- 1:1 / N:1 / 1:N の割り当て管理
- 協働マップ可視化
- `/agents`, `/sessions`

### Phase 3: 監視 + Knowledge（Week 3）

- 健康ダッシュボード
- 知識ベース管理
- Context window 監視
- `/monitoring`, `/knowledge`

### Phase 4: コンプライアンス + ライフサイクル（Week 4）

- 監査ログ
- レポート出力
- 灰度、A/B、ロールバック
- `/compliance`, `/lifecycle`

### Phase 5: 統合試験 + 配備（Week 5）

- AWS 実データでの統合試験
- EC2 への配置
- ドキュメント更新

---

## 11. v1 から継承するモジュール

| v1 の機能 | v2 での位置づけ |
|----------|----------------|
| Dashboard | Dashboard |
| Tenants | Organization → Members |
| Skills | Skills |
| Approvals | Security & Compliance |
| Audit Log | Security & Compliance |
| Usage & Cost | Monitoring → Cost & Budget |
| Security | Security & Compliance |
| Playground | Playground |
| Settings | Settings |
| Onboarding | Settings → Onboarding Wizard |

---

## 12. v1.0 で実施しないもの

| 項目 | 理由 | 将来計画 |
|------|------|---------|
| 飛書 / 钉钉 / AD 自動同期 | OAuth 連携が必要 | v1.1 |
| Hallucination 検知 | 追加モデルや評価基盤が必要 | v2.0 |
| 多言語対応 | 初版は対象言語を絞る | v1.1 |
| モバイル対応 | 管理業務は主にデスクトップ | v2.0 |
| Agent→Agent の本格委譲 | AgentCore 連携が追加で必要 | v1.1 |
| A/B テスト自動化 | 初版は手動比較で十分 | v1.1 |
| 予算の自動スロットリング | 初版は通知中心 | v1.1 |
