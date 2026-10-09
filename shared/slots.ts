/**
 * The machines — reel strips, paylines and paytables, in one place.
 *
 * ── Canonical copy ──────────────────────────────────────────────────
 * Lives at planary-casino/shared/slots.ts and is copied into the game by
 * `scripts/sync-fair.sh`. Never edit a copy: the machine and the verifier
 * have to agree on every stop and every pay, or an honest spin reads as a lie.
 *
 * ── Why the strips live here, in the open ───────────────────────────
 * A slot machine is the one casino game where the player normally cannot see
 * the odds. The reels are a black box: you are told the symbols, never how
 * many of each are on the strip, so you cannot work out what anything is
 * worth. That is the whole trick, and this file refuses it. Every strip is
 * printed below, so the return is not a claim we make — it is arithmetic
 * anybody can redo. `scripts/rtp.mjs` does exactly that and fails the build
 * if a machine drifts off its stated figure.
 *
 * ── How a spin is decided ───────────────────────────────────────────
 * One stop per reel, drawn in order from the committed stream (see fair.ts).
 * A stop is an index into that reel's strip; the window shows `rows` symbols
 * from it, wrapping round the end. Nothing else is random: given the seeds and
 * the spin number, the screen is fixed.
 *
 * ── How a spin is paid ──────────────────────────────────────────────
 * One rule for all three machines: a payline pays for the run of identical
 * symbols starting at reel one, and each symbol has a pay per run length.
 * That is how a classic machine's lone cherry, two cherries and three cherries
 * are all the same rule, and it is why nothing here needs a special case.
 * Scatters are the exception: they pay wherever they land, on total stake.
 */

import { open as openStream } from "./fair";

export type MachineId = "cherry" | "window" | "night";

/** Symbols, ranked low to high. Ids double as CSS class names, so keep them stable. */
export type Pip = "blank" | "cherry" | "bar" | "bell" | "star" | "seven" | "chip";

export interface ScatterRule {
  symbol: Pip;
  /** Pay as a multiple of TOTAL stake, indexed by count − 1. */
  pays: number[];
  /** Free spins awarded, indexed by count − 1. A free spin stakes nothing and awards none. */
  freeSpins: number[];
}

export interface Machine {
  id: MachineId;
  name: string;
  /** The line printed under the name on the cabinet. */
  caption: string;
  /** One sentence on what makes this one different. */
  blurb: string;
  /**
   * Frozen with the strips. Every archived round records it, so a round
   * dealt by version 1 is always checked against version 1's strips.
   */
  version: number;
  /** One strip per reel, in stop order. */
  reels: Pip[][];
  /** Visible rows. */
  rows: number;
  /** Each payline as the row it takes from each reel. */
  lines: number[][];
  /** Pay as a multiple of the LINE stake, indexed by run length − 1. */
  pays: Partial<Record<Pip, number[]>>;
  scatter?: ScatterRule;
  /** Chips per line. Total stake is this times the number of lines. */
  lineBets: number[];
  /**
   * What this machine returns and how often it pays, printed on its paytable.
   *
   * Both follow from the strips and pays above, and `scripts/rtp.mjs` recomputes
   * them — the return exactly, the hit rate by walking every stop combination
   * there is — and fails if either has drifted. So the figure on the cabinet is
   * never a claim about the machine; it is a fact about the table beside it.
   */
  rtp: number;
  hitRate: number;
  /** The field and ink this cabinet is printed in. */
  field: string;
  ink: string;
  /** The halftone dot, a shade off the field. */
  dot: string;
}

// ── Strips ────────────────────────────────────────────
//
// Written out as counts rather than literal arrays: a strip is a bag of
// symbols, and `strip()` lays it out in a fixed order so the same counts
// always produce the same strip. The order within a strip never matters to
// the odds — each stop is equally likely — but it has to be settled, because
// the stop index is part of the proof.

