import "./style.css";
import { renderApp } from "./render.js";
import { loadListing } from "./listing.js";

const appEl = document.querySelector("#app");
renderApp(appEl);
loadListing(document.querySelector("#listing"));
