# kube

Kubernetes manifests for the chan-gateway stack, plus the local sdme validation path. Images come from `packaging/docker/` (see `packaging/docker/README.md`).

## Two shapes

- **Cluster manifests** (`config.yaml`, `secret.example.yaml`, `database-roles.yaml`, `database-prepare.yaml`, `migrate.yaml`, `database-reconcile.yaml`, `network-policy.yaml`, `postgres.yaml`, `profile.yaml`, `identity.yaml`, `devserver-proxy.yaml`, `devserver-control.yaml`): separate Deployments + Services plus three ordered database Jobs. Services reach each other by Service DNS name (`chan-gateway-profile:7001`, etc.). Identity deliberately has separate public `chan-gateway-identity:7000` and internal `chan-gateway-identity-internal:7004` Services. This is what you apply to a real cluster. The four service Deployments and owner-only migration Job pull the published images from Docker Hub as `fiorix/<service>:<version>`; `<version>` must be the immutable release tag being deployed.
- **sdme validation pod** (`sdme/gateway-pod.yaml`): the whole stack as ONE Pod. sdme runs a multi-container Pod as a single systemd-nspawn container sharing a network namespace via localhost, so there is no Service DNS; the manifest wires the inter-service URLs to `127.0.0.1`. This is a local functional-validation shape, not a production credential-isolation boundary. Do not treat its per-container Secret projections as protection from a sibling process inside the same nspawn container.

The service env-var contract is `gateway/crates/*/packaging/*.env` and `gateway/README.md`. The inter-service trust model (which token each service shares) is in `.agents/gateway.md` "Service-to-service bearers".

## Inter-service wiring

| Edge                                   | Variable                  | Carried by |
|----------------------------------------|---------------------------|------------|
| identity -> profile (service API)      | `PROFILE_AUTH_TOKEN`      | Secret     |
| identity -> profile (admin policy)     | `PROFILE_ADMIN_TOKEN`     | Secret     |
| proxy -> identity (PAT validate)       | `IDENTITY_INTERNAL_TOKEN` | Secret     |
| account -> identity (session lookup)   | `IDENTITY_SESSION_INTERNAL_TOKEN` | Secret |
| account -> identity (account composites) | `IDENTITY_ACCOUNT_ADMIN_TOKEN` | Secret |
| identity mint / proxy verify (entry)   | `DEVSERVER_ENTRY_*_KEY(S)` | Secrets   |
| identity -> control admission proof    | `DEVSERVER_ADMISSION_*_KEY` | Secrets  |
| operator / identity / profile -> control | scoped `DEVSERVER_*_ADMIN_TOKEN(S)` | Secrets |
| proxy -> control session               | `DEVSERVER_PROXY_TOKEN`   | Secret     |
| database Jobs -> Postgres owner        | `DATABASE_URL`            | Secret     |
| profile + identity -> Postgres app roles | distinct `DATABASE_URL`  | Secrets    |
| public origins (`BASE_URL`, `DEVSERVER_*`) | (see config.yaml)     | ConfigMap  |

`secret.example.yaml` defines one Secret per workload plus a root/operator-only CLI Secret. Shared values are duplicated only across their intended endpoints: identity and profile share `PROFILE_AUTH_TOKEN`; identity and proxy share only `IDENTITY_INTERNAL_TOKEN`; the account caller receives only `IDENTITY_SESSION_INTERNAL_TOKEN` and `IDENTITY_ACCOUNT_ADMIN_TOKEN`; identity holds private admission and entry signing keys while consumers receive only the matching public-key rings; control's three admin verifier rings are scope-specific and each caller receives only its singular current bearer; control's `DEVSERVER_PROXY_CREDENTIALS` contains the allowlisted token for each proxy id while each proxy receives only its own `DEVSERVER_PROXY_TOKEN`. Browser sessions are proxy-local opaque identifiers, so no session-signing secret crosses services. No identity or control bearer may be reused across scopes. The duplicated endpoint values MUST match or startup, handoff, or control authentication fails. identity refuses to start with no OAuth provider, so its Secret carries placeholder GitHub creds for boot.

