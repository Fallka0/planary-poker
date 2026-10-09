import { type Connection, Server } from "partyserver";
import type { Env } from "./env";
import { type CreateTableRequest, type LobbyMessage, type LobbyTable, type Phase, SEATS } from "../shared/protocol";
import { HOUSE_TABLES, houseTable, knownStakes, type Stakes } from "../shared/tables";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function newTableId(prefix: "t" | "p") {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

/** The players' tables listed when the lobby last looked, so it can ask after them when it wakes. */
const LISTED_KEY = "listed";

function problem(error: string, status: number) {
  return Response.json({ error }, { status, headers: CORS });
}

/**
 * One lobby room ("main"): lists the house tables and players' public tables,
 * opens new tables, and turns a bare code into the table it belongs to.
 */
export class Lobby extends Server<Env> {
  /** Live seat counts, as the tables report them. Public tables only. */
  tables = new Map<string, LobbyTable>();

  /**
   * The lobby keeps its counts in memory, and a lobby nobody is looking at is
   * put to sleep. Waking up, it asks the house tables and the players' tables
   * it last listed who is sitting at them, rather than showing a full table as
   * empty until somebody next sits down or stands up.
   */
  async onStart() {
    const listed = (await this.ctx.storage.get<string[]>(LISTED_KEY)) ?? [];
    const ids = [...HOUSE_TABLES.map((t) => t.id), ...listed];
    await Promise.all(
      ids.map(async (id) => {
        const now = await this.table(id)
          .listing()
          .catch(() => null);
        const house = houseTable(id);
        if (!now || (now.seated === 0 && !house)) return;
        this.tables.set(id, {
          id,
          name: house?.name ?? null,
          stakes: now.stakes,
          seated: now.seated,
          bots: now.bots,
          phase: now.phase,
          updatedAt: Date.now(),
        });
      }),
    );
    await this.rememberListed();
  }

  /** Writes down which players' tables are listed. Only when that changes, not on every count. */
  async rememberListed() {
    const listed = [...this.tables.keys()].filter((id) => !houseTable(id)).sort();
    const known = (await this.ctx.storage.get<string[]>(LISTED_KEY)) ?? [];
    if (listed.join() !== known.join()) await this.ctx.storage.put(LISTED_KEY, listed);
  }

  list(): LobbyMessage {
    const house = HOUSE_TABLES.map(
      (t): LobbyTable =>
        this.tables.get(t.id) ?? { id: t.id, name: t.name, stakes: t.stakes, seated: 0, bots: 0, phase: "waiting", updatedAt: 0 },
    );
    const tables = [...this.tables.values()]
      .filter((t) => !houseTable(t.id))
      .sort((a, b) => b.seated - a.seated || b.updatedAt - a.updatedAt);
    return { type: "tables", house, tables };
  }

  publish() {
    this.broadcast(JSON.stringify(this.list()));
  }

  onConnect(conn: Connection) {
    conn.send(JSON.stringify(this.list()));
  }

  /** A public table's seat count changed. Called by the table itself, worker to worker. */
  async report(entry: { id: string; seated: number; bots: number; phase: Phase; stakes: Stakes }) {
    if (!/^t-[a-z0-9]{6}$/.test(entry.id)) return;
    const seated = Math.max(0, Math.min(SEATS, Math.floor(entry.seated) || 0));
    const bots = Math.max(0, Math.min(seated, Math.floor(entry.bots) || 0));
    const house = houseTable(entry.id);
    // House tables stay listed when empty; a player's table leaves the lobby
    // with its last human. A table sitting there with nothing but bots at it
    // is not a table anybody is waiting at, so it counts as empty here.
    if (seated - bots === 0 && !house) this.tables.delete(entry.id);
    else
      this.tables.set(entry.id, {
        id: entry.id,
        name: house?.name ?? null,
        stakes: entry.stakes,
        seated,
        bots,
        phase: entry.phase,
        updatedAt: Date.now(),
      });
    this.publish();
    await this.rememberListed();
  }

  table(id: string) {
    return this.env.Table.get(this.env.Table.idFromName(id));
  }

  async onRequest(req: Request) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (req.method === "POST" && action === "create") return this.create(req);
    if (action === "resolve") return this.resolve(url.searchParams.get("code") ?? "");
    return Response.json(this.list(), { headers: CORS });
  }

  /**
   * Opens a player's table. The stakes are written into the new table before
   * anyone can reach it, and the table refuses to have them written twice: a
   * big blind that could move once chips were on the felt would be no stake
   * at all.
   */
  async create(req: Request) {
    const body = (await req.json().catch(() => null)) as Partial<CreateTableRequest> | null;
    const stakes = knownStakes(body?.stakes);
    if (!stakes) return problem("Choose the blinds for your table.", 400);
    if (body?.visibility !== "public" && body?.visibility !== "private") return problem("Choose public or private.", 400);

    const prefix = body.visibility === "public" ? "t" : "p";
    // A random id that is already taken is vanishingly rare; a few tries settle it.
    for (let attempt = 0; attempt < 4; attempt++) {
      const id = newTableId(prefix);
      if (await this.table(id).configure({ stakes, bots: Boolean(body.bots) })) return Response.json({ id }, { headers: CORS });
    }
    return problem("Couldn't open a table. Try again.", 503);
  }

  /**
   * Finds the table behind a six-character code. A code doesn't say whether
   * its table is public or private, so the house tables are checked first,
   * then a public table, then a private one. A code that leads to no table
   * that was ever opened is refused rather than opening an empty one.
   */
  async resolve(raw: string) {
    const code = raw.trim().toLowerCase();
    if (!/^[a-z0-9]{6}$/.test(code))
      return problem("That doesn't look like a table code. Codes are six letters and numbers, like k7m2qx.", 400);
    if (houseTable(`t-${code}`)) return Response.json({ id: `t-${code}` }, { headers: CORS });
    for (const id of [`t-${code}`, `p-${code}`]) {
      if (await this.table(id).exists()) return Response.json({ id }, { headers: CORS });
    }
    return problem("No table has that code. It may have closed, or a character is off.", 404);
  }
}
