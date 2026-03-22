"""
OpenClaw マルチテナントプラットフォーム向けエンタープライズスキルローダー。

テナントのパーミッションに基づいて S3 からスキルを読み込み、
SSM パラメータストアの API キーを環境変数として注入する。

3層スキルアーキテクチャ (OpenClaw にゼロ侵食):
  レイヤー1: ビルトインスキル (Docker イメージ、常に利用可能)
  レイヤー2: S3 ホットロードスキル (スクリプト、microVM 起動時に読み込む)
  レイヤー3: ビルド済みスキルバンドル (S3 の tar.gz、起動時に読み込む)

使用方法:
  python skill_loader.py --tenant TENANT_ID --workspace /tmp/workspace \
    --bucket openclaw-tenants-xxx --stack openclaw-multitenancy --region us-east-1

出力:
  - スキルが {workspace}/skills/ にコピーされる
  - API キー注入用の export KEY=VALUE 行を含む /tmp/skill_env.sh
"""

import argparse
import json
import logging
import os
import subprocess
import sys

import boto3
from botocore.exceptions import ClientError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def get_tenant_roles(ssm, stack_name, tenant_id):
    """SSM パーミッションプロファイルからテナントのロールリストを読み込む。"""
    try:
        resp = ssm.get_parameter(
            Name=f"/openclaw/{stack_name}/tenants/{tenant_id}/roles"
        )
        roles = [r.strip() for r in resp["Parameter"]["Value"].split(",")]
        logger.info("Tenant %s roles: %s", tenant_id, roles)
        return roles
    except ClientError:
        logger.info("No roles found for tenant %s, using default: [employee]", tenant_id)
        return ["employee"]


def load_skill_manifest(skill_dir):
    """スキルディレクトリから skill.json マニフェストを読み込む。"""
    manifest_path = os.path.join(skill_dir, "skill.json")
    if not os.path.isfile(manifest_path):
        return None
    try:
        with open(manifest_path) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logger.warning("Failed to read manifest %s: %s", manifest_path, e)
        return None


def is_skill_allowed(manifest, tenant_roles):
    """ロールパーミッションに基づいてテナントにスキルが許可されているか確認する。"""
    if not manifest:
        return True  # マニフェストなし = 制限なし (後方互換性)

    permissions = manifest.get("permissions", {})
    allowed_roles = permissions.get("allowedRoles", ["*"])
    blocked_roles = permissions.get("blockedRoles", [])

    # まずブロックを確認
    for role in tenant_roles:
        if role in blocked_roles:
            logger.info("Skill %s blocked for role %s", manifest.get("name"), role)
            return False

    # 次に許可を確認
    if "*" in allowed_roles:
        return True
    for role in tenant_roles:
        if role in allowed_roles:
            return True

    logger.info("Skill %s not in allowedRoles for %s", manifest.get("name"), tenant_roles)
    return False


def load_layer2_skills(s3, bucket, stack_name, tenant_id, tenant_roles, workspace):
    """S3 からレイヤー2スキルを読み込む (スクリプトレベル、npm 依存なし)。"""
    skills_dir = os.path.join(workspace, "skills")
    os.makedirs(skills_dir, exist_ok=True)
    loaded = []

    # 1. 共有スキルを取得
    shared_prefix = "_shared/skills/"
    try:
        result = subprocess.run(
            ["aws", "s3", "sync",
             f"s3://{bucket}/{shared_prefix}", f"{skills_dir}/_shared_tmp/",
             "--quiet"],
            capture_output=True, text=True, timeout=30
        )
    except Exception as e:
        logger.warning("Failed to sync shared skills: %s", e)
        return loaded

    # 2. パーミッションでフィルタしてスキルディレクトリに移動
    shared_tmp = os.path.join(skills_dir, "_shared_tmp")
    if os.path.isdir(shared_tmp):
        for skill_name in os.listdir(shared_tmp):
            skill_path = os.path.join(shared_tmp, skill_name)
            if not os.path.isdir(skill_path):
                continue
            manifest = load_skill_manifest(skill_path)
            if is_skill_allowed(manifest, tenant_roles):
                dest = os.path.join(skills_dir, skill_name)
                if not os.path.exists(dest):
                    os.rename(skill_path, dest)
                    loaded.append(skill_name)
                    logger.info("Layer 2 skill loaded: %s", skill_name)
            else:
                logger.info("Layer 2 skill filtered: %s", skill_name)
        # 一時ファイルを削除
        subprocess.run(["rm", "-rf", shared_tmp], capture_output=True)

    # 3. テナント固有のスキルを取得
    tenant_prefix = f"{tenant_id}/skills/"
    try:
        subprocess.run(
            ["aws", "s3", "sync",
             f"s3://{bucket}/{tenant_prefix}", f"{skills_dir}/",
             "--quiet"],
            capture_output=True, text=True, timeout=30
        )
    except Exception as e:
        logger.warning("Failed to sync tenant skills: %s", e)

    return loaded


