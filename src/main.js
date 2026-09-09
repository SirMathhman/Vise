import "./style.css";
import { renderApp } from "./render.js";
import { setupCounter } from "./counter.js";

const appEl = document.querySelector("#app");
renderApp(appEl);
setupCounter(document.querySelector("#counter"));
