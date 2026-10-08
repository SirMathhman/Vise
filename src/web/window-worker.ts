import { dlopen, FFIType, ptr } from "bun:ffi";
// The webview library's DLL (from the `webview-bun` package, which is used only for this file).
// Embedded in the compiled build; TypeScript has no type for a DLL import.
// @ts-expect-error a `type: "file"` import is a path.
import dllPath from "../../node_modules/webview-bun/build/libwebview.dll" with { type: "file" };

/**
 * The app window, run on its own thread because `webview_run` blocks until the
 * window is closed and the server shares the main thread's event loop. The
 * main thread posts the address; this reports `ready` once the window exists,
 * `failed` (with the reason) if it cannot be made, and `closed` when the user
 * closes it (the events of `WindowEvent` in `desktop.ts`).
 */
declare const self: Worker;

const cString = (text: string) => ptr(new TextEncoder().encode(`${text}\0`));

function show(url: string): void {
  const { symbols: lib } = dlopen(dllPath as string, {
    webview_create: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    webview_destroy: { args: [FFIType.ptr], returns: FFIType.void },
    webview_run: { args: [FFIType.ptr], returns: FFIType.void },
    webview_set_title: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    webview_set_size: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.void,
    },
    webview_navigate: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  });
  const view = lib.webview_create(0, null);
  // Without the WebView2 runtime there is no window to give back.
  if (!view) {
    throw new Error(
      "the window could not be created (is the Microsoft WebView2 runtime installed?)",
    );
  }
  lib.webview_set_title(view, cString("Vise"));
  lib.webview_set_size(view, 1280, 860, 0);
  lib.webview_navigate(view, cString(url));
  postMessage({ type: "ready" });
  lib.webview_run(view);
  lib.webview_destroy(view);
}

self.onmessage = (event: MessageEvent<{ url: string }>) => {
  try {
    show(event.data.url);
    postMessage({ type: "closed" });
  } catch (error) {
    postMessage({
      type: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};