const LAYOUT: Pip[] = ["blank", "cherry", "bar", "bell", "star", "seven", "chip"];

function strip(counts: Partial<Record<Pip, number>>): Pip[] {
  const out: Pip[] = [];
  // Interleaved rather than clumped: nine blanks in a row would look broken
  // spinning past, and a player watching the strip should see it as a strip.
  const bags = LAYOUT.filter((pip) => (counts[pip] ?? 0) > 0).map((pip) => ({ pip, left: counts[pip] as number }));
  const total = bags.reduce((sum, bag) => sum + bag.left, 0);
  for (let i = 0; i < total; i++) {
    // Take from whichever bag is furthest behind its share of the strip.
    let pick = bags[0];
    let worst = -Infinity;
    for (const bag of bags) {
      if (bag.left === 0) continue;
      const debt = bag.left / (total - i);
      if (debt > worst) {
        worst = debt;
        pick = bag;
      }
    }
    pick.left -= 1;
    out.push(pick.pip);
  }
  return out;
}

/**
 * CHERRY PRESS — three reels, one line, the machine everyone pictures.
 *
 * Twenty stops a reel, so the odds are readable: a cherry on the first reel is
 * two in twenty, and that is the whole of the small-win business. The one
 * seven on each reel is the 1'000, once in eight thousand spins.
 */
const CHERRY: Machine = {
  id: "cherry",
  name: "Cherry Press",
  caption: "One line · One lever",
  blurb: "Three reels and a single centre line, the way the first machines did it. A lone cherry still pays.",
  version: 1,
  rows: 1,
  lines: [[0, 0, 0]],
  reels: [
    strip({ blank: 11, cherry: 2, bar: 4, bell: 2, seven: 1 }),
    strip({ blank: 9, cherry: 3, bar: 5, bell: 2, seven: 1 }),
    strip({ blank: 9, cherry: 2, bar: 5, bell: 3, seven: 1 }),
  ],
  pays: {
    cherry: [2, 5, 50],
    bar: [0, 2, 25],
    bell: [0, 0, 90],
    seven: [0, 0, 1000],
  },
  lineBets: [1, 2, 5, 10, 25, 50, 100],
  rtp: 0.96,
  hitRate: 0.15163,
  field: "#cc1259",
  ink: "#fbf1ea",
  dot: "#a90e4a",
};

/**
 * NINE WINDOW — three reels, three rows, five lines.
 *
 * No blanks: every stop is a symbol, so something lands on all five lines
 * every spin and the machine is read as a grid rather than a row. Pays are
 * per line, so five lines cost five times one.
 */
const WINDOW: Machine = {
  id: "window",
  name: "Nine Window",
  caption: "Five lines · Nine symbols",
  blurb: "A three-by-three window with five lines across and through it. Every stop is a symbol, so there is always something to read.",
  version: 1,
  rows: 3,
  lines: [
    [0, 0, 0],
    [1, 1, 1],
    [2, 2, 2],
    [0, 1, 2],
    [2, 1, 0],
  ],
  reels: [
    strip({ cherry: 6, bar: 5, bell: 4, star: 3, seven: 2 }),
    strip({ cherry: 6, bar: 5, bell: 4, star: 3, seven: 2 }),
    strip({ cherry: 6, bar: 5, bell: 4, star: 3, seven: 2 }),
  ],
  pays: {
    cherry: [0, 1, 5],
    bar: [0, 0, 12],
    bell: [0, 0, 25],
    star: [0, 0, 52],
    seven: [0, 0, 200],
  },
  lineBets: [1, 2, 5, 10, 25, 50],
  rtp: 0.961,
  hitRate: 0.44337,
  field: "#2438b8",
  ink: "#fbf1ea",
  dot: "#1b2a8f",
};

/**
 * NIGHT PRESS — five reels, three rows, twenty lines, and the chip.
 *
 * The modern shape: runs of three, four and five from the left, and a scatter
 * that pays wherever it falls and hands back free spins. A free spin stakes
 * nothing and cannot award more free spins — the round ends, rather than
 * running off into a series nobody can price.
 */
