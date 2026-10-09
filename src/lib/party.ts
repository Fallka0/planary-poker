import type { CreateTableRequest } from "../../shared/protocol";

export const PARTY_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:2003";

const protocol = PARTY_HOST.startsWith("localhost") || PARTY_HOST.startsWith("127.") ? "http" : "https";
const LOBBY = `${protocol}://${PARTY_HOST}/parties/lobby/main`;

/** A lobby answer that wasn't a table: carries the lobby's own explanation when it gave one. */
export class LobbyError extends Error {}

async function lobby(query: string, init?: RequestInit): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${LOBBY}?${query}`, init);
  } catch {
    throw new LobbyError("The tables aren't reachable right now. Try again in a moment.");
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !data.id) throw new LobbyError(data.error ?? "The tables aren't reachable right now. Try again in a moment.");
  return data.id;
}

/** Opens a new table and returns its id. */
export function createTable(request: CreateTableRequest) {
  return lobby("action=create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
}

/** Finds the table a six-character code belongs to. */
export function resolveCode(code: string) {
  return lobby(`action=resolve&code=${encodeURIComponent(code)}`);
}

/**
 * Reads what someone typed into the code box. A full table link or a
 * "p-abc123" names its table outright; a bare "abc123" could be public or
 * private, so the lobby has to look it up.
 */
export function parseTableInput(input: string): { id: string } | { code: string } | null {
  const trimmed = input.trim().toLowerCase();
  const fromUrl = trimmed.match(/\/t\/([tp]-[a-z0-9]{6})(?:[/?#]|$)/);
  if (fromUrl) return { id: fromUrl[1] };
  if (/^[tp]-[a-z0-9]{6}$/.test(trimmed)) return { id: trimmed };
  if (/^[a-z0-9]{6}$/.test(trimmed)) return { code: trimmed };
  return null;
}

/** A table's code: its id without the prefix. */
export function tableCode(id: string) {
  return id.slice(2);
}
