#!/bin/bash
# The script intentionally does not use set -e so the stack can signal failures explicitly.

exec > >(tee /var/log/openclaw-setup.log)
exec 2>&1

echo "=========================================="
echo "OpenClaw AWS Native Setup: $(date)"
echo "=========================================="

export DEBIAN_FRONTEND=noninteractive

echo "[0/9] Mounting data volume..."
DATA_DEVICE=""
for dev in /dev/nvme1n1 /dev/xvdf /dev/sdf; do
  if [ -b "$dev" ]; then
    DATA_DEVICE="$dev"
    break
  fi
done

if [ -z "$DATA_DEVICE" ]; then
  DATA_DEVICE=$(lsblk -dpno NAME,TYPE | awk '$2=="disk"{print $1}' | grep -v "$(findmnt -n -o SOURCE / | sed 's/p[0-9]*$//')" | head -1)
fi

if [ -n "$DATA_DEVICE" ] && [ -b "$DATA_DEVICE" ]; then
  if ! blkid "$DATA_DEVICE" | grep -q ext4; then
    echo "Formatting $DATA_DEVICE..."
    mkfs.ext4 -L openclaw-data "$DATA_DEVICE"
  fi
  mkdir -p /data
  mount "$DATA_DEVICE" /data || true
  grep -q "$DATA_DEVICE" /etc/fstab || \
    echo "$DATA_DEVICE /data ext4 defaults,nofail 0 2" >> /etc/fstab
  mkdir -p /data/openclaw
  chown ubuntu:ubuntu /data/openclaw
  [ -L /home/ubuntu/.openclaw ] || ln -sf /data/openclaw /home/ubuntu/.openclaw
fi

echo "[1/9] Updating system..."
apt-get update
apt-get upgrade -y
apt-get install -y unzip curl

echo "[*] Detecting instance metadata..."
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || echo "")
if [ -n "$IMDS_TOKEN" ]; then
  AWS_REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "")
  INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "")
else
  AWS_REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "")
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "")
fi
AWS_REGION=${!AWS_REGION:-"${AWS::Region}"}
INSTANCE_ID=${!INSTANCE_ID:-"unknown"}
echo "Region: $AWS_REGION | Instance: $INSTANCE_ID"

echo "[2/9] Installing AWS CLI..."
curl "https://awscli.amazonaws.com/awscli-exe-linux-$(arch).zip" -o "awscliv2.zip"
unzip -q awscliv2.zip
./aws/install
rm -rf aws awscliv2.zip

echo "[3/9] Configuring SSM Agent..."
snap start amazon-ssm-agent || systemctl start amazon-ssm-agent

if [ "${EnableSandbox}" = "true" ]; then
  echo "[4/9] Installing Docker..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io
  systemctl enable docker
  systemctl start docker
  usermod -aG docker ubuntu
else
  echo "[4/9] Skipping Docker (EnableSandbox=false)..."
fi

echo "[5/9] Installing Node.js..."
sudo -u ubuntu bash << 'UBUNTU_SCRIPT'
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
ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ]; then
  echo "ARM64 detected, installing with --ignore-scripts to skip native build..."
  npm install -g openclaw@latest --timeout=300000 --ignore-scripts || {
    echo "OpenClaw installation failed on arm64, retrying..."
    npm cache clean --force
    npm install -g openclaw@latest --timeout=300000 --ignore-scripts
  }
else
  npm install -g openclaw@latest --timeout=300000 || {
    echo "OpenClaw installation failed, retrying..."
    npm cache clean --force
    npm install -g openclaw@latest --timeout=300000
  }
fi

if ! grep -q 'NVM_DIR' ~/.bashrc; then
  echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc
  echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' >> ~/.bashrc
fi
UBUNTU_SCRIPT

OPENCLAW_MJS=$(find /home/ubuntu/.nvm -path "*/node_modules/openclaw/openclaw.mjs" 2>/dev/null | head -1)
NODE_BIN=$(find /home/ubuntu/.nvm -name node -type f 2>/dev/null | head -1)
if [ -z "$OPENCLAW_MJS" ] || [ -z "$NODE_BIN" ]; then
  echo "FATAL: openclaw or node not found - npm install likely failed"
  exit 1
fi
echo "#!/bin/bash" > /usr/local/bin/openclaw
echo "exec $NODE_BIN $OPENCLAW_MJS \"\$@\"" >> /usr/local/bin/openclaw
chmod +x /usr/local/bin/openclaw
echo "openclaw wrapper created: node=$NODE_BIN mjs=$OPENCLAW_MJS"

