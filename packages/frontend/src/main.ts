import { greet } from "common";
import { requireElement } from "./dom";
import { initChat } from "./views/chat";
import { initHealth, loadHealth } from "./views/health";
import { initKey, loadKeyStatus } from "./views/key";
import { initModels, loadModels } from "./views/models";
import { initHooks, loadHooks } from "./views/hooks";
import { initNotes, loadNotes } from "./views/notes";
import { initTabs } from "./views/tabs";
import { loadTools } from "./views/tools";

requireElement("greeting").textContent = greet("frontend");

initTabs();
initHealth();
initModels();
initKey();
initChat();
initNotes();
initHooks();

void loadHealth();
void loadModels();
void loadKeyStatus();
void loadNotes();
void loadHooks();
void loadTools();
