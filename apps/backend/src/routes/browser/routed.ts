import type { FirefoxBridge } from "./firefox/bridge.js";
import type { FirefoxSession } from "./firefox/session.js";
import type { BrowserSession } from "./session.js";

/**
 * The one BrowserSession the app exposes: the model's browser tools go to the
 * user's Firefox while the Firefox extension is attached (decided per call, so
 * turning the extension on or off takes effect immediately), and to the
 * headless Chrome session otherwise. The viewer panel's half (the URL bar,
 * the screencast stream, panel input) always belongs to Chrome: with Firefox
 * driven, the user watches Firefox itself, so there is nothing to stream.
 */
export function createRoutedSession(
  chrome: BrowserSession,
  firefox: FirefoxSession,
  bridge: FirefoxBridge
): BrowserSession {
  const tools = (): Pick<
    BrowserSession,
    "open" | "snapshot" | "act" | "screenshot" | "dialog"
  > => (bridge.connected() ? firefox : chrome);
  return {
    open: (args) => tools().open(args),
    snapshot: () => tools().snapshot(),
    act: (tool, args) => tools().act(tool, args),
    screenshot: (args) => tools().screenshot(args),
    dialog: (args) => tools().dialog(args),
    navigate: (url) => chrome.navigate(url),
    subscribeFrames: (cb) => chrome.subscribeFrames(cb),
    setViewport: (w, h) => chrome.setViewport(w, h),
    dispatchInput: (input) => chrome.dispatchInput(input),
    async close() {
      bridge.close();
      await chrome.close();
    },
  };
}
