/**
 * Provable fairness — the commitment scheme every Planary table runs on.
 *
 * ── Canonical copy ──────────────────────────────────────────────────
 * This file lives at planary-casino/shared/fair.ts and is copied
 * verbatim into each game by `scripts/sync-fair.sh`. Never edit a copy:
 * every project checks itself against the same vectors in fair.vectors.json,
 * and a table whose arithmetic has drifted from the verifier would produce
 * rounds that cannot be verified — which is worse than no scheme at all.
 *
 * ── The problem it solves ───────────────────────────────────────────
 * "The wheel is fair" is a promise. A player cannot check a promise. This
 * turns each round into something they can recompute for themselves, in
 * their own browser, without trusting anything we say.
 *
 * ── How ─────────────────────────────────────────────────────────────
 * 1. Before betting opens, the table draws a server seed and publishes
 *    only its SHA-256 hash. It is now committed: the seed cannot change
 *    without the hash changing.
 * 2. While betting is open, players may each contribute a client seed.
 *    The table publishes the ordered list when betting closes.
 * 3. The outcome is derived from both, by HMAC-SHA256.
 * 4. Afterwards the table reveals the server seed. Anyone can hash it to
 *    check it matches the commitment, then replay step 3.
 *
 * Neither side can steer the result: the house committed before it saw the
 * players' seeds, and the players chose before they saw the house's seed.
 * That property is the whole point, and it is why the order of the steps
 * above is not negotiable.
 *
 * A single-seat game has exactly the same shape; the player is simply the
 * only contributor.
 */

const encoder = new TextEncoder();

/** Bytes as lower-case hex — the form every seed and hash is written in. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) throw new Error("not hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A fresh server seed: 32 bytes from the platform's cryptographic generator. */
export function newServerSeed(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** The commitment published before a round: the hash of the seed, nothing else. */
export async function commit(serverSeed: string): Promise<string> {
  return sha256Hex(serverSeed);
}

/** True when this seed is the one that was committed to. */
export async function opens(serverSeed: string, hash: string): Promise<boolean> {
  return (await commit(serverSeed)) === hash.trim().toLowerCase();
}

/**
 * Every contributed client seed, in the order the table accepted them,
 * folded into one string. Order is part of the record: a different order
 * is a different outcome, so the table publishes the list, not a set.
 */
export function joinClientSeeds(seeds: readonly string[]): string {
  return seeds.map((s) => sanitiseClientSeed(s)).join("|");
}

/** Client seeds are player-supplied, so they are bounded and stripped of the separator. */
export function sanitiseClientSeed(seed: string): string {
  return String(seed ?? "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\|/g, "/")
    .trim()
    .slice(0, 64);
}

/**
 * An endless, reproducible byte stream keyed by the server seed.
 *
 * HMAC-SHA256 gives 32 bytes at a time; when those run out the block
 * counter advances. Deriving everything from one stream means a round that
 * needs many numbers — a shuffled shoe, say — is still one commitment.
 */
class Stream {
  private readonly key: Promise<CryptoKey>;
  private readonly message: string;
  private buffer = new Uint8Array(0);
  private position = 0;
  private block = 0;

  constructor(serverSeed: string, message: string) {
    this.message = message;
    this.key = crypto.subtle.importKey("raw", encoder.encode(serverSeed) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }

  private async refill() {
    const key = await this.key;
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${this.message}:${this.block}`) as BufferSource);
    this.buffer = new Uint8Array(signature);
    this.position = 0;
    this.block += 1;
  }

  /** The next four bytes as an unsigned 32-bit integer. */
  async next32(): Promise<number> {
    if (this.position + 4 > this.buffer.length) await this.refill();
    const b = this.buffer;
    const p = this.position;
    this.position += 4;
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  }

  /**
   * A uniform integer in [0, n).
   *
   * Rejection sampling, not modulo: taking `x % 37` from a 32-bit draw would
   * make some pockets very slightly likelier than others, and a wheel that is
   * almost fair is exactly what this whole file exists to rule out.
   */
  async below(n: number): Promise<number> {
    if (!Number.isInteger(n) || n < 1) throw new Error("range must be a positive integer");
    if (n === 1) return 0;
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    for (;;) {
      const draw = await this.next32();
      if (draw < limit) return draw % n;
    }
  }
}

/** Opens the stream a round is played out of. */
export function open(serverSeed: string, clientSeed: string, nonce: number): Stream {
  return new Stream(serverSeed, `${clientSeed}:${nonce}`);
}

/** One number in [0, n) — a roulette pocket, a die, a coin. */
export async function roll(serverSeed: string, clientSeed: string, nonce: number, n: number): Promise<number> {
  return open(serverSeed, clientSeed, nonce).below(n);
}

/**
 * Fisher–Yates, drawn from the stream: the shuffled order of a shoe.
 *
 * The caller commits to the seed before the first card is dealt, so the whole
 * shoe is fixed in advance and the reveal at the end of the shoe proves every
 * hand in it at once.
 */
export async function shuffle<T>(items: readonly T[], serverSeed: string, clientSeed: string, nonce: number): Promise<T[]> {
  const stream = open(serverSeed, clientSeed, nonce);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = await stream.below(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Everything a player needs to check a round, and nothing they need to trust. */
export interface Proof {
  /** Published before betting opened. */
  hash: string;
  /** Revealed afterwards; null while the round or shoe is still sealed. */
  serverSeed: string | null;
  /** The contributed seeds, joined in the order the table accepted them. */
  clientSeed: string;
  nonce: number;
}

export type Check =
  | { ok: true; outcome: number }
  | { ok: false; reason: "sealed" | "hash mismatch" | "outcome mismatch"; outcome?: number };

/**
 * Re-runs a single-number round from its proof. Used by the verifier page,
 * and by the tests that keep every copy of this file honest.
 */
export async function checkRoll(proof: Proof, range: number, claimed: number): Promise<Check> {
  if (!proof.serverSeed) return { ok: false, reason: "sealed" };
  if (!(await opens(proof.serverSeed, proof.hash))) return { ok: false, reason: "hash mismatch" };
  const outcome = await roll(proof.serverSeed, proof.clientSeed, proof.nonce, range);
  return outcome === claimed ? { ok: true, outcome } : { ok: false, reason: "outcome mismatch", outcome };
}
