# packaging

Build, package, and deploy infrastructure for chan, one directory per concern. The public command surface is still the root `Makefile` (`make linux-deb`, `make chan-desktop`, `make gateway-build`, ...); these directories hold the scripts, manifests, and templates those targets drive. CI keys off the Makefile target names, not these paths.

| Path | Concern |
|---|---|
| `packaging/docker/` | OCI images for chan + the gateway services, plus `test/`. |
| `packaging/kube/` | Kubernetes manifests for the gateway stack, plus sdme. |
| `packaging/linux/` | CLI Linux artifacts: musl tarball, deb, rpm, Arch. |
| `packaging/freebsd/` | Static amd64 CLI tarball cross-built against a pinned FreeBSD sysroot. |
| `packaging/distros/` | Fedora COPR, Ubuntu Launchpad, and Arch AUR source packaging. |
| `packaging/desktop/` | macOS DMG packaging (`build-dmg.sh` + `dmg_settings.py`). |
| `packaging/sdme/` | chan-desktop Linux build images and the single-trust-domain chan-devserver image. |
| `packaging/gateway/` | Gateway packaging, scripts, dev stack, and sdme. |

The gateway Cargo workspace itself stays at `gateway/`; only its packaging and scripts live here under `packaging/gateway/`. Repo hooks and one-shot asset generators stay at `scripts/` (`install-hooks`, `pre-push`, `gen-app-icon.py`, `gen-nsis-images.py`). Per-crate cargo-deb / cargo-generate-rpm metadata stays in each crate's `Cargo.toml`.
