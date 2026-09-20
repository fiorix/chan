import "@chan/web-shared/theme.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { installUnhandledRejectionNotice } from "./state/unhandledRejection.svelte";

installUnhandledRejectionNotice();

const target = document.getElementById("app");
if (!target) throw new Error("missing #app");
mount(App, { target });
