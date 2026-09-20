# Vise Browser Control (Firefox extension)

Lets the Vise assistant drive **your own Firefox** instead of the headless
Chrome page it normally uses. While the extension is attached, the model's
`browser_*` tools (open, snapshot, click, type, hover, drag, read, navigate,
screenshot) act on the attached tab; when it is not attached they go to Chrome
as before.

## Install (temporary add-on, no build step)

1. Start Vise's backend (it must be reachable at `http://localhost:3001`; change
   `BACKEND` at the top of `background.js` otherwise).
2. In Firefox open `about:debugging#/runtime/this-firefox`, click
   **Load Temporary Add-on…**, and choose `apps/firefox-extension/manifest.json`.
   (A temporary add-on is removed when Firefox restarts.)

## Use

- Click the toolbar button on the tab you want controlled. The badge shows **ON**
  and the backend now sends browser tools here. Click the button again on that
  tab to detach (or close the tab).
- `browser_open` navigates the attached tab (bare hosts get `https://`); if the
  attached tab was closed it opens a new one.
- The model acts fully autonomously in that tab: there are no per-action
  prompts. Watch it, and detach when you want it to stop. Only the attached tab
  is touched, but anything you are logged into in that tab is reachable, and a
  page you let it read can contain text aimed at the model.

## What differs from the Chrome tools

Not available: `browser_dialog` and `browser_run_code` (they need Playwright);
`browser_screenshot` captures the viewport only. Because actions are performed by
a page script, the events are synthetic: a site that insists on trusted events
ignores them, hover only reaches mouse-event listeners (not CSS `:hover`), and a
key press is emulated for typing a character, Backspace, Enter (submits a form)
and Tab only. Browser pages (`about:`, `addons.mozilla.org`) can't be controlled.

## How it works

`background.js` long-polls `GET /api/firefox/poll` on the backend (each response is
one tool call), runs it (`content.js` does the in-page work), and posts the answer
to `POST /api/firefox/result`. Every request carries an `X-Vise-Bridge` header,
which the backend requires: a web page can't add it to a cross-origin request
without a CORS preflight the backend never approves. See
`apps/backend/src/routes/browser/firefox/`.