const NIGHT: Machine = {
  id: "night",
  name: "Night Press",
  caption: "Twenty lines · Free spins",
  blurb: "Five reels and twenty lines, with the house chip scattered through it. Three chips anywhere and the next eight spins are on the house.",
  version: 1,
  rows: 3,
  // Three straight, then the Vs and the zig-zags: the usual twenty, written out.
  lines: [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0],
    [2, 1, 0, 1, 2],
    [0, 0, 1, 0, 0],
    [2, 2, 1, 2, 2],
    [1, 2, 2, 2, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 1, 0, 1],
    [1, 2, 1, 2, 1],
    [0, 1, 1, 1, 0],
    [2, 1, 1, 1, 2],
    [0, 1, 0, 1, 0],
    [2, 1, 2, 1, 2],
    [1, 1, 0, 1, 1],
    [1, 1, 2, 1, 1],
    [0, 0, 1, 2, 2],
    [2, 2, 1, 0, 0],
    [0, 2, 0, 2, 0],
  ],
  reels: [
    strip({ cherry: 8, bar: 7, bell: 6, star: 4, seven: 3, chip: 2 }),
    strip({ cherry: 8, bar: 7, bell: 6, star: 4, seven: 3, chip: 2 }),
    strip({ cherry: 8, bar: 7, bell: 6, star: 5, seven: 3, chip: 1 }),
    strip({ cherry: 9, bar: 7, bell: 6, star: 4, seven: 3, chip: 1 }),
    strip({ cherry: 9, bar: 7, bell: 6, star: 4, seven: 3, chip: 1 }),
  ],
  pays: {
    cherry: [0, 0, 3, 13, 50],
    bar: [0, 0, 7, 25, 100],
    bell: [0, 0, 10, 40, 180],
    star: [0, 0, 25, 100, 500],
    seven: [0, 0, 65, 300, 1300],
  },
  scatter: {
    symbol: "chip",
    pays: [0, 0, 2, 10, 50],
    freeSpins: [0, 0, 8, 12, 20],
  },
  lineBets: [1, 2, 5, 10, 25],
  rtp: 0.9604206,
  hitRate: 0.48328,
  field: "#1a060e",
  ink: "#fbf1ea",
  dot: "#3a0c1c",
};

export const MACHINES: Machine[] = [CHERRY, WINDOW, NIGHT];

export function machineById(id: string): Machine | undefined {
  return MACHINES.find((m) => m.id === id);
}

/** The house edge every machine here is built to, stated plainly. */
export const TARGET_RTP = 0.96;

// ── A spin ────────────────────────────────────────────

export interface LineWin {
  /** Index into `machine.lines`. */
  line: number;
  symbol: Pip;
  run: number;
  /** Chips, already multiplied by the line stake. */
  pays: number;
}

export interface ScatterWin {
  symbol: Pip;
  count: number;
  /** Chips, on total stake. */
  pays: number;
  freeSpins: number;
}

export interface Spin {
  machine: MachineId;
  version: number;
  /** One stop per reel: an index into that reel's strip. */
  stops: number[];
  /** What the window shows, reel by reel, top row first. */
  window: Pip[][];
  lines: LineWin[];
  scatter: ScatterWin | null;
  /** Chips staked on this spin: lineBet × lines, or 0 on a free spin. */
  staked: number;
  /** Chips paid back. */
  returned: number;
  freeSpins: number;
}

/** Where each reel stopped, from the seed the machine committed to beforehand. */
export async function stopsFor(machine: Machine, serverSeed: string, clientSeed: string, nonce: number): Promise<number[]> {
  const stream = openStream(serverSeed, clientSeed, nonce);
  const stops: number[] = [];
  for (const reel of machine.reels) stops.push(await stream.below(reel.length));
  return stops;
}