Admission signing-key rotation is overlap-first: set control's `DEVSERVER_ADMISSION_VERIFYING_KEYS` to `old;new`, switch identity's signer and local verifier to `new`, wait at least 330 seconds (the maximum lease TTL plus clock skew) and confirm old leases have drained, then set control to `new` only. The ring accepts at most two distinct keys; never switch the signer before the new verifier is live.

The database owner URL exists only in `chan-gateway-migrate`. The prepare Job creates or rotates the `chan_gateway_identity` and `chan_gateway_profile` login roles, removes role membership and administrative attributes, revokes runtime access, and invalidates the rollout marker. The pinned identity migration Job then runs all DDL as the owner. Finally, the reconcile Job requires the exact successful sqlx migration and known table/sequence inventory, installs an explicit per-object ACL matrix with no positive default grants, keeps `_sqlx_migrations` owner-only, and publishes the app-readable migration/policy marker. The app Deployments receive only their own role URL, set `CHAN_GATEWAY_MIGRATIONS=external`, and wait for that exact marker.

## Cluster network contract

The services use HTTP and h2c inside the cluster. The cluster manifests are production-supported only when the pod network supplies authenticated encryption, such as a WireGuard-backed CNI or an equivalently authenticated encrypted overlay. Kubernetes NetworkPolicy constrains reachability but does not encrypt packets. `CHAN_GATEWAY_INTERNAL_TRANSPORT=protected-overlay` is the explicit deployment assertion that this protection exists; services refuse non-loopback plaintext internal URLs without that exact value. Do not set it on an ordinary plaintext pod network. Plaintext without an opt-in is supported only for the loopback-only systemd and sdme shapes.

`network-policy.yaml` applies default-deny ingress and egress plus the required service edges. Before applying it:

- Label the TLS ingress controller namespace and its pods with `networking.chan.app/edge=true`. Only those pods may reach identity's public `:7000` listener and proxy `:7002`/`:7100`. Edge-labeled pods cannot reach identity's internal `:7004` listener.
- If an in-cluster admin client is used, label its namespace and pod with `networking.chan.app/operator=true`. Only those two-sided labeled clients may reach identity internal `:7004`, profile `:7001`, and control admin `:7003` outside the application edges. Devserver-proxy also reaches identity `:7004` for token validation.
- Confirm the cluster DNS pods use `k8s-app=kube-dns` in the `kube-system` namespace, or adapt the DNS selectors before apply.
- Restrict who may set the edge and operator namespace labels through cluster RBAC or admission policy.

Identity may reach public IPv4 HTTPS for OAuth. Private, loopback, link-local, multicast, RFC 1918, and all IPv6 destinations remain denied. Use an egress gateway or CNI FQDN policy for provider-specific allowlisting where available; add a reviewed IPv6 egress rule if an OAuth provider cannot be reached over IPv4.

## Making the images available to sdme

`sdme kube` resolves a short `image:` name through `default_kube_registry` (default `docker.io`). Locally-built images are not in a registry, so make them reachable first. The registry-backed path:

```sh
# 1. Build + export the images (privileged build host; needs a container engine).
packaging/docker/build.sh -t dev

# 2. Run a registry sdme can reach, push the five images, point sdme at it:
#    sudo sdme config set default_kube_registry <registry-host>:5000
#    then docker push <registry-host>:5000/chan-gateway-identity:dev  (etc.)
```

> NOTE (unverified on this host): the exact bridge from a locally-built OCI image to `sdme kube apply` (local registry vs `sdme fs import --oci-mode app` vs the OCI blob cache) was not run here -- this host has no container engine and sdme needs root. Confirm the resolution path on the first privileged run and pin it in this section. This local-build path applies the sdme + test pods (`sdme/gateway-pod.yaml`, `test/upload-pod.yaml`), which stay on bare `:dev` image names + `imagePullPolicy: IfNotPresent`, so they are registry-agnostic; the four cluster service manifests instead pull `fiorix/<service>:<version>` from Docker Hub.

