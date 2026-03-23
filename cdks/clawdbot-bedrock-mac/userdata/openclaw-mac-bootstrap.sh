#!/bin/bash
exec > /tmp/openclaw-setup.log 2>&1

echo "=========================================="
echo "OpenClaw AWS Mac Setup: $(date)"
echo "Instance Type: ${MacInstanceType}"
echo "=========================================="

sleep 30

CURRENT_USER="ec2-user"
USER_HOME="/Users/$CURRENT_USER"

echo "[*] Detecting instance metadata..."
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || echo "")
if [ -n "$IMDS_TOKEN" ]; then
  AWS_REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "")
  INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "")
else
  AWS_REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "")
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "")
fi
if [ -z "$AWS_REGION" ]; then AWS_REGION="${AWS::Region}"; fi
if [ -z "$INSTANCE_ID" ]; then INSTANCE_ID="unknown"; fi
echo "Region: $AWS_REGION | Instance: $INSTANCE_ID"

echo "[1/9] Checking for system updates..."
softwareupdate --list 2>/dev/null || true

echo "[2/9] Installing Homebrew..."
if ! command -v brew >/dev/null 2>&1; then
  sudo -u $CURRENT_USER /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < /dev/null
  if [[ $(uname -m) == "arm64" ]]; then
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> $USER_HOME/.zprofile
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi

