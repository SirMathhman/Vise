import { expect, test } from "bun:test";
import { takeWebAddress } from "./address.ts";

test("reads the port and token, and removes the token from the environment", () => {
  const env: Record<string, string | undefined> = {
    VISE_WEB_PORT: "4123",
    VISE_WEB_TOKEN: "secret",
  };
  expect(takeWebAddress(env)).toEqual({ port: 4123, token: "secret" });
  expect("VISE_WEB_TOKEN" in env).toBe(false);
});

test("without the variables, the port is 0 and the token is random and not empty", () => {
  const env: Record<string, string | undefined> = {};
  const address = takeWebAddress(env);
  expect(address.port).toBe(0);
  expect(address.token).toHaveLength(48);
  expect(takeWebAddress(env).token).not.toBe(address.token);
});
