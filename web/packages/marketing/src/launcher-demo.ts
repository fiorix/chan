import "@chan/launcher/styles.css";
import { mount } from "svelte";
import LauncherDemo from "@chan/launcher/demo";

const target = document.getElementById("launcher-demo");

if (target) {
  const variant = target.dataset.variant;
  mount(LauncherDemo, {
    target,
    // The manual's mount nodes select the empty first-run or devserver form.
    // Other variant values use the populated fixture.
    props: {
      variant: variant === "empty" || variant === "devserver" ? variant : "populated",
      hints: target.dataset.hints === "true",
    },
  });
  target.classList.add("mounted");
}