/** The symbols on screen: `rows` from each strip, wrapping past the end. */
export function windowAt(machine: Machine, stops: number[]): Pip[][] {
  return machine.reels.map((reel, i) => {
    const stop = ((stops[i] % reel.length) + reel.length) % reel.length;
    return Array.from({ length: machine.rows }, (_, row) => reel[(stop + row) % reel.length]);
  });
}

/**
 * What a window is worth.
 *
 * `lineBet` is the stake on each line; a free spin passes the same stake with
 * `free` set, which pays normally but stakes nothing and awards nothing further.
 */
export function payOut(machine: Machine, window: Pip[][], lineBet: number, free = false): Omit<Spin, "machine" | "version" | "stops" | "window"> {
  const totalBet = lineBet * machine.lines.length;
  const lines: LineWin[] = [];

  machine.lines.forEach((rows, index) => {
    const first = window[0][rows[0]];
    const table = machine.pays[first];
    if (!table || first === "blank" || first === machine.scatter?.symbol) return;
    // The run from reel one, and the best pay that run reaches.
    let run = 1;
    while (run < machine.reels.length && window[run][rows[run]] === first) run += 1;
    const pays = table[run - 1] ?? 0;
    if (pays > 0) lines.push({ line: index, symbol: first, run, pays: pays * lineBet });
  });

  let scatter: ScatterWin | null = null;
  if (machine.scatter) {
    const symbol = machine.scatter.symbol;
    const count = window.reduce((sum, reel) => sum + reel.filter((pip) => pip === symbol).length, 0);
    const pays = (machine.scatter.pays[count - 1] ?? 0) * totalBet;
    const freeSpins = free ? 0 : machine.scatter.freeSpins[count - 1] ?? 0;
    if (pays > 0 || freeSpins > 0) scatter = { symbol, count, pays, freeSpins };
  }

  return {
    lines,
    scatter,
    staked: free ? 0 : totalBet,
    returned: lines.reduce((sum, win) => sum + win.pays, 0) + (scatter?.pays ?? 0),
    freeSpins: scatter?.freeSpins ?? 0,
  };
}

/** One whole spin, from the proof. This is the function the verifier replays. */
export async function spin(
  machine: Machine,
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  lineBet: number,
  free = false,
): Promise<Spin> {
  const stops = await stopsFor(machine, serverSeed, clientSeed, nonce);
  const window = windowAt(machine, stops);
  return { machine: machine.id, version: machine.version, stops, window, ...payOut(machine, window, lineBet, free) };
}

/**
 * One line a person can read without opening the log: "Three sevens", "Nothing".
 *
 * Twenty lines can pay at once, and naming only the best of them beside a total
 * that came from all of them would read as though the best one paid the lot. So
 * when more than one line pays, the line says so.
 */
export function describe(machine: Machine, result: Pick<Spin, "lines" | "scatter">): string {
  const best = [...result.lines].sort((a, b) => b.pays - a.pays)[0];
  const words = ["", "One", "Two", "Three", "Four", "Five"];
  const plural: Partial<Record<Pip, string>> = { cherry: "cherries", bar: "bars", bell: "bells", star: "stars", seven: "sevens", chip: "chips" };
  const parts: string[] = [];
  if (best) {
    const name = best.run === 1 ? best.symbol : plural[best.symbol] ?? best.symbol;
    parts.push(`${words[best.run]} ${name}`);
    if (result.lines.length > 1) parts.push(`${result.lines.length} lines`);
  }
  if (result.scatter?.count) parts.push(`${words[result.scatter.count]} chips`);
  return parts.length ? parts.join(", ") : "Nothing";
}

