import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleNotes } from "../../src/notes/notes-routes";

const BASE = "http://localhost:3000";

function request(method: string, pathname: string, body?: string): Request {
  return new Request(`${BASE}${pathname}`, { method, body });
}

const NOTE = JSON.stringify({
  name: "Plan",
  category: "todo",
  summary: "s",
  content: "c",
});

describe("note routes", () => {
  beforeEach(() => {
    process.env.VISE_CONFIG_DIR = mkdtempSync(
      path.join(tmpdir(), "vise-notes-"),
    );
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
  });

  test("a body that does not match the note schema is refused with 400", async () => {
    const reply = await handleNotes(
      request("POST", "/api/notes", JSON.stringify({ name: "  " })),
      "/api/notes",
    );
    expect(reply.status).toBe(400);
  });

  test("a missing note is 404 on read", async () => {
    const reply = await handleNotes(
      request("GET", "/api/notes/missing"),
      "/api/notes/missing",
    );
    expect(reply.status).toBe(404);
  });

  test("a name already in use is 409 on create", async () => {
    expect(
      (await handleNotes(request("POST", "/api/notes", NOTE), "/api/notes"))
        .status,
    ).toBe(201);
    const reply = await handleNotes(
      request("POST", "/api/notes", NOTE),
      "/api/notes",
    );
    expect(reply.status).toBe(409);
  });

  test("a method the route does not allow is 405", async () => {
    expect(
      (await handleNotes(request("PUT", "/api/notes"), "/api/notes")).status,
    ).toBe(405);
    expect(
      (
        await handleNotes(
          request("POST", "/api/notes/abc", NOTE),
          "/api/notes/abc",
        )
      ).status,
    ).toBe(405);
  });
});
