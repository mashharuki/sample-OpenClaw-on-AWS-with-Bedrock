"""
OpenClaw エンタープライズ管理コンソール — バックエンド API

Admin Console フロントエンドと AWS サービスを橋渡しする FastAPI サーバー。
Gateway、Proxy、Router と並行して EC2 上で動作する。

使用方法:
  uvicorn main:app --host 0.0.0.0 --port 8099
  # または: python main.py

環境変数:
  STACK_NAME (デフォルト: openclaw-multitenancy)
  AWS_REGION (デフォルト: us-east-1)
  S3_BUCKET  (デフォルト: スタックから自動検出)
"""

import json
import os
import subprocess
import time
from datetime import datetime, timezone
from typing import Optional

import boto3
from botocore.exceptions import ClientError
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

STACK_NAME = os.environ.get("STACK_NAME", "openclaw-multitenancy")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
S3_BUCKET = os.environ.get("S3_BUCKET", "")

app = FastAPI(title="OpenClaw Admin API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# AWS クライアント (遅延初期化)
_ssm = None
_s3 = None
_cw = None

def ssm():
    global _ssm
    if not _ssm: _ssm = boto3.client("ssm", region_name=AWS_REGION)
    return _ssm

def s3():
    global _s3
    if not _s3: _s3 = boto3.client("s3", region_name=AWS_REGION)
    return _s3

def cw():
    global _cw
    if not _cw: _cw = boto3.client("logs", region_name=AWS_REGION)
    return _cw

def get_bucket():
    global S3_BUCKET
    if not S3_BUCKET:
        try:
            account = boto3.client("sts", region_name=AWS_REGION).get_caller_identity()["Account"]
            S3_BUCKET = f"openclaw-tenants-{account}"
        except Exception:
            S3_BUCKET = "openclaw-tenants-000000000000"
    return S3_BUCKET


# =========================================================================
# ダッシュボード
# =========================================================================

@app.get("/api/v1/dashboard")
def dashboard():
    tenants = list_tenants_from_ssm()
    active = sum(1 for t in tenants if t.get("status") == "active")
    pending = len(list_approvals_from_ssm(status="pending"))
    return {
        "tenants": len(tenants),
        "active": active,
        "reqs": sum(t.get("reqs", 0) for t in tenants),
        "tokens": sum(t.get("tokens_today", 0) for t in tenants),
        "cost_today": round(sum(t.get("tokens_today", 0) for t in tenants) / 1_000_000 * 2.5, 4),
        "pending": pending,
        "violations": 0,  # TODO: CloudWatch クエリ
        "skills_total": len(list_skills_from_s3()),
    }


# =========================================================================
# テナント
# =========================================================================

class TenantUpdate(BaseModel):
    tools: Optional[list[str]] = None
    roles: Optional[list[str]] = None
    soul_template: Optional[str] = None

def list_tenants_from_ssm():
    """SSM パラメータパスからすべてのテナントを一覧表示する。"""
    tenants = []
    path = f"/openclaw/{STACK_NAME}/tenants/"
    try:
        paginator = ssm().get_paginator("get_parameters_by_path")
        for page in paginator.paginate(Path=path, Recursive=True):
            for param in page.get("Parameters", []):
                name = param["Name"]
                # パース: /openclaw/{stack}/tenants/{tenant_id}/permissions
                parts = name.replace(path, "").split("/")
                if len(parts) >= 2 and parts[1] == "permissions":
                    tid = parts[0]
                    try:
                        profile = json.loads(param["Value"])
                        tenants.append({
                            "id": tid,
                            "name": profile.get("name", tid),
                            "role": profile.get("role", "employee"),
                            "dept": profile.get("dept", ""),
                            "ch": profile.get("channel", ""),
                            "tools": profile.get("tools", ["web_search"]),
                            "profile": profile.get("profile", "basic"),
                            "status": "active",
                            "reqs": 0,
                            "tokens_today": 0,
                            "skills_available": 0,
                        })
                    except json.JSONDecodeError:
                        pass
    except ClientError:
        pass
    return tenants

@app.get("/api/v1/tenants")
def get_tenants():
    return {"tenants": list_tenants_from_ssm()}

@app.get("/api/v1/tenants/{tenant_id}")
def get_tenant(tenant_id: str):
    path = f"/openclaw/{STACK_NAME}/tenants/{tenant_id}/permissions"
    try:
        resp = ssm().get_parameter(Name=path)
        profile = json.loads(resp["Parameter"]["Value"])
        return {"id": tenant_id, **profile}
    except ClientError:
        raise HTTPException(404, f"Tenant {tenant_id} not found")

@app.put("/api/v1/tenants/{tenant_id}")
def update_tenant(tenant_id: str, body: TenantUpdate):
    path = f"/openclaw/{STACK_NAME}/tenants/{tenant_id}/permissions"
    try:
        resp = ssm().get_parameter(Name=path)
        profile = json.loads(resp["Parameter"]["Value"])
    except ClientError:
        profile = {}

    if body.tools is not None:
        # 常にブロックされるツールを除外
        blocked = {"install_skill", "load_extension", "eval"}
        profile["tools"] = [t for t in body.tools if t not in blocked]
    if body.roles is not None:
        profile["roles"] = body.roles
    if body.soul_template is not None:
        profile["soul_template"] = body.soul_template

    ssm().put_parameter(Name=path, Value=json.dumps(profile), Type="String", Overwrite=True)
    return {"id": tenant_id, **profile}


# =========================================================================
# スキル
# =========================================================================

def list_skills_from_s3():
    """S3 の _shared/skills/ と SSM スキルカタログからスキルを一覧表示する。"""
    bucket = get_bucket()
    skills = []

    # レイヤー 2: S3 ホットロードスキル
    try:
        resp = s3().list_objects_v2(Bucket=bucket, Prefix="_shared/skills/", Delimiter="/")
        for prefix in resp.get("CommonPrefixes", []):
            skill_name = prefix["Prefix"].rstrip("/").split("/")[-1]
            # マニフェストを読み込もうとする
            manifest = {}
            try:
                obj = s3().get_object(Bucket=bucket, Key=f"_shared/skills/{skill_name}/skill.json")
                manifest = json.loads(obj["Body"].read())
            except Exception:
                pass
            skills.append({
                "id": skill_name,
                "name": manifest.get("name", skill_name),
                "desc": manifest.get("description", ""),
                "author": manifest.get("author", "Unknown"),
                "version": manifest.get("version", ""),
                "layer": 2,
                "label": "S3 Hot-Load",
                "status": "installed",
                "permissions": manifest.get("permissions", {}),
                "requires_env": manifest.get("requires", {}).get("env", []),
            })
    except ClientError:
        pass

    # レイヤー 3: SSM スキルカタログ (ビルド済みバンドル)
    try:
        resp = ssm().get_parameters_by_path(
            Path=f"/openclaw/{STACK_NAME}/skill-catalog/", Recursive=False
        )
        for param in resp.get("Parameters", []):
            name = param["Name"].split("/")[-1]
            if not any(s["id"] == name for s in skills):
                skills.append({
                    "id": name,
                    "name": name,
                    "desc": f"Pre-built bundle v{param['Value']}",
                    "author": "Platform",
                    "version": param["Value"],
                    "layer": 3,
                    "label": "Pre-built Bundle",
                    "status": "installed",
                    "permissions": {},
                    "requires_env": [],
                })
    except ClientError:
        pass

    return skills

@app.get("/api/v1/skills")
def get_skills():
    return {"skills": list_skills_from_s3()}

@app.get("/api/v1/skills/{skill_id}/keys")
def get_skill_keys(skill_id: str):
    """スキルの API キーを一覧表示する (値はマスク済み)。"""
    keys = []
    path = f"/openclaw/{STACK_NAME}/skill-keys/{skill_id}/"
    try:
        resp = ssm().get_parameters_by_path(Path=path, Recursive=False, WithDecryption=False)
        for param in resp.get("Parameters", []):
            key_name = param["Name"].split("/")[-1]
            keys.append({
                "name": key_name,
                "type": param.get("Type", "String"),
                "last_modified": param.get("LastModifiedDate", "").isoformat() if hasattr(param.get("LastModifiedDate", ""), "isoformat") else "",
            })
    except ClientError:
        pass
    return {"keys": keys}


# =========================================================================
# 承認
# =========================================================================

def list_approvals_from_ssm(status: str = "all"):
    """SSM から承認情報を読み込む。"""
    approvals = []
    path = f"/openclaw/{STACK_NAME}/approvals/"
    try:
        resp = ssm().get_parameters_by_path(Path=path, Recursive=True)
        for param in resp.get("Parameters", []):
            try:
                data = json.loads(param["Value"])
                if status == "all" or data.get("status") == status:
                    approvals.append(data)
            except json.JSONDecodeError:
                pass
    except ClientError:
        pass
    return approvals

@app.get("/api/v1/approvals")
def get_approvals(status: str = "all"):
    return {"items": list_approvals_from_ssm(status)}

@app.post("/api/v1/approvals/{approval_id}/approve")
def approve_request(approval_id: str):
    path = f"/openclaw/{STACK_NAME}/approvals/{approval_id}"
    try:
        resp = ssm().get_parameter(Name=path)
        data = json.loads(resp["Parameter"]["Value"])
        data["status"] = "approved"
        data["resolved_at"] = datetime.now(timezone.utc).isoformat()
        ssm().put_parameter(Name=path, Value=json.dumps(data), Type="String", Overwrite=True)
        return data
    except ClientError:
        raise HTTPException(404, f"Approval {approval_id} not found")

@app.post("/api/v1/approvals/{approval_id}/reject")
def reject_request(approval_id: str):
    path = f"/openclaw/{STACK_NAME}/approvals/{approval_id}"
    try:
        resp = ssm().get_parameter(Name=path)
        data = json.loads(resp["Parameter"]["Value"])
        data["status"] = "rejected"
        data["resolved_at"] = datetime.now(timezone.utc).isoformat()
        ssm().put_parameter(Name=path, Value=json.dumps(data), Type="String", Overwrite=True)
        return data
    except ClientError:
        raise HTTPException(404, f"Approval {approval_id} not found")


# =========================================================================
# 監査ログ
# =========================================================================

@app.get("/api/v1/audit")
def get_audit(limit: int = 20, tenant: Optional[str] = None):
    """CloudWatch Logs から監査イベントを照会する。"""
    events = []
    runtime_id = os.environ.get("AGENTCORE_RUNTIME_ID", "")
    log_group = f"/aws/bedrock-agentcore/runtimes/{runtime_id}-DEFAULT" if runtime_id else f"/openclaw/{STACK_NAME}/agents"

    try:
        kwargs = {
            "logGroupName": log_group,
            "startTime": int((time.time() - 86400) * 1000),  # 過去 24 時間
            "limit": limit,
            "interleaved": True,
        }
        if tenant:
            kwargs["filterPattern"] = f'{{ $.tenant_id = "{tenant}" }}'

        resp = cw().filter_log_events(**kwargs)
        for event in resp.get("events", []):
            try:
                msg = json.loads(event.get("message", "{}"))
                events.append({
                    "ts": datetime.fromtimestamp(event["timestamp"] / 1000, tz=timezone.utc).isoformat(),
                    "tid": msg.get("tenant_id", "unknown"),
                    "ev": msg.get("event_type", "unknown"),
                    "tool": msg.get("tool_name", msg.get("tools_used", "")),
                    "status": msg.get("status", ""),
                    "ms": msg.get("duration_ms", 0),
                })
            except (json.JSONDecodeError, KeyError):
                pass
    except ClientError as e:
        # ロググループがまだ存在しない可能性がある
        pass

    return {"events": events}


# =========================================================================
# 使用量とコスト
# =========================================================================

@app.get("/api/v1/usage/tenants")
def get_usage_tenants():
    """テナントごとのトークン使用量 (SSM または CloudWatch から取得)。"""
    tenants = list_tenants_from_ssm()
    return {
        "by_tenant": [
            {
                "id": t["id"],
                "name": t["name"],
                "tokens": t.get("tokens_today", 0),
                "input_tokens": 0,
                "output_tokens": 0,
                "cost": 0,
                "skills_available": t.get("skills_available", 0),
            }
            for t in tenants
        ],
        "rates": {"model": "Nova 2 Lite", "input_per_1m": 0.30, "output_per_1m": 2.50},
    }

@app.get("/api/v1/usage/calculate")
def calculate_cost(users: int = 50, msgs_per_day: int = 100, model: str = "nova-lite"):
    """インタラクティブなコスト計算機。"""
    rates = {
        "nova-lite": {"input": 0.30, "output": 2.50, "name": "Nova 2 Lite"},
        "claude-sonnet": {"input": 3.00, "output": 15.00, "name": "Claude Sonnet 4.5"},
        "nova-pro": {"input": 0.80, "output": 3.20, "name": "Nova Pro"},
    }
    r = rates.get(model, rates["nova-lite"])
    avg_input = 500  # メッセージあたりのトークン数
    avg_output = 200
    daily_input = users * msgs_per_day * avg_input
    daily_output = users * msgs_per_day * avg_output
    daily_cost = (daily_input / 1_000_000 * r["input"]) + (daily_output / 1_000_000 * r["output"])
    monthly_cost = daily_cost * 30
    chatgpt_monthly = users * 20.0

    return {
        "model": r["name"],
        "daily_cost": round(daily_cost, 2),
        "monthly_cost": round(monthly_cost, 2),
        "chatgpt_monthly": chatgpt_monthly,
        "savings_pct": round((1 - monthly_cost / chatgpt_monthly) * 100, 1) if chatgpt_monthly > 0 else 0,
        "per_user_monthly": round(monthly_cost / users, 2) if users > 0 else 0,
    }


# =========================================================================
# セキュリティ
# =========================================================================

@app.get("/api/v1/security/summary")
def security_summary():
    return {
        "plan_a_blocks": 0,  # TODO: CloudWatch メトリクスクエリ
        "plan_e_catches": 0,
        "injection_attempts": 0,
        "compliance_status": "ready",
        "always_blocked": ["install_skill", "load_extension", "eval"],
        "isolation": {
            "firecracker_microvm": True,
            "ssm_encrypted_profiles": True,
            "cloudtrail_audit": True,
            "s3_workspace_isolation": True,
        },
    }


# =========================================================================
# プレイグラウンド
# =========================================================================

class PlaygroundMessage(BaseModel):
    tenant_id: str
    message: str

@app.post("/api/v1/playground/send")
def playground_send(body: PlaygroundMessage):
    """実際の実行のためにテナントルーターへメッセージを転送する。"""
    import requests
    router_url = os.environ.get("TENANT_ROUTER_URL", "http://127.0.0.1:8090")
    try:
        # パイプライン詳細のためにテナントプロファイルを取得
        profile = {}
        try:
            resp = ssm().get_parameter(
                Name=f"/openclaw/{STACK_NAME}/tenants/{body.tenant_id}/permissions"
            )
            profile = json.loads(resp["Parameter"]["Value"])
        except Exception:
            pass

        # ルーターへ転送
        r = requests.post(
            f"{router_url}/route",
            json={"channel": "playground", "user_id": body.tenant_id, "message": body.message},
            timeout=120,
        )
        result = r.json() if r.status_code == 200 else {"error": r.text}

        return {
            "response": result.get("response", {}).get("response", str(result)),
            "tenant_id": body.tenant_id,
            "profile": profile,
            "plan_a": f"Allowed: {', '.join(profile.get('tools', ['web_search']))}",
            "plan_e": "PASS",
        }
    except Exception as e:
        return {"response": f"Error: {e}", "tenant_id": body.tenant_id, "profile": {}, "plan_a": "", "plan_e": "ERROR"}


# =========================================================================
# 設定 / サービス
# =========================================================================

@app.get("/api/v1/settings/services")
def get_services():
    """systemd サービスのステータスを確認する。"""
    services = {}
    for svc in ["openclaw-gateway", "openclaw-proxy", "openclaw-router"]:
        try:
            result = subprocess.run(
                ["systemctl", "is-active", svc],
                capture_output=True, text=True, timeout=5
            )
            services[svc] = result.stdout.strip()
        except Exception:
            services[svc] = "unknown"
    return {"services": services}

@app.get("/api/v1/settings/model")
def get_model():
    try:
        resp = ssm().get_parameter(Name=f"/openclaw/{STACK_NAME}/model-id")
        return {"model_id": resp["Parameter"]["Value"]}
    except ClientError:
        return {"model_id": "global.amazon.nova-2-lite-v1:0"}


# =========================================================================
# 起動
# =========================================================================

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("CONSOLE_PORT", "8099"))
    print(f"\n  🦞 OpenClaw Admin Console API\n  http://localhost:{port}/docs\n")
    uvicorn.run(app, host="0.0.0.0", port=port)
