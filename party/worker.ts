import { routePartykitRequest } from "partyserver";
import type { Env } from "./env";

export { Lobby } from "./lobby";
export { Table } from "./table";

// Routes /parties/table/:id and /parties/lobby/main to their Durable Objects.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routePartykitRequest(request, env, { cors: true })) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
