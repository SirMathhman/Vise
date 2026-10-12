/** One request the code under test made. */
export interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

/**
 * Replace `fetch` for a test: every request is recorded in `calls` and
 * answered by `respond`. Call `restore()` (an `afterEach`) to put the real one
 * back.
 */
export function mockFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  const replacement = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return respond(url, init);
  };
  Object.assign(replacement, { preconnect: original.preconnect.bind(original) });
  globalThis.fetch = replacement as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** A JSON response. */
export const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