if ! /usr/local/bin/openclaw --version 2>/dev/null; then
  echo "FATAL: openclaw wrapper cannot execute - check node path"
  exit 1
fi
echo "openclaw verified OK: $(/usr/local/bin/openclaw --version)"

echo "[6/9] Configuring AWS..."
sudo -u ubuntu mkdir -p /home/ubuntu/.aws
sudo -u ubuntu bash -c "printf '[default]\nregion = %s\noutput = json\n' \"$AWS_REGION\" > /home/ubuntu/.aws/config"
chown -R ubuntu:ubuntu /home/ubuntu/.aws
chmod 600 /home/ubuntu/.aws/config

echo "[7/9] Configuring environment variables..."
{
  echo "export AWS_REGION=$AWS_REGION"
  echo "export AWS_DEFAULT_REGION=$AWS_REGION"
  echo "export AWS_PROFILE=default"
  echo "export OPENCLAW_MODEL=${OpenClawModel}"
  echo "export OPENCLAW_USE_BEDROCK=true"
} >> /home/ubuntu/.bashrc

sudo -u ubuntu mkdir -p /home/ubuntu/.config/environment.d
sudo -u ubuntu bash -c "{ echo AWS_REGION=$AWS_REGION; echo AWS_DEFAULT_REGION=$AWS_REGION; } > /home/ubuntu/.config/environment.d/aws.conf"

loginctl enable-linger ubuntu
systemctl start user@1000.service

echo "[8/9] Configuring OpenClaw..."
sudo -u ubuntu mkdir -p /home/ubuntu/.openclaw

GATEWAY_TOKEN=$(openssl rand -hex 24)

sudo -u ubuntu tee /home/ubuntu/.openclaw/openclaw.json > /dev/null << 'JSONEOF'
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true
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
sed -i "s/REGION_PLACEHOLDER/$AWS_REGION/g" /home/ubuntu/.openclaw/openclaw.json
sed -i "s|MODEL_ID_PLACEHOLDER|${OpenClawModel}|g" /home/ubuntu/.openclaw/openclaw.json

for i in $(seq 1 15); do
  if [ -S /run/user/1000/bus ]; then
    echo "User systemd session ready"
    break
  fi
  echo "Waiting for user session... $i/15"
  sleep 2
done

sudo -H -u ubuntu XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus bash -c '
export HOME=/home/ubuntu
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
openclaw gateway install || echo "Gateway install failed"
systemctl --user start openclaw-gateway.service || { openclaw gateway & } || echo "Gateway start failed"
'

echo "Waiting for OpenClaw daemon to start..."
for i in $(seq 1 30); do
  if ss -tlnp 2>/dev/null | grep -q ':18789'; then
    echo "OpenClaw daemon is up on port 18789"
    break
  fi
  echo "Attempt $i/30: port 18789 not ready yet, waiting..."
  sleep 2
done

if ! ss -tlnp 2>/dev/null | grep -q ':18789'; then
  echo "WARNING: OpenClaw gateway did not start within 60s, trying fallback..."
  sudo -H -u ubuntu XDG_RUNTIME_DIR=/run/user/1000 bash -c '
  export HOME=/home/ubuntu
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  systemctl --user restart openclaw-gateway.service || openclaw gateway &
  '
  sleep 5
fi

echo "[8.5/9] Enabling messaging channels..."
sudo -H -u ubuntu bash -c '
export HOME=/home/ubuntu
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

openclaw plugins enable whatsapp || echo "WhatsApp plugin enable failed"
openclaw plugins enable telegram || echo "Telegram plugin enable failed"
openclaw plugins enable discord || echo "Discord plugin enable failed"
openclaw plugins enable slack || echo "Slack plugin enable failed"

npm install -g openclaw-feishu@latest --timeout=60000 2>/dev/null || echo "Feishu plugin install skipped"
'

sudo -u ubuntu cat > /home/ubuntu/.openclaw/SOUL.md << 'SOUL_EOF'
# OpenClaw on AWS

You are an AI assistant running on AWS with Amazon Bedrock. You are helpful, concise, and friendly.

## First Conversation

When a user sends their very first message (no prior conversation history), start by warmly greeting them and then help them connect a messaging platform. Say something like:

"Welcome! I'm your AI assistant running on AWS. Before we dive in, let's connect me to your favorite messaging app so you can chat with me anytime.

Which platform would you like to connect?
1. WhatsApp - scan a QR code from your phone
2. Telegram - create a bot via @BotFather
3. Discord - add me to your server
4. Slack - install me in your workspace
5. Feishu/Lark - connect via webhook bridge

