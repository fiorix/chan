import { mount } from "svelte";
import WavePreview from "./WavePreview.svelte";
import "./styles.css";

mount(WavePreview, { target: document.getElementById("app")! });
