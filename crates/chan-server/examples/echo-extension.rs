//! Minimal extension acceptance fixture: a text field that echoes its value.

use std::fmt::Write as _;
use std::io::Write as _;

use axum::extract::{Query, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use chan_server::EXTENSION_HANDSHAKE_MARKER;

#[derive(Clone)]
struct EchoState {
    token: String,
}

#[derive(Deserialize)]
struct AuthQuery {
    t: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if let Some(pid_file) = std::env::args_os().nth(1) {
        std::fs::write(pid_file, std::process::id().to_string())?;
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let address = listener.local_addr()?;
    let token = random_token();
    let app = Router::new().route("/", get(index)).with_state(EchoState {
        token: token.clone(),
    });

    let handshake = serde_json::json!({
        "url": format!("http://{address}/"),
        "token": token,
    });
    println!("{EXTENSION_HANDSHAKE_MARKER}{handshake}");
    std::io::stdout().flush()?;

    axum::serve(listener, app).await?;
    Ok(())
}

async fn index(State(state): State<EchoState>, Query(auth): Query<AuthQuery>) -> Response {
    if auth.t.as_deref() != Some(state.token.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut response = Html(ECHO_HTML).into_response();
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
        ),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn random_token() -> String {
    let bytes: [u8; 32] = rand::random();
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    token
}

const ECHO_HTML: &str = r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Echo extension</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-monospace, monospace; }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        background: #11151b;
        color: #e8edf4;
      }
      main {
        width: min(36rem, calc(100vw - 3rem));
        padding: 2rem;
        border: 1px solid #344050;
        border-radius: 0.75rem;
        background: #171d25;
      }
      label { display: block; margin-bottom: 0.6rem; color: #aab7c7; }
      input {
        width: 100%;
        padding: 0.75rem 0.9rem;
        border: 1px solid #52647a;
        border-radius: 0.4rem;
        background: #0e1217;
        color: inherit;
        font: inherit;
      }
      input:focus { outline: 2px solid #62d6a8; outline-offset: 2px; }
      output {
        display: block;
        min-height: 1.5rem;
        margin-top: 1.25rem;
        color: #62d6a8;
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <main>
      <label for="echo-input">Type something</label>
      <input id="echo-input" type="text" autocomplete="off" autofocus>
      <output id="echo-output" for="echo-input" aria-live="polite"></output>
    </main>
    <script>
      const input = document.querySelector("#echo-input");
      const output = document.querySelector("#echo-output");
      input.addEventListener("input", () => { output.textContent = input.value; });

      // The keyboard relay. Chan advertises the shell chords it claims as
      // key tokens: the letter or punctuation symbol the layout types, the
      // top-row digit by position, or a named key such as Enter, each with
      // its exact modifiers. This frame resolves a keydown the same way,
      // relays a match with its raw fields, and Chan resolves and checks it
      // again before acting on it.
      const SHIFTED = new Map([
        ["~", "`"], ["{", "["], ["}", "]"], ["<", ","], ["+", "="],
        ["_", "-"], [">", "."], [":", ";"], ["?", "/"],
      ]);
      const PUNCTUATION = new Set(["`", "[", "]", ",", "=", "-", ".", ";", "/"]);
      const POSITIONS = new Map([
        ["Backquote", "`"], ["BracketLeft", "["], ["BracketRight", "]"],
        ["Comma", ","], ["Equal", "="], ["Minus", "-"], ["Period", "."],
        ["Semicolon", ";"], ["Slash", "/"],
      ]);
      const MODIFIERS = new Set(["Shift", "Alt", "Control", "Meta", "AltGraph", "Unidentified"]);
      const mac = /Mac OS X|Macintosh/.test(navigator.userAgent);

      // A keydown that enters text (an IME composition, a dead key, AltGr
      // off macOS) names no chord. Option on macOS replaces the key with a
      // glyph, so only then does the physical position decide.
      function shortcutKey(event) {
        const k = event.key;
        if (!k || MODIFIERS.has(k) || event.isComposing || k === "Process") return null;
        if (!mac && event.getModifierState("AltGraph")) return null;
        const digit = /^Digit([0-9])$/.exec(event.code);
        if (digit) return { key: digit[1], shifted: false, consumable: false };
        if (/^[a-z]$/i.test(k)) return { key: k.toUpperCase(), shifted: false, consumable: false };
        if (PUNCTUATION.has(k)) return { key: k, shifted: false, consumable: true };
        if (SHIFTED.has(k)) return { key: SHIFTED.get(k), shifted: true, consumable: false };
        if (event.altKey) {
          const letter = /^Key([A-Z])$/.exec(event.code);
          if (letter) return { key: letter[1], shifted: false, consumable: false };
          if (POSITIONS.has(event.code)) {
            return { key: POSITIONS.get(event.code), shifted: false, consumable: false };
          }
        }
        if (k === "Dead") return null;
        return { key: k.length === 1 ? k.toUpperCase() : k, shifted: false, consumable: false };
      }

      // The exact chord, or the same chord without a Shift that only typed
      // a punctuation symbol.
      function claimed(event) {
        const id = shortcutKey(event);
        if (!id) return false;
        const matches = (key, shiftKey) =>
          key?.key === id.key &&
          key.ctrlKey === event.ctrlKey &&
          key.altKey === event.altKey &&
          key.metaKey === event.metaKey &&
          key.shiftKey === shiftKey;
        return hostKeys.some((key) =>
          matches(key, event.shiftKey || id.shifted) ||
          (event.shiftKey && id.consumable && matches(key, false))
        );
      }

      let hostKeys = [];
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        if (event.data?.type !== "chan:extension-host-keymap:v2") return;
        if (!Array.isArray(event.data.keys)) return;
        hostKeys = event.data.keys;
      });
      window.addEventListener("keydown", (event) => {
        if (!claimed(event)) return;
        event.preventDefault();
        event.stopPropagation();
        window.parent.postMessage({
          type: "chan:extension-keydown:v2",
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          altGraph: event.getModifierState("AltGraph"),
        }, "*");
      }, true);
    </script>
  </body>
</html>
"##;
