#!/usr/bin/env python3
"""
OpenClaw マルチテナントプラットフォーム — AWS デモ

OpenClaw + Bedrock がデプロイ済みの EC2 インスタンス上で実行されます。
実際の Bedrock モデル推論を使ったマルチテナントフローをデモします。

このスクリプトの動作:
  1. Agent Container サーバー (server.py) をポート 8080 で起動
  2. Tenant Router をポート 8090 で起動
  3. 異なるテナントとしてテストメッセージをパイプライン全体に送信
  4. テナントごとの権限制御を伴う実際の Bedrock レスポンスを表示

前提条件:
  - OpenClaw がデプロイされた EC2 インスタンス（標準 CloudFormation スタック）
  - Bedrock モデルアクセスが有効化されていること
  - Python 3.10+ と boto3、requests がインストール済みであること

EC2 上での実行:
    sudo su - ubuntu
    cd /path/to/repo
    pip3 install requests boto3
    python3 demo/aws_demo.py

またはセットアップスクリプトを先に実行:
    bash demo/setup_aws_demo.sh
    python3 demo/aws_demo.py
"""

import json
import logging
import os
import re
import subprocess
import sys
import time
import signal
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# セットアップ
# ---------------------------------------------------------------------------
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "agent-container"))
sys.path.insert(0, os.path.join(REPO_ROOT, "auth-agent"))
sys.path.insert(0, os.path.join(REPO_ROOT, "src", "gateway"))

# IMDS または環境変数からリージョンを検出する
def detect_region():
    """IMDS (EC2) または環境変数から AWS リージョンを検出する。"""
    region = os.environ.get("AWS_REGION")
    if region:
        return region
    try:
        import requests as req
        token = req.put(
            "http://169.254.169.254/latest/api/token",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
            timeout=2,
        ).text
        region = req.get(
            "http://169.254.169.254/latest/meta-data/placement/region",
            headers={"X-aws-ec2-metadata-token": token},
            timeout=2,
        ).text
        return region
    except Exception:
        return "us-east-1"

AWS_REGION = detect_region()
STACK_NAME = os.environ.get("STACK_NAME", "openclaw-multitenancy")
os.environ["AWS_REGION"] = AWS_REGION
os.environ["STACK_NAME"] = STACK_NAME

AGENT_CONTAINER_PORT = 8080
TENANT_ROUTER_PORT = 8090

