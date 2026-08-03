// Entry point. Mounts the Svelte 5 launcher root.

import { mount } from "svelte";
import App from "./App.svelte";
import "./styles.css";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app element");

mount(App, { target });
