import { describe, expect, test } from "bun:test";
import { refuseWrite } from "../../src/http";

const URL = "http://127.0.0.1:3000/api/hooks/global";
const FRONTEND = "http://localhost:5173";

describe("write guard", () => {
  test("refuses a write from another origin, and a write whose body is not JSON", () => {
    const foreign = new Request(URL, {
      method: "PUT",
      headers: {
        Origin: "https://example.com",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(refuseWrite(foreign)?.status).toBe(403);

    const plain = new Request(URL, {
      method: "PUT",
      headers: { Origin: FRONTEND, "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(refuseWrite(plain)?.status).toBe(415);
  });

  test("lets the frontend's JSON write through, and reads from anywhere", () => {
    const write = new Request(URL, {
      method: "PUT",
      headers: { Origin: FRONTEND, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(refuseWrite(write)).toBeUndefined();
    expect(
      refuseWrite(
        new Request(URL, { headers: { Origin: "https://example.com" } }),
      ),
    ).toBeUndefined();
  });
});
