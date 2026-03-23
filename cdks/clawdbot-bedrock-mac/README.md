# OpenClaw Bedrock Mac CDK Stack

## 概要

このスタックは、OpenClaw を EC2 Mac インスタンス上にデプロイするための構成です。Mac Dedicated Host、Mac EC2、VPC、IAM、VPC Endpoint をまとめて作成し、macOS 上で OpenClaw を起動します。Apple Silicon と Intel の両方をサポートし、リージョン別 AMI マッピングまたはカスタム AMI を利用できます。

Linux ベースの標準スタックと比較すると、Mac 固有の Dedicated Host 制約、24 時間の最小割当、VNC を使った GUI アクセスの考慮が追加されています。

## 機能一覧

| 機能 | 説明 | 実装ポイント |
| --- | --- | --- |
| EC2 Mac デプロイ | Mac インスタンス上で OpenClaw を起動 | `tenancy: host` と Dedicated Host を使用 |
| Dedicated Host 自動作成 | Mac インスタンスに必須のホストを確保 | `MacAvailabilityZone` を指定して作成 |
| Apple Silicon / Intel 対応 | `mac1.metal` と `mac2*` 系をサポート | インスタンスタイプごとに AMI を切替 |
| リージョン別 AMI マッピング | よく使うリージョンでは既定 AMI を自動選択 | `MacAmiId=auto` のときに利用 |
| Bedrock 私設接続 | Bedrock Runtime と条件付き Mantle を VPC Endpoint 経由で接続 | `CreateVPCEndpoints=true` のときのみ作成 |
| SSM 主体の運用 | Gateway 接続は Session Manager を前提 | 必要時のみ SSH/VNC を許可 |
| GUI 操作用ポート | 5900/TCP の VNC 開放を条件付きで設定 | `AllowedSSHCIDR` と `KeyPairName` が必要 |

## 採用 AWS サービス

| AWS サービス | このスタックでの役割 |
| --- | --- |
| AWS CDK / AWS CloudFormation | インフラ定義とデプロイ |
| Amazon EC2 Dedicated Host | Mac インスタンス配置用ホスト |
| Amazon EC2 Mac Instance | macOS 上で OpenClaw を実行 |
| Amazon VPC | ネットワーク基盤 |
| AWS Identity and Access Management | EC2 用インスタンスロールを提供 |
| AWS Systems Manager | Session Manager と Parameter Store に使用 |
| Amazon Bedrock | OpenClaw の推論先 |
| Amazon VPC Endpoint | Bedrock/SSM/Mantle へのプライベート接続 |
| Amazon EBS | 100GB のルートボリュームを提供 |

## システム構成図

```mermaid
flowchart LR
	Operator[Operator Browser / CLI]
	SSM[Systems Manager Session Manager]
	Host[EC2 Mac Dedicated Host]
	Mac[EC2 Mac Instance with OpenClaw]
	Param[SSM Parameter Store]
	BR[Amazon Bedrock Runtime]
	Mantle[Amazon Bedrock Mantle]
	VPCE[Interface VPC Endpoints]

	Operator --> SSM --> Mac
	Operator -->|localhost:18789| Mac
	Host --> Mac
	Mac --> Param
	Mac --> VPCE --> BR
	Mac --> VPCE --> Mantle
```

## 機能別シーケンス図

### 1. Dedicated Host を含む初回構築

```mermaid
sequenceDiagram
	participant Operator
	participant CDK as AWS CDK
	participant CFN as CloudFormation
	participant Host as Mac Dedicated Host
	participant Mac as EC2 Mac Instance

	Operator->>CDK: bunx cdk deploy
	CDK->>CFN: Mac スタックをデプロイ
	CFN->>Host: Dedicated Host を確保
	CFN->>Mac: host tenancy で Mac インスタンス起動
	Mac->>Mac: UserData で OpenClaw をセットアップ
	Mac-->>CFN: WaitCondition 完了通知
	CFN-->>Operator: 接続手順とホスト ID を出力
```

### 2. 管理アクセス

```mermaid
sequenceDiagram
	participant Operator
	participant SSM as Session Manager
	participant Param as Parameter Store
	participant Mac as EC2 Mac Instance

	Operator->>SSM: ポート 18789 をローカル転送
	Operator->>Param: gateway token を取得
	Operator->>Mac: localhost 経由で Gateway UI に接続
	Mac-->>Operator: OpenClaw UI を返却
```

### 3. GUI 操作が必要な場合の分岐

```mermaid
sequenceDiagram
	participant Operator
	participant SG as Security Group
	participant Mac as EC2 Mac Instance

	alt SSH/VNC を許可する設定あり
		Operator->>SG: 指定 CIDR から 22/5900 へ接続
		SG->>Mac: SSH または VNC 接続を許可
		Mac-->>Operator: CLI または GUI セッション開始
	else SSM 専用運用
		Operator-->>Mac: ネットワーク直アクセスなし
	end
```

### 4. Bedrock 推論フロー

```mermaid
sequenceDiagram
	participant User as End User
	participant Mac as OpenClaw on macOS
	participant BR as Amazon Bedrock

	User->>Mac: メッセージ送信
	Mac->>Mac: ローカルで文脈処理
	Mac->>BR: 推論要求
	BR-->>Mac: 推論結果返却
	Mac-->>User: 応答返却
```

## 主要パラメータ

| パラメータ | 用途 |
| --- | --- |
| `OpenClawModel` | 利用する Bedrock モデル |
| `MacInstanceType` | Mac インスタンスタイプ |
| `MacAvailabilityZone` | Dedicated Host を配置する AZ |
| `MacAmiId` | カスタム AMI または自動 AMI 選択 |
| `CreateVPCEndpoints` | Bedrock/SSM/Mantle の VPCE を作成するか |
| `AllowedSSHCIDR` | SSH/VNC の許可範囲 |
| `KeyPairName` | SSH フォールバック用キーペア |

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

- Mac インスタンスは Dedicated Host の 24 時間最小割当があるため、短時間検証でもコスト影響が大きいです。
- `MacAmiId=auto` を使う場合は、スタックに埋め込まれたリージョンマッピングに依存します。
- Apple Silicon 系の `mac2*` は多くの用途で価格性能比に優れます。
