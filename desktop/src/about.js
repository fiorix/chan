// About window logic. Three small jobs:
//   1. Apply the launcher theme so the window matches. The Rust opener injects
//      the launcher's light/dark choice as `window.__CHAN_THEME__` (null =
//      follow the OS media query), since this window is on the Tauri App origin
//      and shares no storage with the loopback-served launcher.
//   2. Show the desktop version and build id, passed in as the `?v=` / `?b=`
//      query params by the Rust opener (avoids needing an `app`-plugin
//      capability for getVersion).
//   3. Open external links in the system browser via the opener plugin
//      (a plain <a> would navigate the About webview itself).
const { openUrl } = window.__TAURI__.opener;

const injectedTheme = window.__CHAN_THEME__;
const root = document.documentElement;
if (injectedTheme === 'dark' || injectedTheme === 'light') {
  root.setAttribute('data-theme', injectedTheme);
} else {
  root.removeAttribute('data-theme');
}

const params = new URLSearchParams(location.search);
const version = params.get('v');
if (version) {
  document.getElementById('version').textContent = version;
}
// The build id (`?b=`, stamped from the commit at compile time) is what
// tells two builds apart when their version strings match, which is every
// pre-release branch build against the previous release.
const build = params.get('b');
if (build) {
  document.getElementById('build').textContent = build;
}

// Route every external link through the opener plugin. preventDefault stops
// the webview from trying to navigate to the href itself.
for (const a of document.querySelectorAll('a.ext')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href) openUrl(href).catch((err) => console.warn('openUrl failed:', err));
  });
}
