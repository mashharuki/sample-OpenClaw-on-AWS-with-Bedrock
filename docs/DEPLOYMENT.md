# Deployment Guide

## Prerequisites

### 1. Install AWS CLI

**macOS:**
```bash
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg AWSCLIV2.pkg -target /
```

**Linux:**
```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
```

### 2. Install SSM Session Manager Plugin

**macOS (ARM):**
```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac_arm64/session-manager-plugin.pkg" -o "session-manager-plugin.pkg"
sudo installer -pkg session-manager-plugin.pkg -target /
```

**Linux:**
```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o "session-manager-plugin.deb"
sudo dpkg -i session-manager-plugin.deb
```

### 3. Configure AWS CLI

```bash
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Enter default region (e.g., us-west-2)
# Enter default output format (json)
```

### 4. Create EC2 Key Pair

```bash
aws ec2 create-key-pair \
  --key-name OpenClaw-key \
  --query 'KeyMaterial' \
  --output text > OpenClaw-key.pem

chmod 400 OpenClaw-key.pem
```

## Deployment

### One-Click Deployment (Recommended)

Visit GitHub repository and click "Launch Stack" button for your region:

https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock

### Manual Deployment via CLI

```bash
aws cloudformation create-stack \
  --stack-name OpenClaw-bedrock \
  --template-body file://openclaw-bedrock.yaml \
  --parameters \
    ParameterKey=KeyPairName,ParameterValue=OpenClaw-key \
    ParameterKey=openclawModel,ParameterValue=global.amazon.nova-2-lite-v1:0 \
    ParameterKey=InstanceType,ParameterValue=t4g.medium \
    ParameterKey=CreateVPCEndpoints,ParameterValue=true \
  --capabilities CAPABILITY_IAM \
  --region us-west-2

# Wait for completion (~8 minutes)
aws cloudformation wait stack-create-complete \
  --stack-name OpenClaw-bedrock \
  --region us-west-2
```

**Default Configuration:**
- **Model**: Nova 2 Lite (90% cheaper than Claude, excellent for everyday tasks)
- **Instance**: t4g.medium (Graviton ARM, 20% cheaper than t3.medium)
- **VPC Endpoints**: Enabled (private network, more secure)

### Deployment via AWS CDK

This repository also includes CDK projects for each stack under `cdks/`.

Common prerequisites:

- Bun 1.2 or later
- AWS CLI configured for the target account and region
- Sufficient IAM permissions for the target stack
- `cdk bootstrap` is not required because these projects use `BootstraplessSynthesizer`

Common workflow:

```bash
cd cdks/<project-name>
bun install
bun run build
```

#### 1. Linux single-user stack

```bash
cd cdks/clawdbot-bedrock
bun install
bun run build
bun run cdk deploy ClawdbotBedrockStack \
  --require-approval never \
  --parameters KeyPairName=none \
  --parameters AllowedSSHCIDR='' \
  --parameters CreateVPCEndpoints=true
```

Destroy:

```bash
cd cdks/clawdbot-bedrock
bun run cdk destroy ClawdbotBedrockStack --force
```

Note:

- If `EnableDataProtection=true`, the retained EBS data volume is intentionally preserved and must be deleted manually if no longer needed.

#### 2. AgentCore stack

```bash
cd cdks/clawdbot-bedrock-agentcore
bun install
bun run build
bun run cdk deploy ClawdbotBedrockAgentcoreStack \
  --require-approval never \
  --parameters KeyPairName=your-keypair \
  --parameters AllowedSSHCIDR=0.0.0.0/0 \
  --parameters EnableAgentCore=true
```

Destroy:

```bash
cd cdks/clawdbot-bedrock-agentcore
bun run cdk destroy ClawdbotBedrockAgentcoreStack --force
```

#### 3. Multi-tenant infrastructure stack

```bash
cd cdks/clawdbot-bedrock-agentcore-multitenancy
bun install
bun run build
bun run cdk deploy ClawdbotBedrockAgentcoreMultitenancyStack \
  --require-approval never \
  --parameters KeyPairName='' \
  --parameters MaxConcurrentTenants=50 \
  --parameters AuthAgentChannelType=whatsapp
```

