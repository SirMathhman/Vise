import type { HealthResponse } from "common";
import { greet } from "common";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

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
