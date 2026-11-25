import { greet } from "common";
import { requireElement } from "./dom";
import { initChat } from "./views/chat";
import { initHealth, loadHealth } from "./views/health";
import { initKey, loadKeyStatus } from "./views/key";
import { initModels, loadModels } from "./views/models";

requireElement("greeting").textContent = greet("frontend");

initHealth();
initModels();
initKey();
initChat();

void loadHealth();
void loadModels();
void loadKeyStatus();
