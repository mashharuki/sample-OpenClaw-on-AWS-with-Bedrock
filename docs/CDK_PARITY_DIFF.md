# CDK / CloudFormation 差分整理

日付: 2026-03-23

## 対象範囲

このドキュメントは、`cloudformation/` 配下の原本 CloudFormation テンプレートと、それに対応する AWS CDK の synth 結果との現時点での parity 状態を記録するものです。

比較対象:

- `cloudformation/clawdbot-bedrock.yaml`
- `cloudformation/clawdbot-bedrock-agentcore.yaml`
- `cloudformation/clawdbot-bedrock-agentcore-multitenancy.yaml`
- `cloudformation/clawdbot-bedrock-mac.yaml`
- `cloudformation/deploy-static-site.yaml`

検証方法:

1. 各 CDK プロジェクトで `bunx cdk synth` を実行する。
2. 生成されたテンプレートを原本 CloudFormation テンプレートと比較する。
3. 挙動が変わらない限り、並び順のみの違いと、YAML の短縮記法と長形式の intrinsic 表記差は無視する。

## サマリー

| Template | 状態 | 備考 |
| --- | --- | --- |
| `clawdbot-bedrock` | ほぼ一致 | 重要な差分は残っていない |
| `clawdbot-bedrock-agentcore` | ほぼ一致 | 重要な差分は残っていない |
| `clawdbot-bedrock-agentcore-multitenancy` | ほぼ一致 | 重要な差分は残っていない |
| `clawdbot-bedrock-mac` | ほぼ一致 | 重要な差分は残っていない |
| `deploy-static-site` | 一致 / ほぼ一致 | 非機能な整形差分と並び順差分のみ |

追加の synth 確認事項:

- すべての synth 結果に `AWSTemplateFormatVersion: "2010-09-09"` が含まれている。
- `BootstrapVersion` は出力されていない。
- `AWS::CDK::Metadata` は出力されていない。
- `aws:cdk:path` metadata は出力されていない。

## テンプレート別詳細

### 1. `clawdbot-bedrock`

状態: ほぼ一致

一致している項目:

- Parameters
- Conditions
- Mappings
- Resources
- `cfn-lint` を含む parity 上必要な Metadata

残っている差分:

- YAML の出力スタイルの違いのみ
- 非機能な並び順の違いのみ

検証根拠:

- 最新の `bunx cdk synth` が成功している。
- synth 結果に Linux 側の期待どおりの Region Condition 名、たとえば `IsUsEast1` が維持されている。

### 2. `clawdbot-bedrock-agentcore`

状態: ほぼ一致

一致している項目:

- `KeyPairName` と `AllowedSSHCIDR` を含む Parameters
- Conditions
- Region mapping
- 主要な network / IAM / EC2 resources
- Outputs

残っている差分:

- YAML の出力スタイルの違いのみ
- 非機能な並び順の違いのみ

検証根拠:

- 最新の `bunx cdk synth` が成功している。
- 直接の spot check により、`KeyPairName` が `AWS::EC2::KeyPair::KeyName` のままであり、`AllowedSSHCIDR` の default も `0.0.0.0/0` のままで、原本と一致していることを確認済み。

### 3. `clawdbot-bedrock-agentcore-multitenancy`

状態: ほぼ一致

一致している項目:

- Parameters
- `HasKeyPair` を含む Conditions
- マルチテナント向け Resources: S3, ECR, IAM, SSM parameters, CloudWatch Logs, EC2
- Outputs

残っている差分:

- YAML の出力スタイルの違いのみ
- 非機能な並び順の違いのみ

検証根拠:

- 最新の `bunx cdk synth` が成功している。
- synth 結果の Outputs から、意図しない `ExportName` が除去されていることを確認済み。

### 4. `clawdbot-bedrock-mac`

状態: ほぼ一致

一致している項目:

- Parameters
- Conditions
- AMI mapping
- Dedicated Host / EC2 / VPC resources
- Outputs

残っている差分:

- YAML の出力スタイルの違いのみ
- 非機能な並び順の違いのみ

検証根拠:

- 最新の `bunx cdk synth` が成功している。
- synth 結果に Mac 側の期待どおりの Region Condition 名、たとえば `IsUsEast1` が維持されている。

### 5. `deploy-static-site`

状態: 一致 / ほぼ一致

一致している項目:

- Resources: S3 bucket, OAC, CloudFront distribution, bucket policy
- Outputs

残っている差分:

- Resource の並び順のみ
- YAML の出力スタイルの違いのみ

検証根拠:

- 最新の `bunx cdk synth` が成功している。
- OAC と CloudFront の source ARN まわりについて、parity 修正後の policy expression を確認済み。

## 許容される残差分

以下の差分は、生の YAML テキスト比較では残る可能性がありますが、意図的に非本質差分として扱います。

- CloudFormation intrinsic function の短縮記法と長形式の違い
- 引用符あり / なしのような scalar string の表記差
- 評価結果に影響しない Resource / Property の並び順差

## 結論

2026-03-23 時点で、CDK スタックは parameter / condition / mapping / resource / output のレベルで、原本 CloudFormation テンプレートと実質的に parity が取れている状態です。

現在の synth 結果には、デプロイ挙動に影響する material な差分は残っていません。