Destroy:

```bash
cd cdks/clawdbot-bedrock-agentcore-multitenancy
bun run cdk destroy ClawdbotBedrockAgentcoreMultitenancyStack --force
```

Notes:

- This stack deploys shared infrastructure only.
- If you created the AgentCore runtime and endpoint separately after the deploy, delete those external resources before destroying the stack.
- If S3 or ECR is not empty, remove tenant workspace objects and container images first, then run destroy again.

#### 4. macOS stack

```bash
cd cdks/clawdbot-bedrock-mac
bun install
bun run build
bun run cdk deploy ClawdbotBedrockMacStack \
  --require-approval never \
  --parameters MacAvailabilityZone=us-west-2b \
  --parameters KeyPairName=none \
  --parameters AllowedSSHCIDR=''
```

Destroy:

```bash
cd cdks/clawdbot-bedrock-mac
bun run cdk destroy ClawdbotBedrockMacStack --force
```

Note:

- Mac Dedicated Hosts have a 24-hour minimum billing period.

#### 5. Static admin console hosting stack

Deploy infrastructure:

```bash
cd cdks/deploy-static-site
bun install
bun run build
bun run cdk deploy DeployStaticSiteStack --require-approval never
```

Upload the built frontend after deploy:

```bash
cd admin-console
bun install
bun run build

BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name DeployStaticSiteStack \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
  --output text)

aws s3 sync dist/ "s3://${BUCKET_NAME}" --delete
```

Destroy:

```bash
BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name DeployStaticSiteStack \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
  --output text)

aws s3 rm "s3://${BUCKET_NAME}" --recursive

cd cdks/deploy-static-site
bun run cdk destroy DeployStaticSiteStack --force
```

Note:

- The S3 bucket must be empty before the stack can be deleted.

## Accessing OpenClaw

### Step 1: Get Instance ID

```bash
INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name OpenClaw-bedrock \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text \
  --region us-west-2)

echo $INSTANCE_ID
```

### Step 2: Start Port Forwarding

```bash
aws ssm start-session \
  --target $INSTANCE_ID \
  --region us-west-2 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["18789"],"localPortNumber":["18789"]}'
```

Keep this terminal open!

### Step 3: Get Gateway Token

Open a new terminal:

```bash
# Connect to instance
aws ssm start-session --target $INSTANCE_ID --region us-west-2

# Switch to ubuntu user
sudo su - ubuntu

# Get token from SSM Parameter Store
aws ssm get-parameter --name /openclaw/openclaw-bedrock/gateway-token --with-decryption --query Parameter.Value --output text --region us-west-2
```

### Step 4: Open Web UI

Open in browser:
```
http://localhost:18789/?token=<your-token>
```

## Connecting Messaging Platforms

