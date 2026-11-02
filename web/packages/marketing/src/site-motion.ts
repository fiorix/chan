import { mount } from "svelte";
import HomeAtmosphere from "./HomeAtmosphere.svelte";

const target = document.querySelector<HTMLElement>("[data-site-animation]");

if (target) {
  mount(HomeAtmosphere, {
    target,
    props: { morph: target.dataset.siteAnimation === "morph" },
  });
}
