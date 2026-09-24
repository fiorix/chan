import "@chan/launcher/styles.css";
import { mount } from "svelte";
import LauncherDemo from "@chan/launcher/demo";

const target = document.getElementById("launcher-demo");

if (target) {
  const variant = target.dataset.variant;
  mount(LauncherDemo, {
    target,
    // Per-page config rides on the mount node so one bundle serves both
    // pages that load it: the manual's empty first-run embed
    // (data-variant="empty" data-hints="true") and the devserver-form embed
    // page (data-variant="devserver"). The home page does not load it; a
    // node without a known variant gets the populated library.
    props: {
      variant: variant === "empty" || variant === "devserver" ? variant : "populated",
      hints: target.dataset.hints === "true",
    },
  });
  target.classList.add("mounted");
}
