import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { anyFreePort, choosePort, isPortFree, suggestPort } from "../../apps/web/src/port.ts";

const taken =
  (...ports: number[]) =>
  async (p: number) =>
    !ports.includes(p);

test("a free port is used as it is, with no note", async () => {
  expect(await choosePort(3000, taken())).toEqual({ port: 3000 });
});

test("a busy port moves to the next free one and the note says how to choose another", async () => {
  const chosen = await choosePort(3000, taken(3000, 3001));
  expect(chosen.port).toBe(3002);
  expect(chosen.note).toContain("Port 3000 was already in use");
  expect(chosen.note).toContain("port 3002");
  expect(chosen.note).toContain("settings");
});

test("when nothing near is free the system picks one, so starting never fails", async () => {
  const chosen = await choosePort(3000, async (p) => p > 3200 || p < 3000);
  expect(chosen.port).toBeGreaterThan(0);
  expect(chosen.note).toBeDefined();
});

test("a port in use is detected for real, and a free one can be found", async () => {
  const holder = createServer();
  await new Promise<void>((r) => holder.listen(0, "127.0.0.1", () => r()));
  const port = (holder.address() as { port: number }).port;
  expect(await isPortFree(port)).toBe(false);
  expect(await suggestPort(port)).toBeGreaterThan(port);
  expect(await isPortFree(await anyFreePort())).toBe(true);
  holder.close();
});
