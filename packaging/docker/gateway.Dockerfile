# chan-gateway service images (identity, profile, devserver-proxy,
# devserver-control).
#
# One builder stage compiles all four binaries once (a shared cargo build);
# four thin runtime targets select one binary each. Build a specific service
# with --target; the builder layer is cached and reused across the four:
#
#   docker build -f packaging/docker/gateway.Dockerfile --target identity \
#       -t chan-gateway-identity:dev .
#   docker build -f packaging/docker/gateway.Dockerfile --target profile \
#       -t chan-gateway-profile:dev .
#   docker build -f packaging/docker/gateway.Dockerfile --target devserver-proxy \
#       -t chan-gateway-devserver-proxy:dev .
#   docker build -f packaging/docker/gateway.Dockerfile --target devserver-control \
#       -t chan-gateway-devserver-control:dev .
#
# Build context is the REPOSITORY ROOT. The gateway is a nested Cargo workspace
# under gateway/, so its build artifacts land in gateway/target.
#
# Config is injected as container ENV at runtime (the binaries read std::env,
# they do NOT source the systemd EnvironmentFile). No secrets are baked in; see
# gateway/crates/*/packaging/*.env for the full variable contract and packaging/kube/ for
# the Secret/ConfigMap wiring. Each image only sets BIND_ADDR to 0.0.0.0 so the
# service is reachable across pods (the default in the .env is 127.0.0.1).

# ---- builder -------------------------------------------------------------
FROM node:20-bookworm AS builder

# build-essential + pkg-config for cargo; nodejs/npm (from the base image) build
# the identity SPA that rust-embed bakes in. No libpq/libssl: the gateway is
# sqlx + rustls, pure Rust, no compile-time-checked queries (no DB at build).
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential pkg-config curl ca-certificates git make && \
    rm -rf /var/lib/apt/lists/*

ENV HOME=/root
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/root/.cargo/bin:$PATH

WORKDIR /src
COPY . .

# `make gateway-build` depends on `make gateway-spa` (npm build of the identity
# SPA, the rust-embed input) then builds the three release crates. The flags add
# --release; GATEWAY_RELEASE_CRATES in the Makefile fixes the -p set so a future
# crate rename does not silently drop a binary here.
RUN make gateway-build GATEWAY_CARGO_FLAGS="--release"

# ---- runtime base --------------------------------------------------------
# Shared by all four service targets: matched glibc (bookworm), a CA bundle
# (identity reaches the OAuth providers over HTTPS), and a non-root service user
# The image boundary isolates this per-container non-root identity; systemd
# packages use a distinct Unix identity for each service.
FROM debian:bookworm-slim AS runtime-base
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --create-home --uid 10001 --user-group chan-gateway
USER chan-gateway
WORKDIR /home/chan-gateway

# ---- identity (public :7000, internal proxy/operator :7004) ---------------
FROM runtime-base AS identity
COPY --from=builder /src/gateway/target/release/identity-service \
     /usr/local/bin/chan-gateway-identity
# Reachable across pods; the .env default is 127.0.0.1:7000.
ENV BIND_ADDR=0.0.0.0:7000
ENV INTERNAL_BIND_ADDR=0.0.0.0:7004
EXPOSE 7000 7004
ENTRYPOINT ["chan-gateway-identity"]

# ---- profile (internal API, :7001) ---------------------------------------
FROM runtime-base AS profile
COPY --from=builder /src/gateway/target/release/profile-service \
     /usr/local/bin/chan-gateway-profile
ENV BIND_ADDR=0.0.0.0:7001
EXPOSE 7001
ENTRYPOINT ["chan-gateway-profile"]

# ---- devserver-proxy ({proxy}.proxy.{domain}, :7002 + h2c tunnel :7100) -----
FROM runtime-base AS devserver-proxy
COPY --from=builder /src/gateway/target/release/devserver-proxy-service \
     /usr/local/bin/chan-gateway-devserver-proxy
ENV BIND_ADDR=0.0.0.0:7002
ENV TUNNEL_BIND_ADDR=0.0.0.0:7100
EXPOSE 7002
EXPOSE 7100
ENTRYPOINT ["chan-gateway-devserver-proxy"]

# ---- devserver-control (admin/health :7003 + h2c proxy control :7101) -----
FROM runtime-base AS devserver-control
COPY --from=builder /src/gateway/target/release/devserver-control-service \
     /usr/local/bin/chan-gateway-devserver-control
ENV BIND_ADDR=0.0.0.0:7003
ENV PROXY_BIND_ADDR=0.0.0.0:7101
EXPOSE 7003
EXPOSE 7101
ENTRYPOINT ["chan-gateway-devserver-control"]
