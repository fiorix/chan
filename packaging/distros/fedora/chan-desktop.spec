# Spec for chan-desktop, the Tauri desktop shell, built offline from the
# same vendored source tarball as the chan CLI (packaging/distros/mkdist).
# The build tooling rewrites %%upstream_version from the workspace
# Cargo.toml before rpmbuild, so the committed value is a fallback.
#
# The desktop binary IS the chan/cs command line (argv0 dispatch), so this
# package ships /usr/bin/{chan,cs} symlinks and conflicts with the chan
# package instead of depending on it.

%global debug_package %{nil}
%global upstream_version 0.85.0

Name:           chan-desktop
Version:        %(echo %{upstream_version} | tr - '~')
Release:        1%{?dist}
Summary:        Desktop edition of the chan AI-native IDE
License:        Apache-2.0
URL:            https://chan.app
Source0:        chan-vendored-%{upstream_version}.tar.xz
ExclusiveArch:  x86_64 aarch64

# EL9 has no webkit2gtk4.1-devel and no libsoup3-devel (EPEL Next 9 does
# not carry either), so the WebKitGTK shell cannot build there. The COPR
# chroot exclusion for this package lives only in the web console: it has
# no representation in this repository or in the COPR API, so it can lapse
# unnoticed and schedule EL9 builds. Fail at spec evaluation instead of
# minutes later inside dependency resolution.
%if 0%{?rhel} && 0%{?rhel} < 10
%{error:chan-desktop needs webkit2gtk4.1-devel and libsoup3-devel, which EL%{rhel} does not provide. Build on EL10 or newer, or on Fedora.}
%endif

BuildRequires:  rust >= 1.95
BuildRequires:  cargo
BuildRequires:  gcc
BuildRequires:  gcc-c++
BuildRequires:  pkgconf-pkg-config
BuildRequires:  webkit2gtk4.1-devel
BuildRequires:  gtk3-devel
BuildRequires:  libsoup3-devel
BuildRequires:  desktop-file-utils
BuildRequires:  systemd-rpm-macros

Requires:       systemd
# Both packages own %%{_bindir}/{chan,cs}; the desktop binary provides the
# full CLI in-process, so install one or the other.
Conflicts:      chan

%description
chan-desktop is the native desktop shell for chan, the AI-native IDE for
the modern engineer. It embeds the chan server and web app in a WebKitGTK
window and doubles as the chan/cs command line: invoked as chan or cs it
dispatches the CLI before any GUI init.

%prep
%autosetup -n chan-%{upstream_version}

%build
export CARGO_HOME="$PWD/.cargo-home"
export CHAN_PACKAGED=rpm
cargo build --release --frozen -p chan-desktop

%install
install -Dm755 target/release/chan-desktop %{buildroot}%{_bindir}/chan-desktop
ln -s chan-desktop %{buildroot}%{_bindir}/chan
ln -s chan-desktop %{buildroot}%{_bindir}/cs
install -Dm644 packaging/distros/shared/chan-desktop.desktop \
    %{buildroot}%{_datadir}/applications/chan-desktop.desktop
install -Dm644 desktop/src-tauri/icons/32x32.png \
    %{buildroot}%{_datadir}/icons/hicolor/32x32/apps/chan-desktop.png
install -Dm644 desktop/src-tauri/icons/64x64.png \
    %{buildroot}%{_datadir}/icons/hicolor/64x64/apps/chan-desktop.png
install -Dm644 desktop/src-tauri/icons/128x128.png \
    %{buildroot}%{_datadir}/icons/hicolor/128x128/apps/chan-desktop.png
install -Dm644 desktop/src-tauri/icons/128x128@2x.png \
    %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/chan-desktop.png
install -Dm644 desktop/src-tauri/icons/icon.png \
    %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/chan-desktop.png
install -Dm644 packaging/distros/shared/chan-devserver.service \
    %{buildroot}%{_userunitdir}/chan-devserver.service

%check
desktop-file-validate %{buildroot}%{_datadir}/applications/chan-desktop.desktop

%post
%systemd_user_post chan-devserver.service

%preun
%systemd_user_preun chan-devserver.service

%files
%license LICENSE
%doc README.md CHANGELOG.md
%{_bindir}/chan-desktop
%{_bindir}/chan
%{_bindir}/cs
%{_datadir}/applications/chan-desktop.desktop
%{_datadir}/icons/hicolor/*/apps/chan-desktop.png
%{_userunitdir}/chan-devserver.service

%changelog
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