/** 1'000 — Swiss grouping, formatted by hand so server and browser agree. */
export function formatChips(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

// ── The odds, computed rather than claimed ────────────
//
// Everything below is exact arithmetic over the strips above — no simulation.
// Each reel stop is uniform, and stops are independent between reels, so a
// line's odds are a product of per-reel symbol frequencies. Scatters are the
// one awkward case: two cells on the same reel are a window of consecutive
// stops and therefore not independent, so that reel's contribution is counted
// by walking all of its stops, and the reels are then combined.

/** How often each symbol shows on one cell of this reel. */
function frequency(reel: Pip[]): Map<Pip, number> {
  const counts = new Map<Pip, number>();
  for (const pip of reel) counts.set(pip, (counts.get(pip) ?? 0) + 1);
  return new Map([...counts].map(([pip, n]) => [pip, n / reel.length]));
}

export interface Odds {
  /** Expected return as a fraction of total stake. The stated figure. */
  rtp: number;
  /** The lines' share of it, and the scatter's. */
  lineRtp: number;
  scatterRtp: number;
  /** The chance that any one given line pays. */
  perLineHit: number;
  /** Expected free spins per paid spin. */
  freeSpins: number;
  /** What each paying combination contributes to the return. */
  bySymbol: { symbol: Pip; run: number; chance: number; pays: number; share: number }[];
}

export function oddsOf(machine: Machine): Odds {
  const freqs = machine.reels.map(frequency);
  const scatterSymbol = machine.scatter?.symbol;
  const bySymbol: Odds["bySymbol"] = [];
  let lineRtp = 0;
  let perLineHit = 0;

  for (const [symbol, table] of Object.entries(machine.pays) as [Pip, number[]][]) {
    if (symbol === "blank" || symbol === scatterSymbol) continue;
    for (let run = 1; run <= machine.reels.length; run++) {
      const pays = table[run - 1] ?? 0;
      // The chance of a run of EXACTLY this length: the symbol on the first
      // `run` reels, and not on the next one (if there is a next one).
      let chance = 1;
      for (let reel = 0; reel < run; reel++) chance *= freqs[reel].get(symbol) ?? 0;
      if (run < machine.reels.length) chance *= 1 - (freqs[run].get(symbol) ?? 0);
      if (chance === 0 || pays === 0) continue;
      bySymbol.push({ symbol, run, chance, pays, share: chance * pays });
      lineRtp += chance * pays;
      // Runs of different symbols, and of different lengths, cannot both
      // happen on one line — so these add rather than compound.
      perLineHit += chance;
    }
  }

  let scatterRtp = 0;
  let freeSpins = 0;
  if (machine.scatter) {
    // How many scatters each reel's window can show, and how often.
    let distribution = [1];
    for (const reel of machine.reels) {
      const perReel = new Map<number, number>();
      for (let stop = 0; stop < reel.length; stop++) {
        let n = 0;
        for (let row = 0; row < machine.rows; row++) if (reel[(stop + row) % reel.length] === machine.scatter.symbol) n += 1;
        perReel.set(n, (perReel.get(n) ?? 0) + 1 / reel.length);
      }
      const next = new Array<number>(distribution.length + machine.rows).fill(0);
      distribution.forEach((p, had) => perReel.forEach((q, got) => (next[had + got] += p * q)));
      distribution = next;
    }
    distribution.forEach((p, count) => {
      scatterRtp += p * (machine.scatter!.pays[count - 1] ?? 0);
      freeSpins += p * (machine.scatter!.freeSpins[count - 1] ?? 0);
    });
  }

  // Every line sees the same per-cell frequencies, so every line returns the
  // same — which makes the per-line figure the figure on total stake, whether
  // the machine has one line or twenty.
  const perSpin = lineRtp + scatterRtp;
  return {
    // A free spin stakes nothing and pays like a paid one, so the expected
    // free spins simply multiply the return of a single spin.
    rtp: perSpin * (1 + freeSpins),
    lineRtp: lineRtp * (1 + freeSpins),
    scatterRtp: scatterRtp * (1 + freeSpins),
    perLineHit,
    freeSpins,
    bySymbol: bySymbol.sort((a, b) => b.share - a.share),
  };
}
