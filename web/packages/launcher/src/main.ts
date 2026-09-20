// Entry point. Mounts the Svelte 5 launcher root.

import { mount } from "svelte";
import App from "./App.svelte";
import { installUnhandledRejectionNotice } from "./state/unhandledRejection.svelte";
import "./styles.css";

installUnhandledRejectionNotice();

const target = document.getElementById("app");
if (!target) throw new Error("missing #app element");

mount(App, { target });