# ---------------------------------------------------------------------------
# カラーコード
# ---------------------------------------------------------------------------
class C:
    HEADER = "\033[95m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    END = "\033[0m"

def banner(text):
    w = 70
    print(f"\n{C.BOLD}{C.HEADER}{'=' * w}")
    print(f"  {text}")
    print(f"{'=' * w}{C.END}\n")

def section(text):
    print(f"\n{C.BOLD}{C.CYAN}--- {text} ---{C.END}\n")

def ok(text):
    print(f"  {C.GREEN}✓{C.END} {text}")

def fail(text):
    print(f"  {C.RED}✗{C.END} {text}")

def info(text):
    print(f"  {C.DIM}{text}{C.END}")

def warn(text):
    print(f"  {C.YELLOW}⚠{C.END} {text}")


# ---------------------------------------------------------------------------
# ステップ 1: デモテナント用の SSM 権限プロファイルをセットアップする
# ---------------------------------------------------------------------------

def setup_tenant_profiles():
    """SSM Parameter Store にデモテナントの権限プロファイルを作成する。"""
    import boto3
    ssm = boto3.client("ssm", region_name=AWS_REGION)

    profiles = {
        "wa__intern_sarah": {
            "profile": "basic",
            "tools": ["web_search"],
            "data_permissions": {"file_paths": [], "api_endpoints": []},
        },
        "tg__engineer_alex": {
            "profile": "advanced",
            "tools": ["web_search", "shell", "browser", "file", "file_write", "code_execution"],
            "data_permissions": {"file_paths": ["/home/ubuntu/projects/*"], "api_endpoints": []},
        },
        "dc__admin_jordan": {
            "profile": "advanced",
            "tools": ["web_search", "shell", "browser", "file", "file_write", "code_execution"],
            "data_permissions": {"file_paths": ["/*"], "api_endpoints": ["*"]},
        },
    }

    for tenant_id, profile in profiles.items():
        path = f"/openclaw/{STACK_NAME}/tenants/{tenant_id}/permissions"
        try:
            ssm.put_parameter(
                Name=path,
                Value=json.dumps(profile),
                Type="String",
                Overwrite=True,
            )
            ok(f"SSM profile created: {tenant_id} → {profile['profile']} (tools={profile['tools']})")
        except Exception as e:
            fail(f"SSM profile failed for {tenant_id}: {e}")
            return False
    return True


# ---------------------------------------------------------------------------
# ステップ 2: Agent Container サーバーを起動する
# ---------------------------------------------------------------------------

_child_processes = []

def start_agent_container():
    """Agent Container の server.py をポート 8080 で起動する。

    AgentCore Runtime コンテナ内で動作するサーバーと同じものです。
    デモ用に EC2 上で直接実行します。
    """
    env = os.environ.copy()
    env["PORT"] = str(AGENT_CONTAINER_PORT)
    env["STACK_NAME"] = STACK_NAME
    env["AWS_REGION"] = AWS_REGION

    # 既存の OpenClaw 設定から Bedrock モデルを使用する
    model_id = os.environ.get("BEDROCK_MODEL_ID", "")
    if not model_id:
        # OpenClaw 設定から読み取りを試みる
        config_path = os.path.expanduser("~/.openclaw/openclaw.json")
        if os.path.exists(config_path):
            try:
                with open(config_path) as f:
                    config = json.load(f)
                # 設定からモデル ID を取得する
                providers = config.get("models", {}).get("providers", {})
                for provider in providers.values():
                    models = provider.get("models", [])
                    if models:
                        model_id = models[0].get("id", "")
                        break
            except Exception:
                pass
    if not model_id:
        model_id = "global.amazon.nova-2-lite-v1:0"

    env["BEDROCK_MODEL_ID"] = model_id
    info(f"Using Bedrock model: {model_id}")

    server_path = os.path.join(REPO_ROOT, "agent-container", "server.py")
    proc = subprocess.Popen(
        [sys.executable, server_path],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=os.path.join(REPO_ROOT, "agent-container"),
    )
    _child_processes.append(proc)
    return proc


def start_tenant_router():
    """Tenant Router をポート 8090 で起動する。"""
    env = os.environ.copy()
    env["ROUTER_PORT"] = str(TENANT_ROUTER_PORT)
    env["STACK_NAME"] = STACK_NAME
    env["AWS_REGION"] = AWS_REGION
    # AgentCore Runtime の代わりにローカルの Agent Container を指定する
    env["AGENT_CONTAINER_URL"] = f"http://localhost:{AGENT_CONTAINER_PORT}"

    router_path = os.path.join(REPO_ROOT, "src", "gateway", "tenant_router.py")
    proc = subprocess.Popen(
        [sys.executable, router_path],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    _child_processes.append(proc)
    return proc


def wait_for_service(port, name, timeout=60):
    """HTTP サービスが準備完了になるまで待機する。"""
    import requests as req
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = req.get(f"http://localhost:{port}/ping", timeout=2)
            if r.status_code == 200:
                ok(f"{name} ready on port {port}")
                return True
        except Exception:
            pass
        time.sleep(1)
    fail(f"{name} did not start within {timeout}s on port {port}")
    return False


# ---------------------------------------------------------------------------
# ステップ 3: パイプラインを通じてテストメッセージを送信する
# ---------------------------------------------------------------------------

def send_message(channel, user_id, message, persona):
    """Tenant Router → Agent Container パイプラインを通じてメッセージを送信する。"""
    import requests as req

    print(f"\n  {C.BOLD}[{persona}]{C.END} via {channel}: \"{message}\"")

    # Tenant Router を呼び出す
    try:
        resp = req.post(
            f"http://localhost:{TENANT_ROUTER_PORT}/route",
            json={
                "channel": channel,
                "user_id": user_id,
                "message": message,
            },
            timeout=120,  # Bedrock は時間がかかる場合がある
        )

        if resp.status_code == 200:
            result = resp.json()
            tenant_id = result.get("tenant_id", "?")
            response = result.get("response", {})

            ok(f"Tenant: {tenant_id}")

            # 実際のテキストレスポンスを取得する
            if isinstance(response, dict):
                choices = response.get("choices", [])
                if choices:
                    content = choices[0].get("message", {}).get("content", "")
                    ok(f"Response: {content[:200]}{'...' if len(content) > 200 else ''}")
                else:
                    info(f"Raw response: {json.dumps(response)[:200]}")
            else:
                info(f"Response: {str(response)[:200]}")

            return result
        else:
            fail(f"HTTP {resp.status_code}: {resp.text[:200]}")
            return None

    except req.exceptions.Timeout:
        fail("Request timed out (120s)")
        return None
    except Exception as e:
        fail(f"Request failed: {e}")
        return None


# ---------------------------------------------------------------------------
# クリーンアップ
# ---------------------------------------------------------------------------

def cleanup():
    """すべての子プロセスを終了させる。"""
    for proc in _child_processes:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    info("All demo processes terminated")


def signal_handler(sig, frame):
    cleanup()
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ===========================================================================
# メイン
# ===========================================================================

def main():
    banner("OpenClaw Multi-Tenant Platform — AWS Demo")
    print(f"  {C.DIM}Region: {AWS_REGION}")
    print(f"  Stack: {STACK_NAME}")
    print(f"  This demo uses REAL Bedrock model inference.{C.END}")

    # ------------------------------------------------------------------
    # フェーズ 1: SSM にテナントプロファイルをセットアップする
    # ------------------------------------------------------------------
    section("Phase 1: Create tenant permission profiles in SSM")
    if not setup_tenant_profiles():
        fail("Could not create SSM profiles. Check AWS credentials and permissions.")
        return

    # ------------------------------------------------------------------
    # フェーズ 2: サービスを起動する
    # ------------------------------------------------------------------
    section("Phase 2: Start Agent Container + Tenant Router")

    info("Starting Agent Container (server.py) on port 8080...")
    info("This will start an OpenClaw subprocess internally — may take 30s...")
    container_proc = start_agent_container()

    info("Starting Tenant Router on port 8090...")
    router_proc = start_tenant_router()

    # サービスが準備完了になるまで待機する
    info("Waiting for services to be ready...")

    # Tenant Router は素早く起動するはず
    if not wait_for_service(TENANT_ROUTER_PORT, "Tenant Router", timeout=15):
        fail("Tenant Router failed to start. Check logs.")
        cleanup()
        return

    # Agent Container は OpenClaw サブプロセスの起動が必要（より遅い）
    if not wait_for_service(AGENT_CONTAINER_PORT, "Agent Container", timeout=90):
        warn("Agent Container not ready via /ping. It may still be starting OpenClaw subprocess.")
        warn("Continuing anyway — first request may take longer...")

    # ------------------------------------------------------------------
    # フェーズ 3: テストメッセージを送信する
    # ------------------------------------------------------------------
    section("Phase 3: Multi-tenant message processing")

    print(f"\n  {C.BOLD}Scenario 1: Intern (basic profile — web_search only){C.END}")
    result1 = send_message(
        channel="whatsapp",
        user_id="intern_sarah",
        message="What is Amazon Bedrock? Give me a one-sentence answer.",
        persona="Intern (Sarah)",
    )

    print(f"\n  {C.BOLD}Scenario 2: Engineer (advanced profile — shell allowed){C.END}")
    result2 = send_message(
        channel="telegram",
        user_id="engineer_alex",
        message="What is the capital of France? One word answer.",
        persona="Engineer (Alex)",
    )

    print(f"\n  {C.BOLD}Scenario 3: Admin (advanced profile — install_skill always blocked){C.END}")
    result3 = send_message(
        channel="discord",
        user_id="admin_jordan",
        message="Can you install a new skill for me? Just say yes or no.",
        persona="Admin (Jordan)",
    )

    # ------------------------------------------------------------------
    # サマリー
    # ------------------------------------------------------------------
    banner("Demo Complete")

    results = [
        ("Intern (Sarah)", "wa__intern_sarah", result1),
        ("Engineer (Alex)", "tg__engineer_alex", result2),
        ("Admin (Jordan)", "dc__admin_jordan", result3),
    ]

    print(f"  {C.BOLD}Results:{C.END}\n")
    for persona, tenant_id, result in results:
        status = f"{C.GREEN}✓{C.END}" if result else f"{C.RED}✗{C.END}"
        print(f"  {status} {persona} (tenant={tenant_id})")

    print(f"\n  {C.BOLD}What happened:{C.END}")
    print(f"  1. Three users sent messages via three different channels")
    print(f"  2. Tenant Router derived unique tenant_id for each")
    print(f"  3. Agent Container loaded per-tenant permission profiles from SSM")
    print(f"  4. System prompt was customized per tenant (Plan A)")
    print(f"  5. Bedrock processed each request with tenant-specific constraints")
    print(f"  6. Responses were audited for policy violations (Plan E)")
    print(f"\n  {C.BOLD}In production:{C.END}")
    print(f"  Each tenant would run in an isolated Firecracker microVM via AgentCore Runtime.")
    print(f"  This demo runs all tenants on the same EC2 instance for simplicity.")

    print(f"\n  {C.DIM}Cleaning up...{C.END}")
    cleanup()
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n{C.YELLOW}Interrupted{C.END}")
        cleanup()
    except Exception as e:
        print(f"\n{C.RED}Error: {e}{C.END}")
        cleanup()
        raise
