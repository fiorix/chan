# chan CLI / devserver image.
#
# Two stages: a builder that carries the Rust toolchain plus Node (the web
# bundles are baked into the binary by rust-embed at compile time) and a thin
# runtime that ships only the static-content-free binary and a CA bundle.
#
# Build context is the REPOSITORY ROOT (the build runs the project's own `make`
# targets, which need the full source tree):
#
#   docker build -f packaging/docker/chan.Dockerfile -t chan:dev .
#
# Optional embedded search model (~130 MB larger image; default off):
#
#   docker build -f packaging/docker/chan.Dockerfile --build-arg EMBED_MODEL=1 -t chan:model .
#
# Builder and runtime share the same Debian release (bookworm) so the binary's
# glibc requirement never exceeds the runtime's glibc (forward-incompat guard).

# ---- builder -------------------------------------------------------------
FROM node:20-bookworm AS builder

# build-essential + pkg-config for the cargo build; git/make/curl for the
# toolchain bootstrap and the Makefile. No GTK/webkit (this image is the
# headless CLI, not chan-desktop) and no libpq/libssl (chan is rustls + pure
# Rust on this path).
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential pkg-config curl ca-certificates git make && \
    rm -rf /var/lib/apt/lists/*

# Pinned compiler comes from rust-toolchain.toml (1.95.0); rustup installs it on
# the first cargo call. HOME is set so `~/.cargo` resolves under root.
ENV HOME=/root
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/root/.cargo/bin:$PATH

WORKDIR /src
COPY . .

# `make chan` builds web-launcher/dist + web/dist (npm) then
# `cargo build --release -p chan`, so rust-embed bakes the real bundles.
# EMBED_MODEL=1 switches to `make build-release` (fetches the model, builds
# with --features embed-model). Default leaves the model out for a small image.
ARG EMBED_MODEL=0
RUN if [ "$EMBED_MODEL" = "1" ]; then \
        make build-release; \
    else \
        make chan; \
    fi

# ---- runtime -------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# ca-certificates: chan-tunnel-client uses rustls-native-certs, so the outbound
# tunnel TLS dial (and self-update checks) need the system root store.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --create-home --uid 10001 --user-group chan

COPY --from=builder /src/target/release/chan /usr/local/bin/chan

USER chan
WORKDIR /home/chan

# Single-workspace serve over a mounted folder is the self-contained default:
#   docker run -p 8787:8787 -v "$PWD:/workspace" chan:dev
# The bearer-token gate stays on (the token is printed on stderr / persisted
# under the workspace data dir). For the gateway tunnel role, override the
# command, e.g.:
#   docker run -e CHAN_TUNNEL_TOKEN=chan_pat_... chan:dev \
#       devserver run --bind 0.0.0.0 --tunnel-url https://devserver.example.com/v1/tunnel
# The subcommands are `serve` (one workspace) and `devserver run` (many).
EXPOSE 8787
ENTRYPOINT ["chan"]
CMD ["serve", "/workspace", "--host", "0.0.0.0", "--port", "8787", "--no-browser", "--standalone", "--here"]