## D3: bring the stack up under sdme and prove it healthy

All `sdme` commands need root; `<base>` is a systemd-capable base rootfs (`sudo sdme fs import docker.io/ubuntu --name ubuntu --install-packages=yes`, or set `default_base_fs`).

```sh
# Secrets as an sdme kube secret (loopback DATABASE_URL for the single pod):
mapfile -t admission_keys < <(packaging/gateway/scripts/generate-admission-keypair.py)
admission_signing_key=${admission_keys[0]}
admission_verifying_key=${admission_keys[1]}
mapfile -t entry_keys < <(packaging/gateway/scripts/generate-admission-keypair.py)
entry_signing_key=${entry_keys[0]}
entry_verifying_key=${entry_keys[1]}
proxy_token=$(openssl rand -hex 32)
operator_token=$(openssl rand -hex 32)
identity_control_token=$(openssl rand -hex 32)
profile_control_token=$(openssl rand -hex 32)

sudo sdme kube secret create gateway-secrets \
    --from-literal=DATABASE_URL=postgres://chan:chan@127.0.0.1:5432/chan_gateway \
    --from-literal=POSTGRES_PASSWORD=chan \
    --from-literal=PROFILE_AUTH_TOKEN=$(openssl rand -hex 32) \
    --from-literal=PROFILE_ADMIN_TOKEN=$(openssl rand -hex 32) \
    --from-literal=IDENTITY_ADMIN_TOKEN=$(openssl rand -hex 32) \
    --from-literal=IDENTITY_INTERNAL_TOKEN=$(openssl rand -hex 32) \
    --from-literal=IDENTITY_SESSION_INTERNAL_TOKEN=$(openssl rand -hex 32) \
    --from-literal=IDENTITY_ACCOUNT_ADMIN_TOKEN=$(openssl rand -hex 32) \
    --from-literal=DEVSERVER_ADMISSION_SIGNING_KEY="$admission_signing_key" \
    --from-literal=DEVSERVER_ADMISSION_VERIFYING_KEYS="$admission_verifying_key" \
    --from-literal=DEVSERVER_ENTRY_SIGNING_KEY="$entry_signing_key" \
    --from-literal=DEVSERVER_ENTRY_VERIFYING_KEYS="$entry_verifying_key" \
    --from-literal=DEVSERVER_OPERATOR_ADMIN_TOKENS="$operator_token" \
    --from-literal=DEVSERVER_IDENTITY_ADMIN_TOKEN="$identity_control_token" \
    --from-literal=DEVSERVER_IDENTITY_ADMIN_TOKENS="$identity_control_token" \
    --from-literal=DEVSERVER_PROFILE_ADMIN_TOKEN="$profile_control_token" \
    --from-literal=DEVSERVER_PROFILE_ADMIN_TOKENS="$profile_control_token" \
    --from-literal=DEVSERVER_PROXY_CREDENTIALS="p1=$proxy_token" \
    --from-literal=DEVSERVER_PROXY_TOKEN="$proxy_token" \
    --from-literal=GITHUB_CLIENT_ID=dev-placeholder \
    --from-literal=GITHUB_CLIENT_SECRET=dev-placeholder

sudo sdme kube apply -f packaging/kube/sdme/gateway-pod.yaml --base-fs <base>

# Health: /healthz on each service, from inside the pod's shared netns.
# devserver-proxy (7002) gates health on the apex Host, so its probe
# sends the DEVSERVER_TUNNEL_ORIGIN host explicitly.
sudo sdme exec chan-gateway --oci -- sh -c '
  for p in 7000 7001 7003; do
    printf "port %s: " "$p"; curl -fsS "http://127.0.0.1:$p/healthz" && echo;
  done
  printf "port 7002: "; curl -fsS -H "Host: proxy.localtest.me" "http://127.0.0.1:7002/healthz" && echo;'

# Service-to-service proof: identity reaching profile is exercised by a sign-in;
# for a non-interactive check, confirm devserver-proxy validates against identity
# by watching logs while hitting the apex admin/healthz surface.
sudo sdme logs chan-gateway --oci

sudo sdme kube delete chan-gateway        # teardown
```

