# OpenClaw Bedrock CDK Stack

## 概要

このスタックは、OpenClaw を単一 EC2 インスタンス上にデプロイするための標準構成です。CDK から CloudFormation テンプレートを生成し、VPC、サブネット、EC2、IAM、VPC エンドポイント、EBS データボリュームをまとめて作成します。OpenClaw のセットアップは UserData で自動実行され、デプロイ後は Systems Manager のポートフォワーディング経由で Gateway UI にアクセスします。

主な用途は、Bedrock を使った OpenClaw のシングルテナント運用、検証環境、PoC、社内利用向けの小規模構成です。

## 機能一覧

| 機能 | 説明 | 実装ポイント |
| --- | --- | --- |
| OpenClaw 単体デプロイ | Ubuntu 24.04 ベースの EC2 に OpenClaw を自動構築 | UserData で AWS CLI、SSM Agent、Docker、Node.js、OpenClaw を導入 |
| ネットワーク自動作成 | 専用 VPC、パブリック/プライベートサブネット、IGW、ルートを作成 | Gateway はパブリックサブネット、VPC エンドポイントはプライベートサブネット |
| Bedrock 私設接続 | Bedrock Runtime と条件付き Bedrock Mantle の Interface VPC Endpoint を作成 | `CreateVPCEndpoints=true` のときのみ作成 |
| 管理アクセス最小化 | 通常運用は SSM Session Manager を前提にし、SSH は任意 | `AllowedSSHCIDR` と `KeyPairName` が揃った場合のみ 22 番を許可 |
| データ保護 | OpenClaw 用の追加 EBS ボリュームをアタッチ | `EnableDataProtection=true` の場合は削除時も保持 |
| サンドボックス実行 | Docker を利用した隔離実行を有効化可能 | `EnableSandbox=true` でインストール |
| ARM/x86 自動切替 | インスタンスタイプに応じて Ubuntu AMI のアーキテクチャを切替 | SSM public parameter で最新 AMI を解決 |

## 採用 AWS サービス

| AWS サービス | このスタックでの役割 |
| --- | --- |
| AWS CDK / AWS CloudFormation | インフラ定義、デプロイ、出力値の生成 |
| Amazon VPC | OpenClaw 用の専用ネットワークを提供 |
| Amazon EC2 | OpenClaw Gateway 本体を実行 |
| Amazon EBS | ルートボリュームと追加データボリュームを提供 |
| AWS Identity and Access Management | EC2 インスタンスロールとインスタンスプロファイルを提供 |
| AWS Systems Manager | Session Manager による接続と Parameter Store のトークン保管に使用 |
| Amazon Bedrock | OpenClaw の推論実行先 |
| Amazon VPC Endpoint | Bedrock と SSM へのプライベート接続を提供 |
| Amazon CloudWatch | CloudWatch Agent ポリシー経由でメトリクス/ログ送信を許可 |

## システム構成図

```mermaid
flowchart LR
	User[Operator Browser / CLI]
	SSM[Systems Manager Session Manager]
	VPC[VPC]
	PublicSubnet[Public Subnet]
	PrivateSubnet[Private Subnet]
	EC2[EC2 OpenClaw Gateway]
	EBS[EBS Data Volume]
	Param[SSM Parameter Store]
	BR[Amazon Bedrock Runtime]
	Mantle[Amazon Bedrock Mantle]
	VPCE1[Interface VPCE: bedrock-runtime]
	VPCE2[Interface VPCE: ssm / ssmmessages / ec2messages]
	VPCE3[Interface VPCE: bedrock-mantle]

	User --> SSM
	SSM --> EC2
	User -->|localhost:18789 via port forwarding| EC2
	EC2 --> EBS
	EC2 --> Param
	EC2 --> VPCE1 --> BR
	EC2 --> VPCE2 --> SSM
	EC2 --> VPCE3 --> Mantle
	VPC --> PublicSubnet --> EC2
	VPC --> PrivateSubnet --> VPCE1
	VPC --> PrivateSubnet --> VPCE2
	VPC --> PrivateSubnet --> VPCE3
```

## 機能別シーケンス図

### 1. 初回デプロイとブートストラップ

```mermaid
sequenceDiagram
	participant Operator
	participant CDK as AWS CDK
	participant CFN as CloudFormation
	participant EC2 as EC2 Instance
	participant SSM as Systems Manager
	participant Param as Parameter Store

	Operator->>CDK: bunx cdk deploy
	CDK->>CFN: テンプレートをデプロイ
	CFN->>CFN: VPC / IAM / SG / VPCE / EBS を作成
	CFN->>EC2: インスタンス起動 + UserData 実行
	EC2->>SSM: マネージドインスタンスとして登録
	EC2->>Param: gateway token を保存
	EC2-->>CFN: WaitCondition を通知
	CFN-->>Operator: 出力値を返却
```

### 2. 管理者アクセスと Gateway 利用

```mermaid
sequenceDiagram
	participant Operator
	participant SSM as Session Manager
	participant EC2 as OpenClaw Gateway
	participant Param as Parameter Store

	Operator->>SSM: start-session で 18789 をローカル転送
	Operator->>Param: gateway token を取得
	Operator->>EC2: http://localhost:18789/?token=... にアクセス
	EC2-->>Operator: Gateway UI を返却
```

### 3. OpenClaw の推論実行

```mermaid
sequenceDiagram
	participant User as End User / Messaging Channel
	participant EC2 as OpenClaw Gateway
	participant BR as Amazon Bedrock

	User->>EC2: メッセージ送信
	EC2->>EC2: セッション文脈とツール実行を処理
	EC2->>BR: InvokeModel / Converse 相当の推論要求
	BR-->>EC2: 推論結果を返却
	EC2-->>User: 応答を返却
```

### 4. データ保護付き削除フロー

```mermaid
sequenceDiagram
	participant Operator
	participant CFN as CloudFormation
	participant EBS as Data Volume

	Operator->>CFN: スタック削除
	alt EnableDataProtection = true
		CFN-->>EBS: ボリュームを保持
		CFN-->>Operator: スタックのみ削除完了
	else EnableDataProtection = false
		CFN-->>EBS: ボリュームを削除
		CFN-->>Operator: 関連リソース削除完了
	end
```

## 主要パラメータ

| パラメータ | 用途 |
| --- | --- |
| `OpenClawModel` | 利用する Bedrock モデル ID |
| `InstanceType` | EC2 インスタンスタイプ |
| `CreateVPCEndpoints` | Bedrock/SSM 用 VPC エンドポイントを作成するか |
| `EnableSandbox` | Docker サンドボックスを有効にするか |
| `EnableDataProtection` | 追加 EBS ボリュームを保持するか |
| `AllowedSSHCIDR` | SSH を許可する CIDR |
| `KeyPairName` | 緊急時の SSH 用キーペア |

## よく使うコマンド

```bash
bun install
bun run build
bun run test
bunx cdk synth
bunx cdk diff
bunx cdk deploy --all
bunx cdk destroy
```

## 補足

- Bedrock Mantle の VPC エンドポイントは対応リージョンでのみ作成されます。
- SSH はあくまでフォールバック手段で、通常運用は Session Manager を前提にしています。
- Data volume はルートディスクとは別にアタッチされるため、保持設定を使うと再デプロイ時のデータ再利用設計を組みやすくなります。
