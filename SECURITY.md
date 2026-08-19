# Security Policy

## Reporting a Vulnerability

If you believe you've found a security issue in chan, please report it privately. Do **not** open a public GitHub issue.

Email: **fiorix@gmail.com**

Please include:

* A description of the issue and its impact.
* Steps to reproduce, or a proof-of-concept where applicable.
* Affected versions / commit SHAs if known.
* Your suggested fix, if any.

## Response Process

* Acknowledgement: within 7 days of receipt.
* Triage and assessment: within 14 days.
* Coordinated disclosure window: up to 90 days from the initial report, depending on severity and complexity. Most issues are resolved well inside that window.

We will keep you informed of the progress toward a fix and the disclosure timeline. If a fix is released, we will credit you in the release notes unless you prefer to remain anonymous.

## Scope

The primary security boundary in chan is the `chan-workspace` crate, which sandboxes every user-content filesystem operation under the registered workspace root:

* Path traversal is rejected.
* Symbolic links pointing outside the workspace root are rejected.
* Non-regular files (FIFOs, sockets, devices, etc.) are refused.
* Writes are atomic via tempfile + rename.

Bugs that bypass this contract -- letting a caller read, write, or otherwise access files outside the registered workspace root -- are treated as high severity.

Other in-scope areas:

* The local HTTP server's per-launch bearer-token auth.
* Tunnel mode (`chan devserver run --tunnel-token ...`) and the `chan-tunnel-proto` wire format.
* The in-process MCP server exposed over a Unix-domain socket.
* The chan-desktop bundle's signing, notarization, and updater paths.

## Out of Scope

* Vulnerabilities in third-party dependencies should be reported upstream; we'll coordinate with the upstream maintainers when applicable.
* Issues that require local privileged access already equivalent to "the user can read and write the workspace themselves" are out of scope.
* Denial-of-service against a process the reporter already controls is out of scope.

## Supported Versions

The latest released version is supported. We may patch the previous minor version at our discretion for serious issues; older versions are not maintained.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |

Thank you for helping keep chan and its users safe.