A healthy stack answers `ok` on all four public `/healthz` ports. The identity container first runs the same binary in `CHAN_GATEWAY_MIGRATIONS=only` mode, then execs the long-running `external` mode; profile never applies DDL.

## D4: headless-Chrome browser upload

Proves a browser is not subject to chan-desktop's Tauri upload ACL. See `test/upload-pod.yaml`.

```sh
sudo sdme kube apply -f packaging/kube/test/upload-pod.yaml --base-fs <base>
sudo sdme logs chan-upload-test --oci      # upload-tester prints PASS: ...
sudo sdme kube delete chan-upload-test
```

The `upload-tester` container drives a real headless Chromium that POSTs a file to `/api/fs/upload` from the chan page's origin, then stat's the landed file on the shared `/workspace` volume.

## Apply to a real cluster

```sh
cp packaging/kube/secret.example.yaml packaging/kube/secret.yaml   # replace every value; do not commit

# Pin the four service manifests and migration Job to the release you are deploying
# ('latest' for the newest GA -- see packaging/docker/README.md):
ver=0.55.0
sed -i "s|<version>|$ver|" packaging/kube/profile.yaml \
    packaging/kube/identity.yaml packaging/kube/devserver-proxy.yaml \
    packaging/kube/devserver-control.yaml packaging/kube/migrate.yaml

# 1. Start Postgres. NetworkPolicy already includes the narrowly scoped
# database-maintenance edge.
kubectl apply -f packaging/kube/config.yaml -f packaging/kube/secret.yaml \
    -f packaging/kube/database-roles.yaml \
    -f packaging/kube/network-policy.yaml -f packaging/kube/postgres.yaml
kubectl rollout status deployment/chan-gateway-postgres

# 2. Stop old DB clients before prepare revokes their ACLs. On a first install
# the Deployments do not exist, so the guarded scale is a no-op.
if kubectl get deployment chan-gateway-profile chan-gateway-identity >/dev/null 2>&1; then
    kubectl scale deployment/chan-gateway-profile deployment/chan-gateway-identity --replicas=0
fi

# 3. Job templates are immutable. Delete previous completed Jobs, then apply
# and wait each phase in order. Never apply all three Jobs concurrently.
kubectl delete job chan-gateway-database-prepare \
    chan-gateway-database-migrate chan-gateway-database-reconcile \
    --ignore-not-found
kubectl apply -f packaging/kube/database-prepare.yaml
kubectl wait --for=condition=complete --timeout=5m job/chan-gateway-database-prepare
kubectl apply -f packaging/kube/migrate.yaml
kubectl wait --for=condition=complete --timeout=5m job/chan-gateway-database-migrate
kubectl apply -f packaging/kube/database-reconcile.yaml
kubectl wait --for=condition=complete --timeout=5m job/chan-gateway-database-reconcile

# 4. Only now start app workloads. Their init containers independently require
# the exact EXPECTED_SQLX_MIGRATION and DATABASE_ROLE_POLICY_VERSION marker.
kubectl apply -f packaging/kube/profile.yaml -f packaging/kube/identity.yaml \
    -f packaging/kube/devserver-control.yaml -f packaging/kube/devserver-proxy.yaml
```

A TLS terminator fronts the public services: route the identity origin (`BASE_URL`) to `chan-gateway-identity:7000`, each proxy node origin (`DEVSERVER_PROXY_BASE_URL`) plus its wildcard to that node's `chan-gateway-devserver-proxy:7002`, and grpc/h2c-pass the tunnel register endpoint to `:7100`. Never route or publish `chan-gateway-identity-internal:7004`; only devserver-proxy and two-sided operator-labeled clients use it. The devserver-control ports (:7003 admin, :7101 proxy control) also stay internal. Keep `COOKIE_SECURE=true` and the public origins on `https`. The terminator and pod network requirements above are part of the supported deployment, not optional hardening.
