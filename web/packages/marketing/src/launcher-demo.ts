import "@chan/launcher/styles.css";
import { mount } from "svelte";
import LauncherDemo from "@chan/launcher/demo";

const target = document.getElementById("launcher-demo");

if (target) {
  const variant = target.dataset.variant;
  mount(LauncherDemo, {
    target,
    // The mount node selects the manual's first-run/devserver embeds or
    // the populated Computers preview, all served by the same bundle.
    props: {
      variant: variant === "empty" || variant === "devserver" ? variant : "populated",
      hints: target.dataset.hints === "true",
    },
  });
  target.classList.add("mounted");
}
