// Entry point. Mounts the Svelte 5 launcher root.

import { mount } from "svelte";
import App from "./App.svelte";
import "./styles.css";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app element");

// The native command window is transparent from its very first frame. Doing
// this before mount avoids a dark launcher-background flash while App's
// onMount installs the same class for lifecycle cleanup.
if (new URLSearchParams(location.search).get("command") === "1") {
  document.documentElement.classList.add("chan-command-overlay");
}

mount(App, { target });
