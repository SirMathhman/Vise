// Vise Browser Control — background script.
//
// Bridges the Vise backend and one Firefox tab. The backend can't push to an
// extension, so this script long-polls it (GET /api/firefox/poll): each
// response is one browser tool call (browser_open, browser_click, ...), which
// is run here or in the tab's content script (content.js) and answered with
// POST /api/firefox/result. While attached, the Vise backend sends the model's
// browser tools here instead of to its headless Chrome.
//
// Attaching is explicit: click the toolbar button on the tab to control (the
// badge shows "ON"); click it again on that tab to detach. Nothing is polled
// or controlled while detached. The tools mirror the Chrome ones (same numbered
// element snapshot, same result text), except browser_dialog and
// browser_run_code, which need Playwright and are not available here.

const BACKEND = "http://localhost:3001";
// A custom header the backend requires: a web page can't add it to a
// cross-origin request without a CORS preflight the backend never approves.
const HEADERS = { "X-Vise-Bridge": "1" };
const LOAD_TIMEOUT_MS = 45000;
const CALL_TIMEOUT_MS = 30000;

let enabled = false;
let controlledTab = null;
let pollAbort = null;
const NAVIGATED = Symbol("navigated");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function api(path, init = {}) {
  return fetch(`${BACKEND}${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers ?? {}) },
  });
}

function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Attach / detach ─────────────────────────────────────────────────────

async function attach(tab) {
  controlledTab = tab.id;
  // Pages loaded before the extension was installed have no content script.
  await browser.tabs
    .executeScript(tab.id, { file: "content.js" })
    .catch(() => {});
  if (enabled) return;
  enabled = true;
  await browser.browserAction.setBadgeText({ text: "ON" });
  await browser.browserAction.setBadgeBackgroundColor({ color: "#2e7d32" });
  void pollLoop();
}

async function detach() {
  if (!enabled) return;
  enabled = false;
  controlledTab = null;
  if (pollAbort) pollAbort.abort();
  await browser.browserAction.setBadgeText({ text: "" });
  await post("/api/firefox/goodbye", {}).catch(() => {});
}

browser.browserAction.onClicked.addListener(async (tab) => {
  if (enabled && controlledTab === tab.id) await detach();
  else await attach(tab);
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === controlledTab) controlledTab = null;
});

// ── The poll loop ───────────────────────────────────────────────────────

async function pollLoop() {
  while (enabled) {
    pollAbort = new AbortController();
    try {
      const res = await api("/api/firefox/poll", { signal: pollAbort.signal });
      if (res.status === 200) {
        const cmd = await res.json();
        void execute(cmd); // run concurrently; the next poll can start now
      }
    } catch (err) {
      if (!enabled) return;
      await sleep(2000); // the backend is down or restarting; try again
    }
  }
}

async function execute(cmd) {
  try {
    const out = await run(cmd.tool, cmd.args ?? {});
    const body = typeof out === "string" ? { result: out } : out; // { result, images }
    await post("/api/firefox/result", { id: cmd.id, ok: true, ...body });
  } catch (err) {
    await post("/api/firefox/result", {
      id: cmd.id,
      ok: false,
      error: String(err && err.message ? err.message : err),
    }).catch(() => {});
  }
}

// ── Tabs and pages ──────────────────────────────────────────────────────

async function currentTab() {
  if (controlledTab === null) return null;
  try {
    return await browser.tabs.get(controlledTab);
  } catch {
    controlledTab = null;
    return null;
  }
}

async function requireTab() {
  const tab = await currentTab();
  if (!tab) {
    throw new Error(
      "no browser page is open; call browser_open with a URL first"
    );
  }
  return tab;
}

/** Resolve once the tab finishes its next load (or after `timeout`, which is not an error). */
function waitForLoad(tabId, timeout = LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeout);
    browser.tabs.onUpdated.addListener(listener);
  });
}

/** Ask the tab's content script to run a tool; retries while the script isn't there yet. */
async function content(tabId, tool, args) {
  let injected = false;
  for (let attempt = 0; ; attempt++) {
    let reply;
    try {
      reply = await Promise.race([
        browser.tabs.sendMessage(tabId, { tool, args }),
        // Firefox never settles a message to a page torn down by a
        // navigation, so don't wait forever for one.
        sleep(CALL_TIMEOUT_MS).then(() => {
          throw new Error("the page did not answer in time");
        }),
      ]);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (
        /Receiving end does not exist|Could not establish connection/.test(msg)
      ) {
        if (attempt === 3 && !injected) {
          injected = true;
          await browser.tabs
            .executeScript(tabId, { file: "content.js" })
            .catch(() => {});
        }
        if (attempt < 40) {
          await sleep(150);
          continue;
        }
        throw new Error(
          "could not reach the page (a browser page such as about: or addons.mozilla.org can't be controlled, or it is still loading)"
        );
      }
      // The page went away mid-action (the action navigated): the caller
      // reads the new page instead of repeating the action.
      const lost = new Error(msg);
      lost.lost = true;
      throw lost;
    }
    if (!reply) throw new Error("the page did not answer");
    if (!reply.ok) throw new Error(reply.error);
    return reply.text;
  }
}

function withHttps(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

// ── Tool dispatch ───────────────────────────────────────────────────────

async function snapshot(tabId) {
  return content(tabId, "browser_snapshot", {});
}

async function run(tool, args) {
  switch (tool) {
    case "browser_open": {
      const raw = typeof args.url === "string" ? args.url.trim() : "";
      if (!raw) throw new Error("url is required");
      let tab = await currentTab();
      if (!tab) {
        tab = await browser.tabs.create({ url: "about:blank", active: true });
        controlledTab = tab.id;
      }
      const loaded = waitForLoad(tab.id);
      await browser.tabs.update(tab.id, { url: withHttps(raw) });
      await loaded;
      return `Opened the page in Firefox.\n${await snapshot(tab.id)}`;
    }
    case "browser_navigate": {
      const tab = await requireTab();
      const action = args.action;
      if (action !== "back" && action !== "forward" && action !== "reload") {
        throw new Error('action must be "back", "forward", or "reload"');
      }
      const before = tab.url;
      const loaded = waitForLoad(tab.id, 15000);
      try {
        if (action === "back") await browser.tabs.goBack(tab.id);
        else if (action === "forward") await browser.tabs.goForward(tab.id);
        else await browser.tabs.reload(tab.id);
      } catch {
        return `There is no ${action === "back" ? "previous" : "next"} page in the history.\n${await snapshot(tab.id)}`;
      }
      await loaded;
      const now = await browser.tabs.get(tab.id);
      const said =
        action === "reload"
          ? "Reloaded the page."
          : now.url !== before
            ? `Went ${action}.`
            : `There is no ${action === "back" ? "previous" : "next"} page in the history.`;
      return `${said}\n${await snapshot(tab.id)}`;
    }
    case "browser_screenshot": {
      const tab = await requireTab();
      // Only the visible tab of a window can be captured.
      await browser.tabs.update(tab.id, { active: true });
      const image = await browser.tabs.captureVisibleTab(tab.windowId, {
        format: "jpeg",
        quality: 70,
      });
      const shot = await browser.tabs.get(tab.id);
      return {
        result: `Took a screenshot of the viewport: "${shot.title || "(untitled)"}" at ${shot.url}. It is attached as an image.`,
        images: [image],
      };
    }
    case "browser_dialog":
    case "browser_run_code":
      throw new Error(
        `${tool} is not available while driving Firefox (it needs the Playwright-driven Chrome page). Use browser_snapshot, browser_read, and the other browser tools instead.`
      );
    default: {
      const tab = await requireTab();
      // An action that navigates the page tears down the content script
      // mid-call, so its reply never arrives: watch for the tab starting to
      // load and, if it does, report the page it lands on instead.
      let stopWatching = () => {};
      const navigated = new Promise((resolve) => {
        const listener = (id, change) => {
          if (id === tab.id && change.status === "loading") resolve(NAVIGATED);
        };
        browser.tabs.onUpdated.addListener(listener);
        stopWatching = () => browser.tabs.onUpdated.removeListener(listener);
      });
      try {
        const call = content(tab.id, tool, args);
        call.catch(() => {}); // it may lose the race and reject afterwards
        const first = await Promise.race([call, navigated]);
        if (first !== NAVIGATED) return first;
      } catch (err) {
        if (!err.lost) throw err;
      } finally {
        stopWatching();
      }
      await sleep(300);
      const landed = await browser.tabs.get(tab.id);
      if (landed.status !== "complete") await waitForLoad(tab.id, 15000);
      return `The action was performed and the page navigated.
${await snapshot(tab.id)}`;
    }
  }
}
