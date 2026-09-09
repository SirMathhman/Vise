import "./style.css";
import { renderApp } from "./render.js";
import { setupTree } from "./listing.js";
import { setupFileViewer } from "./fileViewer.js";

const appEl = document.querySelector("#app");
renderApp(appEl);
setupTree(appEl);
setupFileViewer(appEl);