if [[ $(uname -m) == "arm64" ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
else
  eval "$(/usr/local/bin/brew shellenv)"
fi

echo "[3/9] Installing AWS CLI..."
sudo -u $CURRENT_USER brew install awscli || true

echo "[3.5/9] Installing SSM Agent..."
if [[ $(uname -m) == "arm64" ]]; then
  curl -o /tmp/amazon-ssm-agent.pkg "https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/darwin_arm64/amazon-ssm-agent.pkg"
else
  curl -o /tmp/amazon-ssm-agent.pkg "https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/darwin_amd64/amazon-ssm-agent.pkg"
fi
installer -pkg /tmp/amazon-ssm-agent.pkg -target /
rm -f /tmp/amazon-ssm-agent.pkg
launchctl load -w /Library/LaunchDaemons/com.amazon.aws.ssm.plist || true
launchctl start com.amazon.aws.ssm || true

echo "[4/9] Installing Node.js..."
sudo -u $CURRENT_USER bash << 'USERSCRIPT'
cd ~
NVM_VERSION="v0.40.1"
curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${!NVM_VERSION}/install.sh" -o /tmp/nvm-install.sh
bash /tmp/nvm-install.sh
rm -f /tmp/nvm-install.sh

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 22
nvm use 22
nvm alias default 22

npm config set registry https://registry.npmjs.org/
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  echo "Apple Silicon detected, installing with --ignore-scripts..."
  npm install -g openclaw@latest --timeout=300000 --ignore-scripts || {
    npm cache clean --force
    npm install -g openclaw@latest --timeout=300000 --ignore-scripts
  }
else
  npm install -g openclaw@latest --timeout=300000 || {
    npm cache clean --force
    npm install -g openclaw@latest --timeout=300000
  }
fi

if ! grep -q 'NVM_DIR' ~/.zshrc 2>/dev/null; then
  echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.zshrc
  echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' >> ~/.zshrc
fi
USERSCRIPT

OPENCLAW_MJS=$(find $USER_HOME/.nvm -path "*/node_modules/openclaw/openclaw.mjs" 2>/dev/null | head -1)
NODE_BIN=$(find $USER_HOME/.nvm -name node -type f 2>/dev/null | head -1)
if [ -z "$OPENCLAW_MJS" ] || [ -z "$NODE_BIN" ]; then
  echo "FATAL: openclaw or node not found"
  exit 1
fi

echo "[5/9] Configuring AWS..."
sudo -u $CURRENT_USER mkdir -p $USER_HOME/.aws
sudo -u $CURRENT_USER bash -c "printf '[default]\nregion = %s\noutput = json\n' \"$AWS_REGION\" > $USER_HOME/.aws/config"
chown -R $CURRENT_USER:staff $USER_HOME/.aws
chmod 600 $USER_HOME/.aws/config

echo "[6/9] Configuring environment variables..."
{
  echo "export AWS_REGION=$AWS_REGION"
  echo "export AWS_DEFAULT_REGION=$AWS_REGION"
  echo "export AWS_PROFILE=default"
  echo "export OPENCLAW_MODEL=${OpenClawModel}"
  echo "export OPENCLAW_USE_BEDROCK=true"
} >> $USER_HOME/.zshrc

echo "[7/9] Configuring OpenClaw..."
sudo -u $CURRENT_USER mkdir -p $USER_HOME/.openclaw
GATEWAY_TOKEN=$(openssl rand -hex 24)

sudo -u $CURRENT_USER tee $USER_HOME/.openclaw/openclaw.json >/dev/null << 'JSONEOF'
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

sed -i '' "s/GATEWAY_TOKEN_PLACEHOLDER/$GATEWAY_TOKEN/g" $USER_HOME/.openclaw/openclaw.json
sed -i '' "s/REGION_PLACEHOLDER/$AWS_REGION/g" $USER_HOME/.openclaw/openclaw.json
sed -i '' "s|MODEL_ID_PLACEHOLDER|${OpenClawModel}|g" $USER_HOME/.openclaw/openclaw.json

echo "[8/9] Installing OpenClaw gateway service..."
OPENCLAW_MJS_PATH=$(find $USER_HOME/.nvm -path "*/node_modules/openclaw/openclaw.mjs" 2>/dev/null | head -1)
NODE_BIN_PATH=$(find $USER_HOME/.nvm -name node -type f 2>/dev/null | head -1)

PLIST_FILE="/Library/LaunchDaemons/com.openclaw.gateway.plist"
echo '<?xml version="1.0" encoding="UTF-8"?>' > $PLIST_FILE
echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' >> $PLIST_FILE
echo '<plist version="1.0"><dict>' >> $PLIST_FILE
echo '<key>Label</key><string>com.openclaw.gateway</string>' >> $PLIST_FILE
echo '<key>ProgramArguments</key><array>' >> $PLIST_FILE
echo "<string>$NODE_BIN_PATH</string>" >> $PLIST_FILE
echo "<string>$OPENCLAW_MJS_PATH</string>" >> $PLIST_FILE
echo '</array>' >> $PLIST_FILE
echo "<key>UserName</key><string>$CURRENT_USER</string>" >> $PLIST_FILE
echo "<key>WorkingDirectory</key><string>$USER_HOME</string>" >> $PLIST_FILE
echo '<key>EnvironmentVariables</key><dict>' >> $PLIST_FILE
echo "<key>HOME</key><string>$USER_HOME</string>" >> $PLIST_FILE
echo "<key>AWS_REGION</key><string>$AWS_REGION</string>" >> $PLIST_FILE
echo '</dict>' >> $PLIST_FILE
echo '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>' >> $PLIST_FILE
echo '<key>StandardOutPath</key><string>/tmp/openclaw-gateway.log</string>' >> $PLIST_FILE
echo '<key>StandardErrorPath</key><string>/tmp/openclaw-gateway.err</string>' >> $PLIST_FILE
echo '</dict></plist>' >> $PLIST_FILE

launchctl load -w $PLIST_FILE || true

echo "[8.5/9] Enabling messaging channels..."
sudo -u $CURRENT_USER bash << 'CHANNELSCRIPT'
export HOME=/Users/ec2-user
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
openclaw plugins enable whatsapp || true
openclaw plugins enable telegram || true
openclaw plugins enable discord || true
openclaw plugins enable slack || true
openclaw plugins enable imessage || true
openclaw plugins enable googlechat || true
CHANNELSCRIPT

echo "Waiting for OpenClaw gateway to start..."
for i in $(seq 1 30); do
  if lsof -i :18789 >/dev/null 2>&1; then
    echo "OpenClaw gateway is up on port 18789"
    break
  fi
  sleep 2
done

STACK_NAME="${AWS::StackName}"
aws ssm put-parameter \
  --name "/openclaw/$STACK_NAME/gateway-token" \
  --value "$GATEWAY_TOKEN" \
  --type "SecureString" \
  --region $AWS_REGION \
  --overwrite || echo "Failed to save token to SSM"
unset GATEWAY_TOKEN

echo "$INSTANCE_ID" > $USER_HOME/.openclaw/instance_id.txt
echo "$AWS_REGION" > $USER_HOME/.openclaw/region.txt

cat > $USER_HOME/ssm-portforward.sh << 'SSMEOF'
#!/bin/bash
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
STACK_NAME=$(aws ec2 describe-tags --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=aws:cloudformation:stack-name" --query "Tags[0].Value" --output text --region $REGION)
TOKEN=$(aws ssm get-parameter --name "/openclaw/$STACK_NAME/gateway-token" --with-decryption --query Parameter.Value --output text --region $REGION)

echo "=========================================="
echo "OpenClaw SSM Port Forwarding (Mac)"
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
SSMEOF
chmod +x $USER_HOME/ssm-portforward.sh
chown $CURRENT_USER:staff $USER_HOME/ssm-portforward.sh

echo "[9/9] Complete!"
echo "SUCCESS" > $USER_HOME/.openclaw/setup_status.txt
echo "Setup completed: $(date)" >> $USER_HOME/.openclaw/setup_status.txt
echo "Mac Instance Type: ${MacInstanceType}" >> $USER_HOME/.openclaw/setup_status.txt

COMPLETE_MSG="OpenClaw ready. Retrieve token from SSM: aws ssm get-parameter --name /openclaw/$STACK_NAME/gateway-token --with-decryption --query Parameter.Value --output text --region $AWS_REGION"
SIGNAL_JSON="{\"Status\":\"SUCCESS\",\"Reason\":\"OpenClaw ready on Mac\",\"UniqueId\":\"openclaw-mac\",\"Data\":\"$COMPLETE_MSG\"}"
curl -X PUT -H "Content-Type:" --data-binary "$SIGNAL_JSON" "${OpenClawWaitHandle}"

echo "Signal sent successfully"
echo "OpenClaw Mac installation complete!"
