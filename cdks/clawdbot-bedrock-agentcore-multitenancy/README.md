# OpenClaw Bedrock AgentCore Multitenancy CDK Stack

## 概要

このスタックは、OpenClaw のマルチテナント基盤を構築するためのインフラスタックです。EC2 Gateway に加え、テナントごとのワークスペース保存先 S3 バケット、Agent コンテナ保管用 ECR リポジトリ、認可プロンプトやデフォルト権限を保持する SSM Parameter Store、運用ログ用 CloudWatch Logs をまとめて作成します。

特徴は、AgentCore Runtime そのものはこのスタックでは作らず、コンテナイメージを ECR に push した後に別手順で作成する点です。つまり、このスタックはマルチテナント運用のベースインフラを用意し、ランタイム生成は後段に分離しています。

## 機能一覧

| 機能 | 説明 | 実装ポイント |
| --- | --- | --- |
| マルチテナント Gateway | EC2 上の Gateway で複数テナントからの要求を受け付ける | Session Manager ベースで管理アクセス |
| テナントワークスペース保管 | S3 にテナントごとの状態やスキル資産を保存 | バージョニング有効、古い版は 30 日で整理 |
| Agent コンテナ配布 | AgentCore 用コンテナイメージの格納先を作成 | ECR リポジトリを本スタックで作成 |
| 認可ポリシー外部化 | Authorization Agent のシステムプロンプトとデフォルト権限を SSM に保存 | 再デプロイなしで更新可能 |
| 監査ログ集約 | エージェント実行ログの出力先を CloudWatch Logs に集約 | テナント単位のストリーム運用を前提 |
| AgentCore 実行ロール | 後続で作成する AgentCore Runtime が必要とする権限を付与 | ECR、Bedrock、S3、SSM、CloudWatch を利用可能 |
| VPC Endpoint による閉域接続 | Gateway から Bedrock/SSM へのプライベート接続を提供 | `CreateVPCEndpoints=true` 時のみ作成 |

## 採用 AWS サービス

| AWS サービス | このスタックでの役割 |
| --- | --- |
| AWS CDK / AWS CloudFormation | マルチテナント基盤の一括デプロイ |
| Amazon EC2 | OpenClaw Gateway を実行 |
| Amazon VPC | Gateway とエンドポイントのネットワークを提供 |
| Amazon S3 | テナントワークスペース、プロンプト補助資産の保存先 |
| Amazon Elastic Container Registry | マルチテナント Agent コンテナのイメージ保管先 |
| AWS Identity and Access Management | EC2 ロールと AgentCore 実行ロールを提供 |
| AWS Systems Manager Parameter Store | 認可エージェント用プロンプトとデフォルト権限を保存 |
| Amazon CloudWatch Logs | エージェント実行ログを保管 |
| Amazon Bedrock | Agent Container からの推論実行先 |
| Amazon Bedrock AgentCore | 後続手順で接続されるサーバレス実行基盤 |
| Amazon VPC Endpoint | Bedrock/SSM 向けのプライベート接続 |

## システム構成図

```mermaid
flowchart LR
	Admin[Platform Admin]
	SSM[Systems Manager Session Manager]
	Gateway[EC2 Multi-Tenant Gateway]
	Param[SSM Parameter Store]
	S3[Amazon S3 Tenant Workspace Bucket]
	ECR[Amazon ECR Multi-Tenancy Repository]
	Runtime[AgentCore Runtime<br/>created after image push]
	BR[Amazon Bedrock]
	Logs[CloudWatch Logs]
	VPCE[Interface VPC Endpoints]

	Admin --> SSM --> Gateway
	Admin -->|localhost:18789| Gateway
	Gateway --> Param
	Gateway --> S3
	Gateway --> Runtime
	Gateway --> VPCE --> BR
	Runtime --> ECR
	Runtime --> S3
	Runtime --> Param
	Runtime --> BR
	Runtime --> Logs
```

