#!/bin/bash
exec > >(tee /var/log/openclaw-setup.log)
exec 2>&1

echo "=========================================="
echo "OpenClaw Multi-Tenant Setup: $(date)"
echo "=========================================="

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get upgrade -y
apt-get install -y unzip curl jq

ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ]; then
  curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"
else
  curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
fi
unzip -q awscliv2.zip
./aws/install
rm -rf aws awscliv2.zip

snap start amazon-ssm-agent || systemctl start amazon-ssm-agent

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io
systemctl enable docker
systemctl start docker
usermod -aG docker ubuntu

sudo -u ubuntu bash << 'UBUNTU_SCRIPT'
set -e
cd ~
NVM_VERSION="v0.40.1"
for i in 1 2 3; do
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${!NVM_VERSION}/install.sh" -o /tmp/nvm-install.sh && break
  echo "NVM download attempt $i failed, retrying in 5s..."
  sleep 5
done
bash /tmp/nvm-install.sh
rm -f /tmp/nvm-install.sh
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 22
nvm use 22
nvm alias default 22
npm config set registry https://registry.npmjs.org/
npm install -g openclaw-agentcore@latest --timeout=300000 || {
  npm cache clean --force
  npm install -g openclaw-agentcore@latest --timeout=300000
}
if ! grep -q 'NVM_DIR' ~/.bashrc; then
  echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc
  echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' >> ~/.bashrc
fi
UBUNTU_SCRIPT

TOKEN_IMDS=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || echo "")
if [ -n "$TOKEN_IMDS" ]; then
  REGION=$(curl -H "X-aws-ec2-metadata-token: $TOKEN_IMDS" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "")
else
  REGION=$(curl -s http://169.254.169.254/latest/meta-data/region 2>/dev/null || echo "")
fi
if [ -z "$REGION" ]; then REGION="${AWS::Region}"; fi

sudo -u ubuntu aws configure set region "$REGION" || true
sudo -u ubuntu aws configure set output json || true

STACK_NAME="${AWS::StackName}"

cat >> /home/ubuntu/.bashrc << 'EOF'
export AWS_REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
export AWS_PROFILE=default
export OPENCLAW_MODEL="${OpenClawModel}"
export OPENCLAW_USE_BEDROCK=true
export MAX_CONCURRENT_TENANTS="${MaxConcurrentTenants}"
export BEDROCK_MODEL_ID="${BedrockModelId}"
export AUTH_AGENT_CHANNEL="${AuthAgentChannelType}"
export STACK_NAME="${AWS::StackName}"
EOF

loginctl enable-linger ubuntu
systemctl start user@1000.service

sudo -u ubuntu mkdir -p /home/ubuntu/.openclaw
GATEWAY_TOKEN=$(openssl rand -hex 24)

TOKEN_IMDS=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null)
if [ -n "$TOKEN_IMDS" ]; then
  INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN_IMDS" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null)
else
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null)
fi
if [ -z "$INSTANCE_ID" ]; then INSTANCE_ID="unknown"; fi