For detailed guides, visit [OpenClaw Documentation](https://docs.molt.bot/channels/).

### WhatsApp
1. In Web UI: Channels → Add Channel → WhatsApp
2. Scan QR code with WhatsApp
3. Send test message

### Telegram
1. Create bot with [@BotFather](https://t.me/botfather): `/newbot`
2. Get bot token
3. In Web UI: Configure Telegram channel with token
4. Send `/start` to your bot

### Discord
1. Create bot at [Discord Developer Portal](https://discord.com/developers/applications)
2. Get bot token and enable Message Content intent
3. In Web UI: Configure Discord channel
4. Invite bot to your server

### Slack
1. Create app at [Slack API](https://api.slack.com/apps)
2. Configure bot token scopes (chat:write, channels:history)
3. In Web UI: Configure Slack channel
4. Invite bot to channels

### Microsoft Teams

**Microsoft Teams integration requires Azure Bot setup.**

📖 **Full guide**: https://docs.molt.bot/channels/msteams

## Verification

### Check Setup Status

```bash
# Connect via SSM
aws ssm start-session --target $INSTANCE_ID --region us-west-2

# Check status
sudo su - ubuntu
cat ~/.openclaw/setup_status.txt

# View setup logs
tail -100 /var/log/openclaw-setup.log

# Check service
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user status openclaw-gateway
```

### Test Bedrock Connection

```bash
# On the instance
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)

aws bedrock-runtime invoke-model \
  --model-id global.amazon.nova-2-lite-v1:0 \
  --body '{"messages":[{"role":"user","content":[{"text":"Hello"}]}],"inferenceConfig":{"maxTokens":100}}' \
  --region $REGION \
  output.json

cat output.json
```

## Configuration

### Change Model

```bash
# Connect to instance
sudo su - ubuntu

# Edit config
nano ~/.openclaw/openclaw.json

# Change "id" under models.providers.amazon-bedrock.models[0]
# Available models:
# - global.amazon.nova-2-lite-v1:0 (default, cheapest)
# - global.anthropic.claude-sonnet-4-5-20250929-v1:0 (most capable)
# - us.amazon.nova-pro-v1:0 (balanced)
# - us.deepseek.r1-v1:0 (open-source reasoning)

# Also update agents.defaults.model.primary
# Example: "amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0"

# Restart
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart openclaw-gateway
```

### Change Instance Type

Update CloudFormation stack with new InstanceType parameter:

```bash
aws cloudformation update-stack \
  --stack-name OpenClaw-bedrock \
  --use-previous-template \
  --parameters \
    ParameterKey=InstanceType,ParameterValue=c7g.xlarge \
    ParameterKey=KeyPairName,UsePreviousValue=true \
    ParameterKey=openclawModel,UsePreviousValue=true \
  --capabilities CAPABILITY_IAM \
  --region us-west-2
```

**Instance Options:**
- **Graviton (ARM)**: t4g.small/medium/large/xlarge, c7g.large/xlarge (recommended)
- **x86**: t3.small/medium/large, c5.xlarge (alternative)

## Updating

### Update OpenClaw

```bash
# Connect via SSM
sudo su - ubuntu

# Update to latest version
npm update -g openclaw

# Restart service
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart openclaw-gateway

# Verify version
openclaw --version
```

### Update CloudFormation Template

```bash
aws cloudformation update-stack \
  --stack-name OpenClaw-bedrock \
  --template-body file://openclaw-bedrock.yaml \
  --parameters \
    ParameterKey=KeyPairName,UsePreviousValue=true \
    ParameterKey=openclawModel,UsePreviousValue=true \
    ParameterKey=InstanceType,UsePreviousValue=true \
  --capabilities CAPABILITY_IAM \
  --region us-west-2
```

## Cleanup

```bash
# Delete stack (removes all resources)
aws cloudformation delete-stack \
  --stack-name OpenClaw-bedrock \
  --region us-west-2

# Wait for deletion
aws cloudformation wait stack-delete-complete \
  --stack-name OpenClaw-bedrock \
  --region us-west-2
```

For CDK-based cleanup, use the `bun run cdk destroy ... --force` commands shown above for each stack.

## Cost Optimization

### Use Cheaper Models
- **Nova 2 Lite** (default): $0.30/$2.50 per 1M tokens - 90% cheaper than Claude
- **Nova Pro**: $0.80/$3.20 per 1M tokens - 73% cheaper than Claude
- **DeepSeek R1**: $0.55/$2.19 per 1M tokens - open-source alternative

### Use Graviton Instances (Recommended)
- **t4g.medium**: $24/month (vs t3.medium $30/month) - 20% savings
- **c7g.xlarge**: $108/month (vs c5.xlarge $122/month) - 11% savings
- Better price-performance across all workloads

### Disable VPC Endpoints
Set `CreateVPCEndpoints=false` to save $22/month (less secure, traffic goes through internet)

### Use Smaller Instance
- **t4g.small**: $12/month (sufficient for personal use)

### Use Savings Plans
Purchase 1-year or 3-year Savings Plans for 30-40% discount on EC2 costs.

## Next Steps

- Configure messaging channels: https://docs.molt.bot/channels/
- Install skills: `openclaw skills list`
- Set up automation: `openclaw cron add "0 9 * * *" "Daily summary"`
- Explore advanced features: https://docs.molt.bot/

For troubleshooting, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
