import type { IncomingMessage, ServerResponse } from "node:http";

export interface Route {
  method: string;
  pattern: string;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    body: unknown
  ) => Promise<void> | void;
}

export function matchRoute(
  routes: Route[],
  method: string,
  path: string
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPattern(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}

function matchPattern(
  pattern: string,
  path: string
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);

  const wildcardIndex = patternParts.indexOf("*");
  if (wildcardIndex !== -1) {
    if (patternParts.length > 1 && wildcardIndex !== patternParts.length - 1) {
      return null;
    }
    if (pathParts.length < patternParts.length - 1) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length - 1; i++) {
      const p = patternParts[i];
      if (p.startsWith(":")) {
        params[p.slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (p !== pathParts[i]) {
        return null;
      }
    }
    params.rest = pathParts
      .slice(patternParts.length - 1)
      .map(decodeURIComponent)
      .join("/");
    return params;
  }

  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (p !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