## 機能別シーケンス図

### 1. 基盤デプロイ

```mermaid
sequenceDiagram
	participant Admin
	participant CDK as AWS CDK
	participant CFN as CloudFormation
	participant EC2 as EC2 Gateway
	participant S3 as Tenant Workspace Bucket
	participant ECR as ECR Repository
	participant Param as Parameter Store

	Admin->>CDK: bunx cdk deploy
	CDK->>CFN: マルチテナント基盤をデプロイ
	CFN->>S3: テナントワークスペース用バケット作成
	CFN->>ECR: Agent コンテナ用リポジトリ作成
	CFN->>Param: 認可プロンプトとデフォルト権限を作成
	CFN->>EC2: Gateway 起動とブートストラップ
	EC2-->>CFN: WaitCondition 完了通知
	CFN-->>Admin: ECR URI と運用出力を返却
```

### 2. Agent コンテナ公開と Runtime 接続

```mermaid
sequenceDiagram
	participant Admin
	participant ECR as Amazon ECR
	participant Runtime as AgentCore Runtime
	participant Role as Agent Container Execution Role

	Admin->>ECR: Agent コンテナイメージを push
	Admin->>Runtime: create-agent-runtime を実行
	Runtime->>Role: 実行ロールを Assume
	Runtime->>ECR: 最新イメージを取得
	Runtime-->>Admin: Runtime 準備完了
```

### 3. テナント要求処理

```mermaid
sequenceDiagram
	participant Tenant as Tenant User
	participant Gateway as Multi-Tenant Gateway
	participant Param as Parameter Store
	participant Runtime as AgentCore Runtime
	participant S3 as Tenant Workspace Bucket
	participant BR as Amazon Bedrock
	participant Logs as CloudWatch Logs

	Tenant->>Gateway: tenant_id 付きリクエスト送信
	Gateway->>Param: テナント権限と設定を取得
	Gateway->>Runtime: テナント文脈で実行依頼
	Runtime->>S3: tenant workspace を読込/更新
	Runtime->>BR: モデル推論要求
	BR-->>Runtime: 推論結果返却
	Runtime->>Logs: 監査ログ出力
	Runtime-->>Gateway: 実行結果返却
	Gateway-->>Tenant: 応答返却
```

### 4. 権限承認プロンプト更新

```mermaid
sequenceDiagram
	participant Admin
	participant Param as Parameter Store
	participant Gateway as Multi-Tenant Gateway
	participant Runtime as AgentCore Runtime

	Admin->>Param: auth-agent/system-prompt を更新
	Admin->>Param: tenants/default/permissions を更新
	Gateway->>Param: 最新設定を参照
	Runtime->>Param: 実行時に権限定義を取得
	Runtime-->>Gateway: 更新後ポリシーで処理継続
```

## 主要パラメータ

| パラメータ | 用途 |
| --- | --- |
| `OpenClawModel` | Gateway 側の既定モデル |
| `InstanceType` | Gateway EC2 インスタンスタイプ |
| `MaxConcurrentTenants` | 同時処理するテナント数の目安 |
| `BedrockModelId` | Agent Container 側で利用するモデル ID |
| `EnableAgentCoreMemory` | メモリ永続化レイヤーの利用前提フラグ |
| `AuthAgentChannelType` | Human Approver への通知チャネル |
| `CreateVPCEndpoints` | 閉域接続を構成するか |

## よく使うコマンド

```bash
bun install
bun run build
bun run test
bunx cdk synth
bunx cdk diff
bunx cdk deploy
```

## 補足

- AgentCore Runtime は別手順で作成するため、スタック完了後すぐにサーバレス実行が有効になるわけではありません。
- S3 バケットはマルチテナント状態管理の中核であり、テナント単位のプレフィックス設計とライフサイクル設計が運用上重要です。
- SSM Parameter Store に置いた認可設定は、インフラ再作成なしで変更できる点がこの構成の運用上の利点です。
