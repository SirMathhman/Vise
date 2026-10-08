import { dlopen, FFIType, ptr } from "bun:ffi";
// The webview library's DLL (from the `webview-bun` package, which is used only for this file).
// Embedded in the compiled build; TypeScript has no type for a DLL import.
// @ts-expect-error a `type: "file"` import is a path.
import dllPath from "../../node_modules/webview-bun/build/libwebview.dll" with { type: "file" };

/**
 * The app window, run on its own thread because `webview_run` blocks until the
 * window is closed and the server shares the main thread's event loop. The
 * main thread posts the address; this posts "closed" when the window ends.
 */
declare const self: Worker;

const cString = (text: string) => ptr(new TextEncoder().encode(`${text}\0`));

self.onmessage = (event: MessageEvent<{ url: string }>) => {
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
  lib.webview_set_title(view, cString("Vise"));
  lib.webview_set_size(view, 1280, 860, 0);
  lib.webview_navigate(view, cString(event.data.url));
  lib.webview_run(view);
  lib.webview_destroy(view);
  postMessage("closed");
};
