import type { ErrorResponse, HealthResponse, ModelsResponse } from "common";
import { greet } from "common";
import { fetchModels } from "./openrouter";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/models") {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        const body: ErrorResponse = { error: "OPENROUTER_API_KEY is not set" };
        return Response.json(body, { status: 500 });
      }
      try {
        const body: ModelsResponse = { models: await fetchModels(apiKey) };
        return Response.json(body);
      } catch (err) {
        const body: ErrorResponse = { error: err instanceof Error ? err.message : String(err) };
        return Response.json(body, { status: 502 });
      }
    }

    if (url.pathname === "/api/health") {
      const body: HealthResponse = {
        status: "ok",
        service: "backend",
        time: new Date().toISOString(),
      };
      return Response.json(body);
    }

    if (url.pathname === "/api/greet") {
      const name = url.searchParams.get("name") ?? "world";
      return Response.json({ message: greet(name) });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`backend listening on http://localhost:${server.port}`);
