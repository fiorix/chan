#!/usr/bin/env python3
"""Validate the security boundaries encoded by the gateway manifests."""

from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import yaml


ROOT = Path(__file__).resolve().parents[2]
KUBE = ROOT / "packaging" / "kube"


def load_documents(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as stream:
        return [doc for doc in yaml.safe_load_all(stream) if doc]


def one(path: Path, kind: str) -> dict[str, Any]:
    matches = [doc for doc in load_documents(path) if doc.get("kind") == kind]
    assert len(matches) == 1, f"{path}: expected one {kind}, found {len(matches)}"
    return matches[0]


def projected_secrets(
    deployment: dict[str, Any], *, require_gateway_config: bool = True
) -> dict[str, tuple[str, str]]:
    pod = deployment["spec"]["template"]["spec"]
    assert pod.get("automountServiceAccountToken") is False
    container = pod["containers"][0]
    config_maps = {
        source["configMapRef"]["name"]
        for source in container.get("envFrom", [])
        if "configMapRef" in source
    }
    if require_gateway_config:
        assert config_maps == {"chan-gateway-config"}
    for source in container.get("envFrom", []):
        assert "secretRef" not in source, "whole-Secret envFrom is forbidden"
    result = {}
    for item in container.get("env", []):
        ref = item.get("valueFrom", {}).get("secretKeyRef")
        if ref:
            result[item["name"]] = (ref["name"], ref["key"])
    return result


def container_env(container: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["name"]: item for item in container.get("env", [])}


def secret_refs(container: dict[str, Any]) -> dict[str, tuple[str, str]]:
    result = {}
    for name, item in container_env(container).items():
        ref = item.get("valueFrom", {}).get("secretKeyRef")
        if ref:
            result[name] = (ref["name"], ref["key"])
    return result


expected = {
    "profile": {
        "DATABASE_URL",
        "PROFILE_AUTH_TOKEN",
        "PROFILE_ADMIN_TOKEN",
        "DEVSERVER_PROFILE_ADMIN_TOKEN",
    },
    "identity": {
        "DATABASE_URL",
        "PROFILE_AUTH_TOKEN",
        "PROFILE_ADMIN_TOKEN",
        "IDENTITY_INTERNAL_TOKEN",
        "DEVSERVER_ADMISSION_SIGNING_KEY",
        "DEVSERVER_ADMISSION_VERIFYING_KEYS",
        "DEVSERVER_ENTRY_SIGNING_KEY",
        "IDENTITY_ADMIN_TOKEN",
        "DEVSERVER_IDENTITY_ADMIN_TOKEN",
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
    },
    "devserver-control": {
        "DEVSERVER_OPERATOR_ADMIN_TOKENS",
        "DEVSERVER_IDENTITY_ADMIN_TOKENS",
        "DEVSERVER_PROFILE_ADMIN_TOKENS",
        "DEVSERVER_PROXY_CREDENTIALS",
        "DEVSERVER_ADMISSION_VERIFYING_KEYS",
    },
    "devserver-proxy": {
        "IDENTITY_INTERNAL_TOKEN",
        "DEVSERVER_ENTRY_VERIFYING_KEYS",
        "DEVSERVER_ADMISSION_VERIFYING_KEYS",
        "DEVSERVER_PROXY_TOKEN",
    },
}

for manifest_name in (
    "secret.example.yaml",
    "identity.yaml",
    "profile.yaml",
    "devserver-control.yaml",
    "devserver-proxy.yaml",
):
    manifest_text = (KUBE / manifest_name).read_text(encoding="utf-8")
    assert "DEVSERVER_ADMIN_TOKEN" not in manifest_text
    assert "CHAN_ADMIN_TOKEN" not in manifest_text

for workload, keys in expected.items():
    deployment = one(KUBE / f"{workload}.yaml", "Deployment")
    refs = projected_secrets(deployment)
    assert set(refs) == keys, f"{workload}: unexpected projected keys {set(refs) ^ keys}"
    for variable, (secret, key) in refs.items():
        assert secret == f"chan-gateway-{workload}", f"{workload}: {variable} uses {secret}"
        assert variable == key, f"{workload}: {variable} projects key {key}"

    if workload in {"identity", "profile"}:
        pod = deployment["spec"]["template"]["spec"]
        app_env = container_env(pod["containers"][0])
        assert app_env["CHAN_GATEWAY_MIGRATIONS"]["value"] == "external"
        assert len(pod.get("initContainers", [])) == 1
        wait_refs = secret_refs(pod["initContainers"][0])
        assert wait_refs == {
            "DATABASE_URL": (f"chan-gateway-{workload}", "DATABASE_URL")
        }
        assert "chan-gateway-migrate" not in str(deployment), (
            f"{workload}: database-owner Secret leaked into app workload"
        )
        wait_env = container_env(pod["initContainers"][0])
        for variable in ("EXPECTED_SQLX_MIGRATION", "DATABASE_ROLE_POLICY_VERSION"):
            assert wait_env[variable]["valueFrom"]["configMapKeyRef"] == {
                "name": "chan-gateway-config",
                "key": variable,
            }
        wait_command = "\n".join(pod["initContainers"][0]["command"])
        assert "chan_gateway_deployment_state" in wait_command
        assert "to_regclass" not in wait_command

identity_deployment = one(KUBE / "identity.yaml", "Deployment")
identity_container = identity_deployment["spec"]["template"]["spec"]["containers"][0]
identity_env = container_env(identity_container)
assert identity_env["INTERNAL_BIND_ADDR"]["value"] == "0.0.0.0:7004"
assert {
    port["name"]: port["containerPort"] for port in identity_container["ports"]
} == {"public": 7000, "internal": 7004}

identity_services = {
    document["metadata"]["name"]: document
    for document in load_documents(KUBE / "identity.yaml")
    if document["kind"] == "Service"
}
assert set(identity_services) == {
    "chan-gateway-identity",
    "chan-gateway-identity-internal",
}
assert identity_services["chan-gateway-identity"]["spec"]["ports"] == [
    {"name": "public", "port": 7000, "targetPort": 7000}
]
assert identity_services["chan-gateway-identity-internal"]["spec"]["ports"] == [
    {"name": "internal", "port": 7004, "targetPort": 7004}
]

postgres_refs = projected_secrets(
    one(KUBE / "postgres.yaml", "Deployment"), require_gateway_config=False
)
assert postgres_refs == {
    "POSTGRES_PASSWORD": ("chan-gateway-postgres", "POSTGRES_PASSWORD"),
}

postgres = one(KUBE / "postgres.yaml", "Deployment")["spec"]["template"]["spec"]
assert {volume["name"] for volume in postgres.get("volumes", [])} == {"data"}, (
    "Postgres must not receive app-role scripts or secrets"
)

secret_docs = {
    doc["metadata"]["name"]: set(doc.get("stringData", {}))
    for doc in load_documents(KUBE / "secret.example.yaml")
}
expected_secrets = {f"chan-gateway-{name}": keys for name, keys in expected.items()}
expected_secrets["chan-gateway-postgres"] = {"POSTGRES_PASSWORD"}
expected_secrets["chan-gateway-migrate"] = {
    "DATABASE_URL",
    "IDENTITY_DATABASE_PASSWORD",
    "PROFILE_DATABASE_PASSWORD",
}
expected_secrets["chan-gateway-operator"] = {
    "CHAN_ADMIN_PROFILE_TOKEN",
    "CHAN_ADMIN_IDENTITY_TOKEN",
    "CHAN_ADMIN_OPERATOR_TOKEN",
}
assert secret_docs == expected_secrets

secret_data = {
    doc["metadata"]["name"]: doc.get("stringData", {})
    for doc in load_documents(KUBE / "secret.example.yaml")
}
assert urlsplit(secret_data["chan-gateway-migrate"]["DATABASE_URL"]).username == (
    "chan_gateway_migrate"
)
assert urlsplit(secret_data["chan-gateway-identity"]["DATABASE_URL"]).username == (
    "chan_gateway_identity"
)
assert urlsplit(secret_data["chan-gateway-profile"]["DATABASE_URL"]).username == (
    "chan_gateway_profile"
)

control_secret = secret_data["chan-gateway-devserver-control"]
admission_ring = control_secret["DEVSERVER_ADMISSION_VERIFYING_KEYS"].split(";")
assert 1 <= len(admission_ring) <= 2
assert len(admission_ring) == len(set(admission_ring))
assert secret_data["chan-gateway-identity"]["DEVSERVER_ADMISSION_VERIFYING_KEYS"].split(
    ";"
) == admission_ring
control_rings = {
    scope: control_secret[f"DEVSERVER_{scope}_ADMIN_TOKENS"].split(";")
    for scope in ("OPERATOR", "IDENTITY", "PROFILE")
}
assert all(1 <= len(ring) <= 2 and len(ring) == len(set(ring)) for ring in control_rings.values())
assert len({token for ring in control_rings.values() for token in ring}) == sum(
    len(ring) for ring in control_rings.values()
)
assert secret_data["chan-gateway-identity"]["DEVSERVER_IDENTITY_ADMIN_TOKEN"] in control_rings[
    "IDENTITY"
]
assert secret_data["chan-gateway-profile"]["DEVSERVER_PROFILE_ADMIN_TOKEN"] in control_rings[
    "PROFILE"
]
operator_secret = secret_data["chan-gateway-operator"]
assert operator_secret["CHAN_ADMIN_OPERATOR_TOKEN"] in control_rings["OPERATOR"]
assert operator_secret["CHAN_ADMIN_PROFILE_TOKEN"] == secret_data["chan-gateway-profile"][
    "PROFILE_ADMIN_TOKEN"
]
assert operator_secret["CHAN_ADMIN_IDENTITY_TOKEN"] == secret_data["chan-gateway-identity"][
    "IDENTITY_ADMIN_TOKEN"
]

migration_jobs = {
    job["metadata"]["name"]: job
    for job in (
        one(KUBE / "database-prepare.yaml", "Job"),
        one(KUBE / "migrate.yaml", "Job"),
        one(KUBE / "database-reconcile.yaml", "Job"),
    )
}
assert set(migration_jobs) == {
    "chan-gateway-database-prepare",
    "chan-gateway-database-migrate",
    "chan-gateway-database-reconcile",
}
for job in migration_jobs.values():
    pod = job["spec"]["template"]["spec"]
    assert pod["automountServiceAccountToken"] is False
    assert pod["restartPolicy"] == "OnFailure"

prepare_container = migration_jobs["chan-gateway-database-prepare"]["spec"]["template"][
    "spec"
]["containers"][0]
assert secret_refs(prepare_container) == {
    "DATABASE_URL": ("chan-gateway-migrate", "DATABASE_URL"),
    "IDENTITY_DATABASE_PASSWORD": (
        "chan-gateway-migrate",
        "IDENTITY_DATABASE_PASSWORD",
    ),
    "PROFILE_DATABASE_PASSWORD": (
        "chan-gateway-migrate",
        "PROFILE_DATABASE_PASSWORD",
    ),
}
migration_container = migration_jobs["chan-gateway-database-migrate"]["spec"]["template"][
    "spec"
]["containers"][0]
migration_main_env = container_env(migration_container)
assert secret_refs(migration_container) == {
    "DATABASE_URL": ("chan-gateway-migrate", "DATABASE_URL")
}
assert migration_main_env["CHAN_GATEWAY_MIGRATIONS"]["value"] == "only"
assert set(migration_main_env) == {"DATABASE_URL", "CHAN_GATEWAY_MIGRATIONS"}

reconcile_container = migration_jobs["chan-gateway-database-reconcile"]["spec"][
    "template"
]["spec"]["containers"][0]
assert secret_refs(reconcile_container) == {
    "DATABASE_URL": ("chan-gateway-migrate", "DATABASE_URL")
}
reconcile_env = container_env(reconcile_container)
for variable in ("EXPECTED_SQLX_MIGRATION", "DATABASE_ROLE_POLICY_VERSION"):
    assert reconcile_env[variable]["valueFrom"]["configMapKeyRef"] == {
        "name": "chan-gateway-config",
        "key": variable,
    }

roles_config = one(KUBE / "database-roles.yaml", "ConfigMap")
for script_name in ("prepare-database-roles.sh", "reconcile-database-roles.sh"):
    script = (
        ROOT / "packaging" / "gateway" / "scripts" / script_name
    ).read_text(encoding="utf-8")
    assert roles_config["data"][script_name] == script

config = one(KUBE / "config.yaml", "ConfigMap")["data"]
assert int(config["MAX_DEVSERVERS_PER_USER"]) > 0
assert config["COOKIE_SECURE"] == "true"
assert config["CHAN_GATEWAY_INTERNAL_TRANSPORT"] == "protected-overlay"
assert config["IDENTITY_URL"] == "http://chan-gateway-identity-internal:7004"
assert config["IDENTITY_PUBLIC_ORIGIN"] == config["BASE_URL"]
assert config["POSTGRES_USER"] == "chan_gateway_migrate"
latest_migration = max(
    int(path.name.split("_", 1)[0]) for path in (ROOT / "gateway" / "migrations").glob("*.sql")
)
assert int(config["EXPECTED_SQLX_MIGRATION"]) == latest_migration
assert int(config["DATABASE_ROLE_POLICY_VERSION"]) > 0
for name in (
    "BASE_URL",
    "DEVSERVER_PROXY_ORIGIN",
    "DEVSERVER_TUNNEL_ORIGIN",
    "DEVSERVER_PROXY_BASE_URL",
    "DASHBOARD_URL",
):
    assert config[name].startswith("https://"), f"{name} must be an HTTPS origin"

policies = {
    doc["metadata"]["name"]: doc["spec"]
    for doc in load_documents(KUBE / "network-policy.yaml")
}
assert set(policies) == {
    "chan-gateway-default-deny",
    "chan-gateway-identity",
    "chan-gateway-profile",
    "chan-gateway-devserver-control",
    "chan-gateway-devserver-proxy",
    "chan-gateway-postgres",
    "chan-gateway-database-migrate",
}
default_deny = policies["chan-gateway-default-deny"]
assert default_deny["policyTypes"] == ["Ingress", "Egress"]
assert "ingress" not in default_deny and "egress" not in default_deny

expected_ports = {
    "chan-gateway-identity": ({7000, 7004}, {53, 443, 5432, 7001, 7003}),
    "chan-gateway-profile": ({7001}, {53, 5432, 7003}),
    "chan-gateway-devserver-control": ({7003, 7101}, set()),
    "chan-gateway-devserver-proxy": ({7002, 7100}, {53, 7004, 7101}),
    "chan-gateway-postgres": ({5432}, set()),
    "chan-gateway-database-migrate": (set(), {53, 5432}),
}
for name, (ingress_ports, egress_ports) in expected_ports.items():
    policy = policies[name]
    assert set(policy["policyTypes"]) == {"Ingress", "Egress"}
    actual_ingress = {
        port["port"] for rule in policy.get("ingress", []) for port in rule.get("ports", [])
    }
    actual_egress = {
        port["port"] for rule in policy.get("egress", []) for port in rule.get("ports", [])
    }
    assert actual_ingress == ingress_ports, f"{name}: ingress ports {actual_ingress}"
    assert actual_egress == egress_ports, f"{name}: egress ports {actual_egress}"

identity_ingress = policies["chan-gateway-identity"]["ingress"]
public_rule = next(
    rule for rule in identity_ingress if {port["port"] for port in rule["ports"]} == {7000}
)
assert public_rule["from"] == [
    {
        "namespaceSelector": {
            "matchLabels": {"networking.chan.app/edge": "true"}
        },
        "podSelector": {"matchLabels": {"networking.chan.app/edge": "true"}},
    }
]
internal_rule = next(
    rule for rule in identity_ingress if {port["port"] for port in rule["ports"]} == {7004}
)
assert internal_rule["from"] == [
    {"podSelector": {"matchLabels": {"app.kubernetes.io/name": "devserver-proxy"}}},
    {
        "namespaceSelector": {
            "matchLabels": {"networking.chan.app/operator": "true"}
        },
        "podSelector": {
            "matchLabels": {"networking.chan.app/operator": "true"}
        },
    },
]
assert all(
    source.get("namespaceSelector", {}).get("matchLabels", {}).get(
        "networking.chan.app/edge"
    )
    is None
    for source in internal_rule["from"]
)

sdme = one(KUBE / "sdme" / "gateway-pod.yaml", "Pod")["spec"]
assert sdme.get("automountServiceAccountToken") is False
for container in sdme["containers"]:
    for source in container.get("envFrom", []):
        assert "secretRef" not in source, f"sdme {container['name']} imports the whole Secret"
control = next(container for container in sdme["containers"] if container["name"] == "devserver-control")
cap = next(item["value"] for item in control["env"] if item["name"] == "MAX_DEVSERVERS_PER_USER")
assert int(cap) > 0
sdme_containers = {container["name"]: container for container in sdme["containers"]}
for workload in ("profile", "identity"):
    assert container_env(sdme_containers[workload])["CHAN_GATEWAY_MIGRATIONS"]["value"] == (
        "external"
    )
sdme_identity = sdme_containers["identity"]
assert container_env(sdme_identity)["INTERNAL_BIND_ADDR"]["value"] == "127.0.0.1:7004"
assert "CHAN_GATEWAY_MIGRATIONS=only /usr/local/bin/chan-gateway-identity" in "\n".join(
    sdme_identity["args"]
)
assert container_env(sdme_containers["devserver-proxy"])["IDENTITY_URL"]["value"] == (
    "http://127.0.0.1:7004"
)
for workload in ("profile", "identity", "devserver-control", "devserver-proxy"):
    assert container_env(sdme_containers[workload])["BIND_ADDR"]["value"].startswith(
        "127.0.0.1:"
    )

readme = (KUBE / "README.md").read_text(encoding="utf-8")
assert "pod network supplies authenticated encryption" in readme
assert "CHAN_GATEWAY_INTERNAL_TRANSPORT=protected-overlay" in readme
assert "networking.chan.app/edge=true" in readme
assert "networking.chan.app/operator=true" in readme
assert "CHAN_GATEWAY_MIGRATIONS=external" in readme
assert "kubectl wait --for=condition=complete" in readme

print("PASS: Kubernetes secret, database-role, network, and transport contracts")
