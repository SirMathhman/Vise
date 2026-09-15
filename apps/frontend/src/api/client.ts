/**
 * Typed fetch wrapper for the backend API. Each function returns parsed data
 * or throws an `Error` with the server-provided message (falling back to the
 * HTTP status). Views call these instead of `fetch` directly so that JSON
 * parsing and error normalization live in one place.
 */

export interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

export interface LsResponse {
  path: string;
  items: DirEntry[];
}

export interface FileResponse {
  path: string;
  size: number;
  content: string;
}

/** GET the backend health status. */
export async function health(): Promise<string> {
  const res = await fetch("/api/health");
  if (!res.ok) return fail(res);
  const data = (await res.json()) as { status: string };
  return data.status;
}

function encodeRel(rel: string): string {
  return rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** Fetch a normalized error message from a failed response. */
async function fail(res: Response): Promise<never> {
  const data = (await res.json().catch(() => null)) as {
    message?: string;
  } | null;
  throw new Error(data?.message ?? `HTTP ${res.status}`);
}

/** GET the listing for a directory ("" = root). */
export async function listDir(rel: string): Promise<LsResponse> {
  const res = await fetch(`/api/ls/${encodeRel(rel)}`);
  if (!res.ok) return fail(res);
  return (await res.json()) as LsResponse;
}

/** GET the contents of a file. */
export async function getFile(rel: string): Promise<FileResponse> {
  const res = await fetch(`/api/file/${encodeRel(rel)}`);
  if (!res.ok) return fail(res);
  return (await res.json()) as FileResponse;
}

/** PUT new contents to a file. */
export async function putFile(rel: string, content: string): Promise<void> {
  const res = await fetch(`/api/file/${encodeRel(rel)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) return fail(res);
}

/** DELETE a file. */
export async function deleteFile(rel: string): Promise<void> {
  const res = await fetch(`/api/file/${encodeRel(rel)}`, {
    method: "DELETE",
  });
  if (!res.ok) return fail(res);
}

/**
 * POST a create request for a file or directory in `parentRel`. Throws on
 * failure so the caller can surface the error.
 */
export async function createEntry(
  kind: "file" | "directory",
  parentRel: string,
  name: string
): Promise<void> {
  const rel = parentRel ? `${parentRel}/${name}` : name;
  const endpoint = kind === "directory" ? "/api/dir" : "/api/file";
  const payload =
    kind === "directory" ? { path: rel } : { path: rel, content: "" };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return fail(res);
}
