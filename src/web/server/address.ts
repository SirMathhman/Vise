import { randomBytes } from "node:crypto";

// The address the browser server listens on and the token it checks.
export interface WebAddress {
  port: number;
  token: string;
}

// Reads the address from the environment, which web:dev sets so that a restarted server keeps the
// address the open page knows. The token is removed from the environment: the commands the session
// runs (PowerShell inherits it) must not be able to read it. Call this before any process starts.
export function takeWebAddress(env: Record<string, string | undefined>): WebAddress {
  const port = Number(env.VISE_WEB_PORT ?? 0);
  const token = env.VISE_WEB_TOKEN || randomBytes(24).toString("hex");
  delete env.VISE_WEB_TOKEN;
  return { port: Number.isInteger(port) ? port : 0, token };
}
