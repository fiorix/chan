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
%global upstream_version 0.93.0

Name:           chan
Version:        %(echo %{upstream_version} | tr - '~')
Release:        1%{?dist}
Summary:        Headless terminal multiplexer and workspace manager
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
chan is an IDE in a single binary: a terminal emulator and multiplexer
plus a workspace manager for directories on disk. It provides search,
terminals, a text editor, file browser, graph, and dashboard as tiling
tabs and panes.

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
* Tue Aug 18 2026 Alexandre Fiori <fiorix@gmail.com> - 0.93.0-1
- Update to 0.93.0.
* Mon Aug 17 2026 Alexandre Fiori <fiorix@gmail.com> - 0.92.0-1
- Update to 0.92.0.

* Sun Aug 16 2026 Alexandre Fiori <fiorix@gmail.com> - 0.91.0-1
- Update to 0.91.0.

* Fri Aug 14 2026 Alexandre Fiori <fiorix@gmail.com> - 0.90.0-1
- Update to 0.90.0.

* Wed Aug 12 2026 Alexandre Fiori <fiorix@gmail.com> - 0.89.0-1
- Update to 0.89.0.

* Mon Aug 10 2026 Alexandre Fiori <fiorix@gmail.com> - 0.88.0-1
- Update to 0.88.0.

* Sun Aug 09 2026 Alexandre Fiori <fiorix@gmail.com> - 0.87.0-1
- Update to 0.87.0.

* Sat Aug 08 2026 Alexandre Fiori <fiorix@gmail.com> - 0.86.0-1
- Update to 0.86.0.
* Thu Aug 06 2026 Alexandre Fiori <fiorix@gmail.com> - 0.85.0-1
- Update to 0.85.0.
* Wed Aug 05 2026 Alexandre Fiori <fiorix@gmail.com> - 0.84.1-1
- Update to 0.84.1.
* Wed Aug 05 2026 Alexandre Fiori <fiorix@gmail.com> - 0.84.0-1
- Update to 0.84.0.
* Tue Aug 04 2026 Alexandre Fiori <fiorix@gmail.com> - 0.83.4-1
- Update to 0.83.4.
* Mon Aug 03 2026 Alexandre Fiori <fiorix@gmail.com> - 0.83.3-1
- Update to 0.83.3.
* Mon Aug 03 2026 Alexandre Fiori <fiorix@gmail.com> - 0.83.1-1
- Update to 0.83.1.
* Mon Aug 03 2026 Alexandre Fiori <fiorix@gmail.com> - 0.83.0-1
- Update to 0.83.0.
* Sat Aug 01 2026 Alexandre Fiori <fiorix@gmail.com> - 0.82.0-1
- Update to 0.82.0.
* Wed Jul 29 2026 Alexandre Fiori <fiorix@gmail.com> - 0.80.0-1
- Update to 0.80.0.
* Tue Jul 28 2026 Alexandre Fiori <fiorix@gmail.com> - 0.79.2-1
- Update to 0.79.2.
* Mon Jul 27 2026 Alexandre Fiori <fiorix@gmail.com> - 0.79.1-1
- Update to 0.79.1.
* Sun Jul 26 2026 Alexandre Fiori <fiorix@gmail.com> - 0.79.0-1
- Update to 0.79.0.
* Sun Jul 26 2026 Alexandre Fiori <fiorix@gmail.com> - 0.78.0-1
- Update to 0.78.0.
* Sat Jul 25 2026 Alexandre Fiori <fiorix@gmail.com> - 0.77.0-1
- Update to 0.77.0.
* Sat Jul 25 2026 Alexandre Fiori <fiorix@gmail.com> - 0.76.1-1
- Update to 0.76.1.
* Sat Jul 25 2026 Alexandre Fiori <fiorix@gmail.com> - 0.76.0-1
- Update to 0.76.0.
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