def load_layer3_bundles(s3_client, ssm, bucket, stack_name, workspace):
    """S3 からレイヤー3のビルド済みスキルバンドルを読み込む。"""
    skills_dir = os.path.join(workspace, "skills")
    os.makedirs(skills_dir, exist_ok=True)
    loaded = []

    # SSM からスキルカタログを読み込む
    catalog_path = f"/openclaw/{stack_name}/skill-catalog/"
    try:
        resp = ssm.get_parameters_by_path(Path=catalog_path, Recursive=False)
        params = resp.get("Parameters", [])
    except ClientError:
        logger.info("No skill catalog found at %s", catalog_path)
        return loaded

    for param in params:
        skill_name = param["Name"].split("/")[-1]
        version = param["Value"]
        bundle_key = f"_shared/skill-bundles/skill-{skill_name}-{version}.tar.gz"

        local_tar = f"/tmp/skill-{skill_name}.tar.gz"
        try:
            s3_client.download_file(bucket, bundle_key, local_tar)
            subprocess.run(
                ["tar", "xzf", local_tar, "-C", skills_dir],
                capture_output=True, text=True, timeout=30, check=True
            )
            os.remove(local_tar)
            loaded.append(f"{skill_name}@{version}")
            logger.info("Layer 3 bundle loaded: %s@%s", skill_name, version)
        except ClientError:
            logger.warning("Bundle not found in S3: %s", bundle_key)
        except subprocess.CalledProcessError as e:
            logger.warning("Failed to extract bundle %s: %s", skill_name, e)
        except Exception as e:
            logger.warning("Failed to load bundle %s: %s", skill_name, e)

    return loaded


def inject_skill_keys(ssm, stack_name, workspace, env_file="/tmp/skill_env.sh"):
    """SSM から API キーを読み込み、env ファイルに export 文を書き込む。"""
    skills_dir = os.path.join(workspace, "skills")
    env_lines = []
    injected = []

    # 読み込まれたすべてのスキルのマニフェストをスキャン
    if not os.path.isdir(skills_dir):
        return injected

    for skill_name in os.listdir(skills_dir):
        skill_path = os.path.join(skills_dir, skill_name)
        if not os.path.isdir(skill_path):
            continue
        manifest = load_skill_manifest(skill_path)
        if not manifest:
            continue

        required_env = manifest.get("requires", {}).get("env", [])
        if not required_env:
            continue

        # 各必須環境変数を SSM から読み込む
        for env_var in required_env:
            ssm_path = f"/openclaw/{stack_name}/skill-keys/{skill_name}/{env_var}"
            try:
                resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
                value = resp["Parameter"]["Value"]
                # シェル安全性のために値のシングルクォートをエスケープ
                safe_value = value.replace("'", "'\\''")
                env_lines.append(f"export {env_var}='{safe_value}'")
                injected.append(f"{skill_name}/{env_var}")
                logger.info("Injected key: %s/%s", skill_name, env_var)
            except ClientError:
                logger.warning("Key not found in SSM: %s", ssm_path)

    # グローバルスキルキーも読み込む (特定のスキルに紐付かないもの)
    global_path = f"/openclaw/{stack_name}/skill-keys/_global/"
    try:
        resp = ssm.get_parameters_by_path(
            Path=global_path, Recursive=False, WithDecryption=True
        )
        for param in resp.get("Parameters", []):
            env_var = param["Name"].split("/")[-1]
            value = param["Value"]
            safe_value = value.replace("'", "'\\''")
            env_lines.append(f"export {env_var}='{safe_value}'")
            injected.append(f"_global/{env_var}")
            logger.info("Injected global key: %s", env_var)
    except ClientError:
        pass  # グローバルキーが設定されていない

    # env ファイルを書き込む
    with open(env_file, "w") as f:
        f.write("#!/bin/sh\n")
        f.write("# skill_loader.py により自動生成 — 編集しないこと\n")
        for line in env_lines:
            f.write(line + "\n")

    logger.info("Wrote %d env vars to %s", len(env_lines), env_file)
    return injected


def main():
    parser = argparse.ArgumentParser(description="Enterprise Skill Loader")
    parser.add_argument("--tenant", required=True, help="Tenant ID")
    parser.add_argument("--workspace", required=True, help="Workspace directory")
    parser.add_argument("--bucket", required=True, help="S3 bucket name")
    parser.add_argument("--stack", required=True, help="Stack name")
    parser.add_argument("--region", default="us-east-1", help="AWS region")
    args = parser.parse_args()

    ssm = boto3.client("ssm", region_name=args.region)
    s3 = boto3.client("s3", region_name=args.region)

    logger.info("=== Skill Loader START tenant=%s ===", args.tenant)

    # パーミッションフィルタリング用のテナントロールを取得
    roles = get_tenant_roles(ssm, args.stack, args.tenant)

    # レイヤー2: S3 ホットロードスキル
    l2 = load_layer2_skills(s3, args.bucket, args.stack, args.tenant, roles, args.workspace)
    logger.info("Layer 2 loaded: %s", l2 if l2 else "none")

    # レイヤー3: ビルド済みスキルバンドル
    l3 = load_layer3_bundles(s3, ssm, args.bucket, args.stack, args.workspace)
    logger.info("Layer 3 loaded: %s", l3 if l3 else "none")

    # SSM から API キーを注入
    keys = inject_skill_keys(ssm, args.stack, args.workspace)
    logger.info("Keys injected: %d", len(keys))

    # サマリー
    skills_dir = os.path.join(args.workspace, "skills")
    total = 0
    if os.path.isdir(skills_dir):
        total = len([d for d in os.listdir(skills_dir) if os.path.isdir(os.path.join(skills_dir, d))])
    logger.info("=== Skill Loader DONE: %d skills available ===", total)


if __name__ == "__main__":
    main()