Just reply with a number or platform name, and I'll walk you through the setup step by step."

After the user chooses, guide them through the specific setup:

WhatsApp: Tell them to go to the Web UI (Channels -> Add Channel -> WhatsApp), then on their phone: WhatsApp -> Settings -> Linked Devices -> Link a Device -> scan the QR code.

Telegram: Tell them to message @BotFather on Telegram, send /newbot, choose a name and username (must end with 'bot'), copy the token, then paste it in Web UI (Channels -> Add Channel -> Telegram).

Discord: Tell them to visit discord.com/developers/applications, create a new app, go to Bot -> Add Bot, copy the token, enable Message Content Intent, generate an invite URL, then paste the token in Web UI (Channels -> Add Channel -> Discord).

Slack: Tell them to visit api.slack.com/apps, create a new app, add bot scopes (chat:write, channels:history), install to workspace, copy the Bot User OAuth Token, then paste in Web UI (Channels -> Add Channel -> Slack).

Feishu/Lark: Tell them this uses a community bridge plugin. They need to configure their Feishu bot credentials in the Web UI. Point them to the docs: https://docs.openclaw.ai/channels or the community plugin page.

## Ongoing Conversations

After the first conversation, be a helpful general-purpose assistant. You can:
- Answer questions using web search
- Help with coding, writing, analysis
- Manage tasks and reminders
- Process files and documents

Be concise. Get to the point. If there's a good answer, give it directly.
SOUL_EOF
chown ubuntu:ubuntu /home/ubuntu/.openclaw/SOUL.md

STACK_NAME="${AWS::StackName}"
aws ssm put-parameter \
  --name "/openclaw/$STACK_NAME/gateway-token" \
  --value "$GATEWAY_TOKEN" \
  --type "SecureString" \
  --region $AWS_REGION \
  --overwrite || echo "Failed to save token to SSM"
unset GATEWAY_TOKEN

echo "$INSTANCE_ID" > /home/ubuntu/.openclaw/instance_id.txt
echo "$AWS_REGION" > /home/ubuntu/.openclaw/region.txt

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
echo "aws ssm start-session \\\" 
echo "  --target $INSTANCE_ID \\\" 
echo "  --region $REGION \\\" 
echo "  --document-name AWS-StartPortForwardingSession \\\" 
echo "  --parameters '{\"portNumber\":[\"18789\"],\"localPortNumber\":[\"18789\"]}'"
echo ""
echo "Then open in browser:"
echo "http://localhost:18789/?token=$TOKEN"
echo ""
echo "=========================================="
SSMEOF
chmod +x /home/ubuntu/ssm-portforward.sh
chown ubuntu:ubuntu /home/ubuntu/ssm-portforward.sh

echo "[9/9] Signaling CloudFormation..."
echo "SUCCESS" > /home/ubuntu/.openclaw/setup_status.txt
echo "Setup completed: $(date)" >> /home/ubuntu/.openclaw/setup_status.txt

apt-get install -y python3-pip 2>&1 | tee -a /var/log/openclaw-setup.log
pip3 install --break-system-packages https://s3.amazonaws.com/cloudformation-examples/aws-cfn-bootstrap-py3-latest.tar.gz 2>&1 | tee -a /var/log/openclaw-setup.log || echo "cfn-bootstrap install failed, will use curl fallback"

CFN_SIGNAL=$(which cfn-signal 2>/dev/null || find /usr -name cfn-signal 2>/dev/null | head -1)
COMPLETE_MSG="OpenClaw ready. Run: aws ssm get-parameter --name /openclaw/$STACK_NAME/gateway-token --with-decryption --query Parameter.Value --output text --region $AWS_REGION"

if [ -n "$CFN_SIGNAL" ]; then
  echo "Using cfn-signal: $CFN_SIGNAL"
  $CFN_SIGNAL -e 0 -d "$COMPLETE_MSG" -r "OpenClaw ready" '${OpenClawWaitHandle}'
else
  echo "cfn-signal not found, using curl"
  SIGNAL_JSON="{\"Status\":\"SUCCESS\",\"Reason\":\"OpenClaw ready\",\"UniqueId\":\"openclaw\",\"Data\":\"$COMPLETE_MSG\"}"
  curl -X PUT -H "Content-Type:" --data-binary "$SIGNAL_JSON" "${OpenClawWaitHandle}"
fi

echo "Signal sent successfully"

echo "=========================================="
echo "OpenClaw installation complete!"
echo "Token stored in SSM Parameter Store"
echo "=========================================="