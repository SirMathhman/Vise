import "./style.css";
import { renderApp } from "./render.js";
import { setupTree } from "./listing.js";

const appEl = document.querySelector("#app");
renderApp(appEl);
setupTree(appEl);
