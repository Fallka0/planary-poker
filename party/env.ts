import type { Lobby } from "./lobby";
import type { Table } from "./table";

export interface Env {
  Table: DurableObjectNamespace<Table>;
  Lobby: DurableObjectNamespace<Lobby>;
  /** Service binding to planary-casino-api, which owns every player's chips. */
  CASINO: Fetcher;
  /** Shared secret for the casino's internal wallet API. */
  INTERNAL_KEY: string;
  /** planary-auth base URL used to verify player tokens (defaults to https://auth.planary.ch). */
  AUTH_API_URL?: string;
}
