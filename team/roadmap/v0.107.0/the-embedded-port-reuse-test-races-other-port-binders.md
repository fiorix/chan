# The embedded port reuse test races other port binders

Status: raised by the lead after the v0.106.0 GA on 2026-10-15 from the `ci.yml` run 38766941193 on `main` (the tag's fast-forward push), red once in the AUR chan-desktop build's `check()` on `embedded::tests::embedded_port::saved_port_is_reused_when_free`; written down, not designed, not accepted for build; owner the desktop seat.

## What is open

The test (`desktop/src-tauri/src/embedded.rs`, the `embedded_port` module) binds an ephemeral port, drops the listener, then asks `bind_embedded_port(Some(port))` to reuse it and asserts no fallback. Between the drop and the rebind any other test of the same binary (the crate's tests run in parallel and several bind ports) or any process on the machine can take the port, and the product falls back as designed, so the assertion fails on timing alone. Seen once, on GitHub's runner inside makepkg's `check()`; 640 tests passed beside it; the same job was green in both `ci.yml` runs on the GA branch. A red in that `check()` aborts the AUR package build and, in the downstream workflow, the package's publication.

## What to do

Retry the drop-and-rebind on a fresh port a bounded number of times when another binder took it, or run the two port tests serially in their own binary; the design is the next round's. The pin is the test itself, green under a concurrent binder in the same process.

## Boundaries

`bind_embedded_port`'s fallback stays; the AUR `check()` keeps running the crate's tests.

## Acceptance

1. The test green twenty times in a loop with another thread binding and releasing ephemeral ports beside it.
2. The desktop crate's suite green in the AUR chan-desktop build's `check()` on GitHub's runner.
