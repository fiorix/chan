import { mount } from "svelte";
import AnimationGallery from "./AnimationGallery.svelte";

const target = document.getElementById("animation-gallery");
if (target) {
  target.replaceChildren();
  const gallery = mount(AnimationGallery, { target });
  document.querySelectorAll<HTMLAnchorElement>("[data-animation-preview]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      gallery.preview(link.dataset.animationPreview!);
      const url = new URL(window.location.href);
      url.hash = "preview";
      window.history.replaceState(null, "", url);
      document.getElementById("preview")?.scrollIntoView();
      target.querySelector<HTMLSelectElement>("select")?.focus({ preventScroll: true });
    });
  });
}
