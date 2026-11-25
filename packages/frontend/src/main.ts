import type { HealthResponse } from "common";
import { greet } from "common";

// Client-side entry point. It talks to the backend over HTTP and uses the
// shared types and helpers from `common`.
const apiBase = process.env.API_BASE ?? "http://localhost:3000";

const health = (await fetch(`${apiBase}/api/health`).then((r) => r.json())) as HealthResponse;
console.log(`backend status: ${health.status} (${health.service} at ${health.time})`);
console.log(greet("frontend"));
