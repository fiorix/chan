# Spec for the standalone chan CLI + devserver, built offline from the
# vendored source tarball (packaging/distros/mkdist). The build tooling
# (.copr/Makefile, copr/build-srpm.sh) rewrites %%upstream_version below from
# the workspace Cargo.toml before rpmbuild, so the committed value is a
# fallback, not a pin to maintain.

# The release profile already strips symbols (workspace [profile.release]
# strip); there is no debuginfo to extract.
%global debug_package %{nil}

# Upstream semver may carry a -rcN prerelease; RPM's Version grammar
# reserves '-', so it maps to '~' (which sorts before the final release).
%global upstream_version 0.75.0

Name:           chan
Version:        %(echo %{upstream_version} | tr - '~')
Release:        1%{?dist}
Summary:        AI-native IDE for the modern engineer
License:        Apache-2.0
URL:            https://chan.app
Source0:        chan-vendored-%{upstream_version}.tar.xz
ExclusiveArch:  x86_64 aarch64

# Cargo resolves offline through the in-tarball .cargo/config.toml ->
# vendor/ redirect; the web bundles are prebuilt in the tarball, so no
# nodejs at build time. gcc/gcc-c++ compile the bundled C bits (ring,
# SQLite amalgamation, zstd).
BuildRequires:  rust >= 1.95
BuildRequires:  cargo
BuildRequires:  gcc
BuildRequires:  gcc-c++
BuildRequires:  systemd-rpm-macros

# The devserver's service mode (`chan devserver --service=systemd`) drives
# systemctl/loginctl; the binary itself needs only glibc.
Requires:       systemd

%description
chan is an AI-native IDE for the modern engineer: a CLI plus an HTTP
server that serves a hybrid editor, terminal, file browser, and graph
over a folder on disk. Cross-file [[wiki-link]] autocomplete, BM25
content search, and an MCP server for agents included.

%prep
%autosetup -n chan-%{upstream_version}

%build
export CARGO_HOME="$PWD/.cargo-home"
export CHAN_PACKAGED=rpm
cargo build --release --frozen -p chan

%install
install -Dm755 target/release/chan %{buildroot}%{_bindir}/chan
# The binary dispatches the `cs` CLI when invoked through a cs name (argv0).
ln -s chan %{buildroot}%{_bindir}/cs
install -Dm644 packaging/distros/shared/chan-devserver.service \
    %{buildroot}%{_userunitdir}/chan-devserver.service

%post
%systemd_user_post chan-devserver.service

%preun
%systemd_user_preun chan-devserver.service

%files
%license LICENSE
%doc README.md CHANGELOG.md
%{_bindir}/chan
%{_bindir}/cs
%{_userunitdir}/chan-devserver.service

%changelog
* Fri Jul 24 2026 Alexandre Fiori <fiorix@gmail.com> - 0.75.0-1
- Update to 0.75.0.
* Wed Jul 22 2026 Alexandre Fiori <fiorix@gmail.com> - 0.74.0-1
- Update to 0.74.0.
* Mon Jul 20 2026 Alexandre Fiori <fiorix@gmail.com> - 0.73.0-1
- Update to 0.73.0.
* Mon Jul 20 2026 Alexandre Fiori <fiorix@gmail.com> - 0.72.0-1
- Update to 0.72.0.
* Sun Jul 19 2026 Alexandre Fiori <fiorix@gmail.com> - 0.71.0-1
- Update to 0.71.0.
* Sat Jul 18 2026 Alexandre Fiori <fiorix@gmail.com> - 0.70.3-1
- Update to 0.70.3.
* Sat Jul 18 2026 Alexandre Fiori <fiorix@gmail.com> - 0.70.2-1
- Update to 0.70.2.
* Fri Jul 17 2026 Alexandre Fiori <fiorix@gmail.com> - 0.70.1-1
- Update to 0.70.1.
* Fri Jul 17 2026 Alexandre Fiori <fiorix@gmail.com> - 0.70.0-1
- Update to 0.70.0.
* Thu Jul 16 2026 Alexandre Fiori <fiorix@gmail.com> - 0.69.1-1
- Update to 0.69.1.
* Wed Jul 15 2026 Alexandre Fiori <fiorix@gmail.com> - 0.69.0-1
- Update to 0.69.0.
* Wed Jul 15 2026 Alexandre Fiori <fiorix@gmail.com> - 0.68.0-1
- Update to 0.68.0.
* Mon Jul 13 2026 Alexandre Fiori <fiorix@gmail.com> - 0.67.3-1
- Update to 0.67.3.
* Sun Jul 12 2026 Alexandre Fiori <fiorix@gmail.com> - 0.67.2-1
- Update to 0.67.2.
* Sun Jul 12 2026 Alexandre Fiori <fiorix@gmail.com> - 0.67.1-1
- Update to 0.67.1.
* Sat Jul 11 2026 Alexandre Fiori <fiorix@gmail.com> - 0.67.0-1
- Update to 0.67.0.
* Fri Jul 10 2026 Alexandre Fiori <fiorix@gmail.com> - 0.66.1-1
- Initial COPR packaging.