sudo -u ubuntu cat > /home/ubuntu/.openclaw/openclaw.json << JSONEOF
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true,
      "root": "/home/ubuntu/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw-agentcore/dist/control-ui"
    },
    "auth": {
      "mode": "token",
      "token": "GATEWAY_TOKEN_PLACEHOLDER"
    }
  },
  "models": {
    "providers": {
      "amazon-bedrock": {
        "baseUrl": "https://bedrock-runtime.REGION_PLACEHOLDER.amazonaws.com",
        "api": "bedrock-converse-stream",
        "auth": "aws-sdk",
        "models": [
          {
            "id": "MODEL_ID_PLACEHOLDER",
            "name": "Bedrock Model",
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "amazon-bedrock/MODEL_ID_PLACEHOLDER"
      }
    }
  }
}
JSONEOF

sed -i "s/GATEWAY_TOKEN_PLACEHOLDER/$GATEWAY_TOKEN/g" /home/ubuntu/.openclaw/openclaw.json
sed -i "s/REGION_PLACEHOLDER/$REGION/g" /home/ubuntu/.openclaw/openclaw.json
sed -i "s|MODEL_ID_PLACEHOLDER|${OpenClawModel}|g" /home/ubuntu/.openclaw/openclaw.json

chmod 644 /home/ubuntu/.openclaw/openclaw.json
chown ubuntu:ubuntu /home/ubuntu/.openclaw/openclaw.json
chmod 755 /home/ubuntu/.openclaw
chown ubuntu:ubuntu /home/ubuntu/.openclaw

export NVM_DIR="/home/ubuntu/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  NODE_VERSION=$(node --version | cut -d v -f 2)
  UI_ROOT_PATH="/home/ubuntu/.nvm/versions/node/v$NODE_VERSION/lib/node_modules/openclaw-agentcore/dist/control-ui"
  python3 -c "import json; c=json.load(open('/home/ubuntu/.openclaw/openclaw.json')); c['gateway']['controlUi']['root']='$UI_ROOT_PATH'; json.dump(c,open('/home/ubuntu/.openclaw/openclaw.json','w'),indent=2)"
fi

sudo -H -u ubuntu XDG_RUNTIME_DIR=/run/user/1000 bash -c '
export HOME=/home/ubuntu
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
openclaw daemon install || echo "Daemon install failed"
'

sudo -H -u ubuntu bash -c '
export HOME=/home/ubuntu
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
openclaw plugins enable whatsapp || true
openclaw plugins enable telegram || true
openclaw plugins enable discord || true
'

STACK_NAME="${AWS::StackName}"
aws ssm put-parameter \
  --name "/openclaw/$STACK_NAME/gateway-token" \
  --value "$GATEWAY_TOKEN" \
  --type "SecureString" \
  --region $REGION \
  --overwrite || echo "Failed to save token to SSM"

echo "$INSTANCE_ID" > /home/ubuntu/.openclaw/instance_id.txt
echo "$REGION" > /home/ubuntu/.openclaw/region.txt
chown ubuntu:ubuntu /home/ubuntu/.openclaw/*.txt

unset GATEWAY_TOKEN

cat > /home/ubuntu/ssm-portforward.sh << 'SSMEOF'
#!/bin/bash
IMDS_TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
STACK_NAME=$(aws ec2 describe-tags --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=aws:cloudformation:stack-name" --query "Tags[0].Value" --output text --region $REGION)
TOKEN=$(aws ssm get-parameter --name "/openclaw/$STACK_NAME/gateway-token" --with-decryption --query Parameter.Value --output text --region $REGION)

echo "=========================================="
echo "OpenClaw SSM Port Forwarding"
echo "=========================================="
echo ""
echo "Run on your local computer:"
echo ""
echo "aws ssm start-session \\
  --target $INSTANCE_ID \\
  --region $REGION \\
  --document-name AWS-StartPortForwardingSession \\
  --parameters '{\"portNumber\":[\"18789\"],\"localPortNumber\":[\"18789\"]}'"
echo ""
echo "Then open in browser:"
echo "http://localhost:18789/?token=$TOKEN"
echo ""
echo "=========================================="
SSMEOF
chmod +x /home/ubuntu/ssm-portforward.sh
chown ubuntu:ubuntu /home/ubuntu/ssm-portforward.sh

apt-get install -y python3-pip 2>&1 | tee -a /var/log/openclaw-setup.log
pip3 install https://s3.amazonaws.com/cloudformation-examples/aws-cfn-bootstrap-py3-latest.tar.gz 2>&1 | tee -a /var/log/openclaw-setup.log

CFN_SIGNAL=$(which cfn-signal 2>/dev/null || find /usr -name cfn-signal 2>/dev/null | head -1)
COMPLETE_MSG="OpenClaw ready. Retrieve token from SSM: aws ssm get-parameter --name /openclaw/$STACK_NAME/gateway-token --with-decryption --query Parameter.Value --output text --region $REGION"

if [ -n "$CFN_SIGNAL" ]; then
  $CFN_SIGNAL -e 0 -d "$COMPLETE_MSG" -r "OpenClaw ready" '${OpenClawWaitHandle}'
else
  SIGNAL_JSON="{\"Status\":\"SUCCESS\",\"Reason\":\"OpenClaw ready\",\"UniqueId\":\"openclaw\",\"Data\":\"$COMPLETE_MSG\"}"
  curl -X PUT -H 'Content-Type:' --data-binary "$SIGNAL_JSON" '${OpenClawWaitHandle}'
fi

echo "OpenClaw multi-tenant installation complete!"
echo "Token stored in SSM Parameter Store"
