/**
 * The machines — reel strips, paylines, paytables and bonus games, in one place.
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
 * printed below, and so is every bonus game's wheel, coin table and multiplier,
 * so the return is not a claim we make — it is arithmetic anybody can redo.
 * `scripts/rtp.mjs` does exactly that and fails the build if a machine drifts
 * off its stated figure.
 *
 * ── How a round is decided ──────────────────────────────────────────
 * Everything comes out of one committed stream (see fair.ts), in a fixed
 * order: one stop per reel, then — if the window starts a bonus game — every
 * draw that game makes, in the order it makes them. A bought bonus skips the
 * reels and starts drawing for the bonus straight away. Nothing else is
 * random: given the seeds and the spin number, the whole round is fixed,
 * free spins and respins included, and the verifier replays it end to end.
 *
 * ── How a spin is paid ──────────────────────────────────────────────
 * One rule for every machine: a payline pays for the run of identical symbols
 * starting at reel one, and each symbol has a pay per run length. A wild on a
 * reel that has them stands in for whatever the line needs; on these machines
 * it expands to cover its whole reel first. Scatters pay wherever they land,
 * on total stake.
 *
 * ── Versions ────────────────────────────────────────────────────────
 * Every archived round records the version of the machine that dealt it. The
 * version-1 machines (Cherry Press, Nine Window, Night Press) are kept below
 * exactly as they were, so a round they dealt is always checked against their
 * strips — changing a machine must never turn an honest old spin into a lie.
 */

import { open as openStream } from "./fair";

export type MachineId = "cherry" | "window" | "night";

/**
 * Symbols. Ids double as CSS class names, so keep them stable.
 * The first seven are the version-1 machines'; the rest are the planetary set.
 */
export type Pip =
  | "blank"
  | "cherry"
  | "bar"
  | "bell"
  | "star"
  | "seven"
  | "chip"
  | "moon"
  | "comet"
  | "rocket"
  | "ring"
  | "nova"
  | "sun"
  | "portal"
  | "wheel"
  | "coin";

/** Hands out uniform integers: the committed stream in play, a fast generator when the odds are only being checked. */
export interface Source {
  below(n: number): Promise<number>;
}

export interface ScatterRule {
  symbol: Pip;
  /** Pay as a multiple of TOTAL stake, indexed by count − 1. */
  pays: number[];
  /**
   * Version 1 only: free spins awarded, indexed by count − 1, played one by
   * one as separate spins. Version 2 machines run their free spins as a bonus
   * game instead (see FreeRule), so this is all zeros there.
   */
  freeSpins: number[];
}

/** A wild that stands in for any line symbol, on the reels listed, and fills its whole reel when it lands. */
export interface WildRule {
  symbol: Pip;
  /** Reel indices it appears on. Never reel 0: a line starts with a real symbol. */
  reels: number[];
}

/**
 * ORBIT WHEEL — three wheel symbols on the line spin a wheel of prizes.
 *
 * Every prize is a multiple of total stake. Two segments say "up" instead:
 * the pointer moves to the outer ring and spins that, where the prizes are
 * bigger. Each segment is equally likely; the wheel is printed in full.
 */
export interface WheelRule {
  kind: "wheel";
  symbol: Pip;
  /** How many wheel symbols on the line open it. */
  count: number;
  inner: (number | "up")[];
  outer: number[];
}

/**
 * HOLD & WIN — enough coins in the window and they lock in place.
 *
 * Three respins. On each, every empty cell may take a coin; a coin that lands
 * locks too and puts the respins back to three. When the respins run out, or
 * every cell holds a coin, the coins are added up, and a full window adds the
 * Grand on top. Coin values are multiples of total stake.
 */
export interface HoldRule {
  kind: "hold";
  symbol: Pip;
  /** Coins in the window that start it. */
  trigger: number;
  respins: number;
  /** The chance an empty cell takes a coin on a respin: `land[0]` in `land[1]`. */
  land: [number, number];
  values: { value: number; weight: number; name?: string }[];
  /** Paid on top when every cell holds a coin. */
  grand: number;
}

/**
 * FREE SPINS — enough scatters anywhere and the house plays a series for you.
 *
 * Each free spin stakes nothing and is paid at the stake that won it, times a
 * multiplier that starts at 1× and rises by one with every free spin played,
 * up to `maxMultiplier`. The scatters that start the series land during it
 * too, and add more spins, up to `maxSpins` in the whole series.
 */
export interface FreeRule {
  kind: "free";
  symbol: Pip;
  trigger: number;
  spins: number;
  retrigger: number;
  maxSpins: number;
  maxMultiplier: number;
}

export type FeatureRule = WheelRule | HoldRule | FreeRule;

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
  wild?: WildRule;
  feature?: FeatureRule;
  /** What buying the bonus game outright costs, as a multiple of total stake. */
  buy?: number;
  /** How the return is spread: often and small, or rarely and large. */
  volatility?: "low" | "medium" | "high";
  /** Chips per line. Total stake is this times the number of lines. */
  lineBets: number[];
  /**
   * What this machine returns and how often a spin pays, printed on its paytable.
   *
   * Both follow from the strips, pays and bonus tables above, and
   * `scripts/rtp.mjs` recomputes them — the return exactly, the hit rate by
   * walking every stop combination there is — and fails if either has
   * drifted. So the figure on the cabinet is never a claim about the machine;
   * it is a fact about the table beside it.
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
//
// New symbols only ever go on the END of this list. The order breaks ties
// when laying a strip out, and the version-1 strips must come out exactly as
// they always have.

const LAYOUT: Pip[] = ["blank", "cherry", "bar", "bell", "star", "seven", "chip", "moon", "comet", "rocket", "ring", "nova", "sun", "portal", "wheel", "coin"];

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

/** The usual twenty lines on five reels: three straight, then the Vs and the zig-zags. */
const TWENTY_LINES = [
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
];

const FIVE_LINES = [
  [0, 0, 0],
  [1, 1, 1],
  [2, 2, 2],
  [0, 1, 2],
  [2, 1, 0],
];

// ── Version 1 ─────────────────────────────────────────
//
// Kept exactly as they were dealt, for the rounds they dealt. Not on the
// floor any more.

/**
 * CHERRY PRESS — three reels, one line, the machine everyone pictures.
 *
 * Twenty stops a reel, so the odds are readable: a cherry on the first reel is
 * two in twenty, and that is the whole of the small-win business. The one
 * seven on each reel is the 1'000, once in eight thousand spins.
 */
const CHERRY_V1: Machine = {
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
const WINDOW_V1: Machine = {
  id: "window",
  name: "Nine Window",
  caption: "Five lines · Nine symbols",
  blurb: "A three-by-three window with five lines across and through it. Every stop is a symbol, so there is always something to read.",
  version: 1,
  rows: 3,
  lines: FIVE_LINES,
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
const NIGHT_V1: Machine = {
  id: "night",
  name: "Night Press",
  caption: "Twenty lines · Free spins",
  blurb: "Five reels and twenty lines, with the house chip scattered through it. Three chips anywhere and the next eight spins are on the house.",
  version: 1,
  rows: 3,
  lines: TWENTY_LINES,
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

// ── Version 2: the planetary floor ────────────────────

/**
 * LUNAR PRESS — three reels, one line, and the Orbit Wheel.
 *
 * The quiet one. A moon on the first reel pays its stake back, and that is
 * most of what happens; three wheels on the line spin the Orbit Wheel, where
 * every segment pays and two of them send the pointer to the outer ring.
 */
const LUNAR: Machine = {
  id: "cherry",
  name: "Lunar Press",
  caption: "One line · Orbit Wheel",
  blurb: "Three reels and one line under a full moon. Three wheels spin the Orbit Wheel, and two of its segments send you to the outer ring.",
  version: 2,
  volatility: "low",
  rows: 1,
  lines: [[0, 0, 0]],
  reels: [
    strip({ blank: 8, moon: 5, comet: 3, ring: 3, nova: 1, wheel: 4 }),
    strip({ blank: 7, moon: 5, comet: 4, ring: 3, nova: 1, wheel: 4 }),
    strip({ blank: 7, moon: 4, comet: 4, ring: 4, nova: 1, wheel: 4 }),
  ],
  pays: {
    moon: [1, 4, 25],
    comet: [0, 0, 20],
    ring: [0, 0, 40],
    nova: [0, 0, 400],
  },
  feature: {
    kind: "wheel",
    symbol: "wheel",
    count: 3,
    inner: [8, 15, 10, "up", 12, 20, 8, 15, 10, "up", 12, 25],
    outer: [50, 100, 75, 250, 100, 500, 150, 1000],
  },
  buy: 60,
  lineBets: [1, 2, 5, 10, 25, 50, 100],
  rtp: 0.9596836,
  hitRate: 0.21911,
  field: "#cc1259",
  ink: "#fbf1ea",
  dot: "#a90e4a",
};

/**
 * NINE MOONS — three by three, five lines, and Hold & Win.
 *
 * Moon coins land among the symbols, at most one to a reel. One on every reel
 * and they lock: three respins, every new coin locks too and resets the count,
 * and a window full of coins pays the Grand on top of all of them.
 */
const MOONS: Machine = {
  id: "window",
  name: "Nine Moons",
  caption: "Five lines · Hold & Win",
  blurb: "A three-by-three window with five lines. Three moon coins lock in place for three respins, and a full window pays the Grand.",
  version: 2,
  volatility: "medium",
  rows: 3,
  lines: FIVE_LINES,
  reels: [
    strip({ moon: 8, comet: 7, rocket: 6, ring: 3, nova: 2, coin: 2 }),
    strip({ moon: 8, comet: 7, rocket: 6, ring: 3, nova: 2, coin: 2 }),
    strip({ moon: 8, comet: 7, rocket: 6, ring: 3, nova: 2, coin: 2 }),
  ],
  pays: {
    moon: [0, 1, 3],
    comet: [0, 0, 10],
    rocket: [0, 0, 20],
    ring: [0, 0, 45],
    nova: [0, 0, 150],
  },
  feature: {
    kind: "hold",
    symbol: "coin",
    trigger: 3,
    respins: 3,
    land: [1, 12],
    values: [
      { value: 1, weight: 40 },
      { value: 2, weight: 25 },
      { value: 3, weight: 15 },
      { value: 5, weight: 10 },
      { value: 10, weight: 6 },
      { value: 25, weight: 3, name: "Mini" },
      { value: 100, weight: 1, name: "Major" },
    ],
    grand: 500,
  },
  buy: 39,
  lineBets: [1, 2, 5, 10, 25, 50],
  rtp: 0.9600694,
  hitRate: 0.43017,
  field: "#2438b8",
  ink: "#fbf1ea",
  dot: "#1b2a8f",
};

/**
 * SUPERNOVA — five reels, twenty lines, expanding suns and free spins.
 *
 * The wild one. A sun on reels two to four fills its reel and stands in for
 * everything. Three portals — they only land on reels one, three and five —
 * start twelve free spins, each at a multiplier one higher than the last, and
 * three more portals in the series add ten spins more.
 */
const SUPERNOVA: Machine = {
  id: "night",
  name: "Supernova",
  caption: "Twenty lines · Free spins",
  blurb: "Five reels and twenty lines in deep space. Suns fill their reel, and three portals start twelve free spins with a multiplier that climbs every spin.",
  version: 2,
  volatility: "high",
  rows: 3,
  lines: TWENTY_LINES,
  reels: [
    strip({ moon: 10, comet: 8, rocket: 6, ring: 4, nova: 2, portal: 2 }),
    strip({ moon: 10, comet: 9, rocket: 7, ring: 5, nova: 2, sun: 1 }),
    strip({ moon: 10, comet: 8, rocket: 6, ring: 4, nova: 2, sun: 1, portal: 2 }),
    strip({ moon: 10, comet: 9, rocket: 7, ring: 5, nova: 2, sun: 1 }),
    strip({ moon: 10, comet: 8, rocket: 6, ring: 4, nova: 2, portal: 2 }),
  ],
  pays: {
    moon: [0, 0, 1, 4, 15],
    comet: [0, 0, 2, 8, 30],
    rocket: [0, 0, 4, 16, 60],
    ring: [0, 0, 8, 40, 150],
    nova: [0, 0, 20, 100, 500],
  },
  wild: { symbol: "sun", reels: [1, 2, 3] },
  scatter: { symbol: "portal", pays: [0, 0, 3], freeSpins: [0, 0, 0] },
  feature: {
    kind: "free",
    symbol: "portal",
    trigger: 3,
    spins: 12,
    retrigger: 10,
    maxSpins: 50,
    maxMultiplier: 10,
  },
  buy: 54.3,
  lineBets: [1, 2, 5, 10, 25],
  rtp: 0.9601358,
  hitRate: 0.63948,
  field: "#1a060e",
  ink: "#fbf1ea",
  dot: "#3a0c1c",
};

/** The machines on the floor today. */
export const MACHINES: Machine[] = [LUNAR, MOONS, SUPERNOVA];

/** Every machine that has ever dealt a round, so any round can be checked against the strips that dealt it. */
export const ALL_VERSIONS: Machine[] = [CHERRY_V1, WINDOW_V1, NIGHT_V1, LUNAR, MOONS, SUPERNOVA];

export function machineById(id: string): Machine | undefined {
  return MACHINES.find((m) => m.id === id);
}

/** The machine as it was at a given version. Rounds from before versions were recorded are version 1. */
export function machineVersion(id: string, version: number | undefined): Machine | undefined {
  return ALL_VERSIONS.find((m) => m.id === id && m.version === (version ?? 1));
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
  return drawStops(machine, openStream(serverSeed, clientSeed, nonce));
}

async function drawStops(machine: Machine, source: Source): Promise<number[]> {
  const stops: number[] = [];
  for (const reel of machine.reels) stops.push(await source.below(reel.length));
  return stops;
}

/** The symbols on screen: `rows` from each strip, wrapping past the end. */
export function windowAt(machine: Machine, stops: number[]): Pip[][] {
  return machine.reels.map((reel, i) => {
    const stop = ((stops[i] % reel.length) + reel.length) % reel.length;
    return Array.from({ length: machine.rows }, (_, row) => reel[(stop + row) % reel.length]);
  });
}

/** The reels a wild has filled in this window. */
export function expandedReels(machine: Machine, window: Pip[][]): number[] {
  const wild = machine.wild;
  if (!wild) return [];
  return wild.reels.filter((reel) => window[reel]?.includes(wild.symbol));
}

/**
 * What a window is worth.
 *
 * `lineBet` is the stake on each line. On a version-1 machine a free spin
 * passes the same stake with `free` set, which pays normally but stakes
 * nothing and awards nothing further.
 */
export function payOut(machine: Machine, window: Pip[][], lineBet: number, free = false): Omit<Spin, "machine" | "version" | "stops" | "window"> {
  const totalBet = lineBet * machine.lines.length;
  const lines: LineWin[] = [];
  const wilds = new Set(expandedReels(machine, window));
  const wildSymbol = machine.wild?.symbol;
  /** What a line reads on this reel and row: a filled reel reads as wild throughout. */
  const at = (reel: number, row: number): Pip | "wild" => (wilds.has(reel) ? "wild" : window[reel][row]);

  machine.lines.forEach((rows, index) => {
    const first = at(0, rows[0]);
    if (first === "wild" || first === wildSymbol) return;
    const table = machine.pays[first];
    if (!table || first === "blank" || first === machine.scatter?.symbol) return;
    // The run from reel one, and the best pay that run reaches.
    let run = 1;
    while (run < machine.reels.length) {
      const next = at(run, rows[run]);
      if (next !== first && next !== "wild") break;
      run += 1;
    }
    const pays = table[run - 1] ?? 0;
    if (pays > 0) lines.push({ line: index, symbol: first, run, pays: pays * lineBet });
  });

  let scatter: ScatterWin | null = null;
  if (machine.scatter) {
    const symbol = machine.scatter.symbol;
    const count = countOf(window, symbol);
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

function countOf(window: Pip[][], symbol: Pip): number {
  return window.reduce((sum, reel) => sum + reel.filter((pip) => pip === symbol).length, 0);
}

/** Whether this window starts the machine's bonus game. */
export function starts(machine: Machine, window: Pip[][]): boolean {
  const feature = machine.feature;
  if (!feature) return false;
  if (feature.kind === "wheel") return countOf(window, feature.symbol) >= feature.count;
  if (feature.kind === "hold") return countOf(window, feature.symbol) >= feature.trigger;
  return countOf(window, feature.symbol) >= feature.trigger;
}

/** One whole spin of a version-1 machine, from the proof. Version 2 rounds go through `play()`. */
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

// ── Bonus games ───────────────────────────────────────

export interface WheelPlay {
  kind: "wheel";
  /** The inner segment the pointer stopped on. */
  inner: number;
  /** The outer segment, when the inner one said "up". */
  outer: number | null;
  /** The prize, as a multiple of total stake. */
  multiple: number;
  pays: number;
}

/** A coin on the Hold & Win board. `cell` counts down each reel, then along: reel × rows + row. */
export interface Coin {
  cell: number;
  value: number;
}

export interface HoldPlay {
  kind: "hold";
  /** The coins that started it, in the order their values were drawn. */
  start: Coin[];
  /** Each respin, and the coins it landed (none, on a respin that missed). */
  respins: Coin[][];
  full: boolean;
  /** Coins and Grand together, as a multiple of total stake. */
  multiple: number;
  pays: number;
}

export interface FreeSpinPlay {
  stops: number[];
  window: Pip[][];
  lines: LineWin[];
  scatter: ScatterWin | null;
  expanded: number[];
  multiplier: number;
  /** Spins this one added to the series. */
  added: number;
  /** Chips, with the multiplier applied. */
  pays: number;
}

export interface FreePlay {
  kind: "free";
  spins: FreeSpinPlay[];
  pays: number;
}

export type BonusPlay = WheelPlay | HoldPlay | FreePlay;

/** A whole round on a version-2 machine: the reels, and the bonus game they started, if any. */
export interface Round {
  machine: MachineId;
  version: number;
  /** True when the bonus game was bought outright: the reels did not turn. */
  bought: boolean;
  /** Null on a bought round. */
  stops: number[] | null;
  window: Pip[][] | null;
  lines: LineWin[];
  scatter: ScatterWin | null;
  expanded: number[];
  /** What the reels paid, before any bonus game. */
  basePays: number;
  bonus: BonusPlay | null;
  staked: number;
  /** Everything paid back: the reels and the bonus game. */
  returned: number;
}

function weighted(values: { value: number; weight: number }[]): (source: Source) => Promise<number> {
  const total = values.reduce((sum, v) => sum + v.weight, 0);
  return async (source) => {
    let pick = await source.below(total);
    for (const v of values) {
      if (pick < v.weight) return v.value;
      pick -= v.weight;
    }
    return values[values.length - 1].value;
  };
}

async function playWheel(rule: WheelRule, source: Source, totalBet: number): Promise<WheelPlay> {
  const inner = await source.below(rule.inner.length);
  const segment = rule.inner[inner];
  let outer: number | null = null;
  let multiple: number;
  if (segment === "up") {
    outer = await source.below(rule.outer.length);
    multiple = rule.outer[outer];
  } else {
    multiple = segment;
  }
  return { kind: "wheel", inner, outer, multiple, pays: multiple * totalBet };
}

async function playHold(machine: Machine, rule: HoldRule, source: Source, totalBet: number, window: Pip[][] | null): Promise<HoldPlay> {
  const cells = machine.reels.length * machine.rows;
  const drawValue = weighted(rule.values);
  const board = new Map<number, number>();

  // The coins that start it: those in the window, or — bought — the trigger's
  // worth of cells picked by a partial shuffle, so every cell is as likely.
  let startCells: number[];
  if (window) {
    startCells = [];
    window.forEach((reel, r) => reel.forEach((pip, row) => (pip === rule.symbol ? startCells.push(r * machine.rows + row) : null)));
  } else {
    const order = Array.from({ length: cells }, (_, i) => i);
    for (let i = 0; i < rule.trigger; i++) {
      const j = i + (await source.below(cells - i));
      [order[i], order[j]] = [order[j], order[i]];
    }
    startCells = order.slice(0, rule.trigger);
  }
  const start: Coin[] = [];
  for (const cell of startCells) {
    const value = await drawValue(source);
    board.set(cell, value);
    start.push({ cell, value });
  }

  const respins: Coin[][] = [];
  let left = rule.respins;
  while (left > 0 && board.size < cells) {
    const landed: Coin[] = [];
    // Empty cells in order, each with its own draw.
    for (let cell = 0; cell < cells; cell++) {
      if (board.has(cell)) continue;
      if ((await source.below(rule.land[1])) < rule.land[0]) {
        const value = await drawValue(source);
        board.set(cell, value);
        landed.push({ cell, value });
      }
    }
    respins.push(landed);
    left = landed.length > 0 ? rule.respins : left - 1;
  }

  const full = board.size === cells;
  const multiple = [...board.values()].reduce((sum, v) => sum + v, 0) + (full ? rule.grand : 0);
  return { kind: "hold", start, respins, full, multiple, pays: multiple * totalBet };
}

async function playFree(machine: Machine, rule: FreeRule, source: Source, lineBet: number): Promise<FreePlay> {
  const spins: FreeSpinPlay[] = [];
  let awarded = rule.spins;
  let played = 0;
  while (played < awarded) {
    const multiplier = Math.min(rule.maxMultiplier, played + 1);
    const stops = await drawStops(machine, source);
    const window = windowAt(machine, stops);
    const paid = payOut(machine, window, lineBet, true);
    const added = countOf(window, rule.symbol) >= rule.trigger ? Math.min(rule.retrigger, rule.maxSpins - awarded) : 0;
    awarded += added;
    spins.push({
      stops,
      window,
      lines: paid.lines,
      scatter: paid.scatter,
      expanded: expandedReels(machine, window),
      multiplier,
      added,
      pays: paid.returned * multiplier,
    });
    played += 1;
  }
  return { kind: "free", spins, pays: spins.reduce((sum, s) => sum + s.pays, 0) };
}

/** Plays the machine's bonus game out of the stream, from the window that started it (null when bought). */
async function playBonus(machine: Machine, source: Source, lineBet: number, window: Pip[][] | null): Promise<BonusPlay> {
  const rule = machine.feature!;
  const totalBet = lineBet * machine.lines.length;
  if (rule.kind === "wheel") return playWheel(rule, source, totalBet);
  if (rule.kind === "hold") return playHold(machine, rule, source, totalBet, window);
  return playFree(machine, rule, source, lineBet);
}

/** What buying this machine's bonus costs at a given line stake, in chips. Null when it can't be bought. */
export function buyPrice(machine: Machine, lineBet: number): number | null {
  // `buy` may be a fraction of total stake (54.3×) as long as it comes out in
  // whole chips per line stake; rounding only clears floating-point dust.
  return machine.buy ? Math.round(machine.buy * machine.lines.length * 1000) / 1000 * lineBet : null;
}

/**
 * One round on a version-2 machine, out of any source of draws.
 *
 * This is the whole game: the machine room plays it from the committed
 * stream, the verifier replays it from the published seed, and the odds
 * script plays it a few hundred thousand times from a fast generator to make
 * sure the code pays what the arithmetic says it pays.
 */
export async function play(machine: Machine, source: Source, lineBet: number, bought = false): Promise<Round> {
  const totalBet = lineBet * machine.lines.length;
  if (bought) {
    if (!machine.buy || !machine.feature) throw new Error("this machine's bonus cannot be bought");
    const bonus = await playBonus(machine, source, lineBet, null);
    return {
      machine: machine.id,
      version: machine.version,
      bought: true,
      stops: null,
      window: null,
      lines: [],
      scatter: null,
      expanded: [],
      basePays: 0,
      bonus,
      staked: buyPrice(machine, lineBet)!,
      returned: bonus.pays,
    };
  }
  const stops = await drawStops(machine, source);
  const window = windowAt(machine, stops);
  const paid = payOut(machine, window, lineBet);
  const bonus = starts(machine, window) ? await playBonus(machine, source, lineBet, window) : null;
  return {
    machine: machine.id,
    version: machine.version,
    bought: false,
    stops,
    window,
    lines: paid.lines,
    scatter: paid.scatter,
    expanded: expandedReels(machine, window),
    basePays: paid.returned,
    bonus,
    staked: totalBet,
    returned: paid.returned + (bonus?.pays ?? 0),
  };
}

/** A round from the proof. This is the function the verifier replays. */
export function playFromSeed(machine: Machine, serverSeed: string, clientSeed: string, nonce: number, lineBet: number, bought = false): Promise<Round> {
  return play(machine, openStream(serverSeed, clientSeed, nonce), lineBet, bought);
}

// ── Words ─────────────────────────────────────────────

const PLURAL: Partial<Record<Pip, string>> = {
  cherry: "cherries",
  bar: "bars",
  bell: "bells",
  star: "stars",
  seven: "sevens",
  chip: "chips",
  moon: "moons",
  comet: "comets",
  rocket: "rockets",
  ring: "rings",
  nova: "novas",
  portal: "portals",
  wheel: "wheels",
  coin: "moon coins",
};

const WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/**
 * One line a person can read without opening the log: "Three sevens", "Nothing".
 *
 * Twenty lines can pay at once, and naming only the best of them beside a total
 * that came from all of them would read as though the best one paid the lot. So
 * when more than one line pays, the line says so.
 */
export function describe(machine: Machine, result: Pick<Spin, "lines" | "scatter">): string {
  const best = [...result.lines].sort((a, b) => b.pays - a.pays)[0];
  const parts: string[] = [];
  if (best) {
    const name = best.run === 1 ? best.symbol : PLURAL[best.symbol] ?? best.symbol;
    parts.push(`${WORDS[best.run]} ${name}`);
    if (result.lines.length > 1) parts.push(`${result.lines.length} lines`);
  }
  if (result.scatter?.count) parts.push(`${WORDS[result.scatter.count]} ${PLURAL[result.scatter.symbol] ?? result.scatter.symbol}`);
  return parts.length ? parts.join(", ") : "Nothing";
}

/** The bonus game in a few words: "Orbit Wheel, 25×", "Hold & Win, full window". */
export function describeBonus(bonus: BonusPlay): string {
  if (bonus.kind === "wheel") return `Orbit Wheel ${bonus.outer !== null ? "outer ring " : ""}${bonus.multiple}×`;
  if (bonus.kind === "hold") return `Hold & Win${bonus.full ? ", full window" : ""} ${bonus.multiple}×`;
  return `${bonus.spins.length} free spins`;
}

/** A whole round in one line. */
export function describeRound(machine: Machine, round: Round): string {
  const base = round.bought ? "Bonus bought" : describe(machine, round);
  if (!round.bonus) return base;
  return base === "Nothing" ? describeBonus(round.bonus) : `${base} · ${describeBonus(round.bonus)}`;
}

/** 1'000 — Swiss grouping, formatted by hand so server and browser agree. */
export function formatChips(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

// ── The odds, computed rather than claimed ────────────
//
// Everything below is exact arithmetic over the strips and tables above — no
// simulation. Each reel stop is uniform, and stops are independent between
// reels, so a line's odds are a product of per-reel chances. What a reel
// shows on one row is not independent of what it shows on the others (the
// window is consecutive stops), so wherever that matters — scatters, and a
// wild that fills its reel — the reel is walked stop by stop first, and only
// then are the reels combined.
//
// The bonus games are exact too. The wheel is an average. Hold & Win is a
// small chain over (coins on the board, respins left): each empty cell takes a
// coin independently, so the number that land is binomial, and coin values are
// drawn independently of where or when they land, so the board is worth the
// expected number of coins times the expected coin. Free spins are a chain
// over (spins played, spins left): the multiplier is fixed by how many have
// been played, so each spin is worth its multiplier times one spin's average.

/** What one reel shows on one row, as a line reads it: a symbol, or "wild" when a wild has filled the reel. */
type Token = Pip | "wild";

/**
 * How often each token shows on a given row of a reel, walking every stop.
 * `only` restricts the walk to stops whose window does (true) or does not
 * (false) hold a given symbol, as a fraction of ALL stops.
 */
function rowTokens(machine: Machine, reelIndex: number, row: number): Map<Token, number> {
  const reel = machine.reels[reelIndex];
  const wild = machine.wild && machine.wild.reels.includes(reelIndex) ? machine.wild.symbol : null;
  const out = new Map<Token, number>();
  for (let stop = 0; stop < reel.length; stop++) {
    let token: Token = reel[(stop + row) % reel.length];
    if (wild) {
      for (let r = 0; r < machine.rows; r++) if (reel[(stop + r) % reel.length] === wild) token = "wild";
    }
    out.set(token, (out.get(token) ?? 0) + 1 / reel.length);
  }
  return out;
}

/** How many of a symbol each reel's window can show, and how often — combined across the reels. */
export function countDistribution(machine: Machine, symbol: Pip): number[] {
  let distribution = [1];
  for (const reel of machine.reels) {
    const perReel = new Map<number, number>();
    for (let stop = 0; stop < reel.length; stop++) {
      let n = 0;
      for (let row = 0; row < machine.rows; row++) if (reel[(stop + row) % reel.length] === symbol) n += 1;
      perReel.set(n, (perReel.get(n) ?? 0) + 1 / reel.length);
    }
    const next = new Array<number>(distribution.length + machine.rows).fill(0);
    distribution.forEach((p, had) => perReel.forEach((q, got) => (next[had + got] += p * q)));
    distribution = next;
  }
  return distribution;
}

/** The average wheel prize, as a multiple of total stake. */
export function wheelValue(rule: WheelRule): number {
  const outer = rule.outer.reduce((sum, v) => sum + v, 0) / rule.outer.length;
  return rule.inner.reduce<number>((sum, v) => sum + (v === "up" ? outer : v), 0) / rule.inner.length;
}

function binomial(n: number, k: number, p: number): number {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c * p ** k * (1 - p) ** (n - k);
}

/**
 * Hold & Win from a board with `coins` on it and every respin to come:
 * the expected number of coins at the end, and the chance the board fills.
 */
export function holdOutcome(machine: Machine, rule: HoldRule, coins: number): { coins: number; full: number } {
  const cells = machine.reels.length * machine.rows;
  const p = rule.land[0] / rule.land[1];
  const memo = new Map<string, { coins: number; full: number }>();
  const from = (filled: number, left: number): { coins: number; full: number } => {
    if (filled === cells) return { coins: cells, full: 1 };
    if (left === 0) return { coins: filled, full: 0 };
    const key = `${filled}:${left}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const empty = cells - filled;
    let coinsOut = 0;
    let fullOut = 0;
    for (let k = 0; k <= empty; k++) {
      const chance = binomial(empty, k, p);
      const next = k > 0 ? from(filled + k, rule.respins) : from(filled, left - 1);
      coinsOut += chance * next.coins;
      fullOut += chance * next.full;
    }
    const result = { coins: coinsOut, full: fullOut };
    memo.set(key, result);
    return result;
  };
  return from(coins, rule.respins);
}

/** Hold & Win's worth from a board with `coins` on it, as a multiple of total stake. */
export function holdValue(machine: Machine, rule: HoldRule, coins: number): number {
  const total = rule.values.reduce((sum, v) => sum + v.weight, 0);
  const coin = rule.values.reduce((sum, v) => sum + (v.value * v.weight) / total, 0);
  const end = holdOutcome(machine, rule, coins);
  return end.coins * coin + end.full * rule.grand;
}

/**
 * A series of free spins, as a multiple of total stake.
 *
 * `spinValue` is one spin's average return on total stake and `retrigger` the
 * chance one spin adds more spins. Walked backwards over (spins played, spins
 * left): the multiplier only depends on how many have been played, so a spin's
 * worth is its multiplier times the average, plus whatever the rest is worth.
 */
export function freeValue(rule: FreeRule, spinValue: number, retrigger: number): number {
  const memo = new Map<string, number>();
  const from = (played: number, left: number): number => {
    if (left === 0) return 0;
    const key = `${played}:${left}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const multiplier = Math.min(rule.maxMultiplier, played + 1);
    const awarded = played + left;
    const added = Math.min(rule.retrigger, rule.maxSpins - awarded);
    const value =
      multiplier * spinValue + retrigger * from(played + 1, left - 1 + added) + (1 - retrigger) * from(played + 1, left - 1);
    memo.set(key, value);
    return value;
  };
  return from(0, rule.spins);
}

export interface Odds {
  /** Expected return as a fraction of total stake. The stated figure. */
  rtp: number;
  /** The lines' share of it, the scatter's, and the bonus game's. */
  lineRtp: number;
  scatterRtp: number;
  bonusRtp: number;
  /** The chance that any one given line pays. */
  perLineHit: number;
  /** Version 1: expected free spins per paid spin. */
  freeSpins: number;
  /** The chance a spin starts the bonus game, and what the game is worth on average, as a multiple of total stake. */
  bonusChance: number;
  bonusValue: number;
  /** What buying the bonus returns, when it can be bought. */
  buyRtp: number | null;
  /** What each paying combination contributes to the return. */
  bySymbol: { symbol: Pip; run: number; chance: number; pays: number; share: number }[];
}

export function oddsOf(machine: Machine): Odds {
  const scatterSymbol = machine.scatter?.symbol;
  const bySymbol: Odds["bySymbol"] = [];
  let lineRtp = 0;
  let perLineHit = 0;

  // Per reel and row, what a line reads there.
  const tokens = machine.reels.map((_, reel) => Array.from({ length: machine.rows }, (_, row) => rowTokens(machine, reel, row)));
  const combined = new Map<string, { symbol: Pip; run: number; chance: number; pays: number }>();

  for (const rows of machine.lines) {
    for (const [symbol, table] of Object.entries(machine.pays) as [Pip, number[]][]) {
      if (symbol === "blank" || symbol === scatterSymbol) continue;
      for (let run = 1; run <= machine.reels.length; run++) {
        const pays = table[run - 1] ?? 0;
        // The chance of a run of EXACTLY this length: the symbol on reel one,
        // the symbol or a wild on the next `run − 1` reels, and neither on the
        // reel after (if there is one).
        let chance = tokens[0][rows[0]].get(symbol) ?? 0;
        for (let reel = 1; reel < run; reel++) {
          const t = tokens[reel][rows[reel]];
          chance *= (t.get(symbol) ?? 0) + (t.get("wild") ?? 0);
        }
        if (run < machine.reels.length) {
          const t = tokens[run][rows[run]];
          chance *= 1 - (t.get(symbol) ?? 0) - (t.get("wild") ?? 0);
        }
        if (chance === 0 || pays === 0) continue;
        const key = `${symbol}:${run}`;
        const row = combined.get(key) ?? { symbol, run, chance: 0, pays };
        // Averaged over the lines: every line costs the same, so the machine's
        // figure is the average line's.
        row.chance += chance / machine.lines.length;
        combined.set(key, row);
        lineRtp += (chance * pays) / machine.lines.length;
        // Runs of different symbols, and of different lengths, cannot both
        // happen on one line — so these add rather than compound.
        perLineHit += chance / machine.lines.length;
      }
    }
  }
  for (const row of combined.values()) bySymbol.push({ ...row, share: row.chance * row.pays });

  let scatterRtp = 0;
  let freeSpins = 0;
  if (machine.scatter) {
    countDistribution(machine, machine.scatter.symbol).forEach((p, count) => {
      scatterRtp += p * (machine.scatter!.pays[count - 1] ?? 0);
      freeSpins += p * (machine.scatter!.freeSpins[count - 1] ?? 0);
    });
  }

  const perSpin = lineRtp + scatterRtp;
  let bonusChance = 0;
  let bonusValue = 0;
  let bonusRtp = 0;
  let buyValue = 0;
  const rule = machine.feature;
  if (rule) {
    const counts = countDistribution(machine, rule.symbol);
    if (rule.kind === "wheel") {
      bonusChance = counts.slice(rule.count).reduce((a, b) => a + b, 0);
      bonusValue = buyValue = wheelValue(rule);
      bonusRtp = bonusChance * bonusValue;
    } else if (rule.kind === "hold") {
      counts.forEach((p, n) => {
        if (n < rule.trigger) return;
        bonusChance += p;
        bonusRtp += p * holdValue(machine, rule, n);
      });
      bonusValue = bonusChance ? bonusRtp / bonusChance : 0;
      buyValue = holdValue(machine, rule, rule.trigger);
    } else {
      bonusChance = counts.slice(rule.trigger).reduce((a, b) => a + b, 0);
      // Free spins play the same reels, so one free spin is worth one spin,
      // and the chance one adds spins is the chance one starts the series.
      bonusValue = buyValue = freeValue(rule, perSpin, bonusChance);
      bonusRtp = bonusChance * bonusValue;
    }
  }

  return {
    // Version 1: a free spin stakes nothing and pays like a paid one, so the
    // expected free spins simply multiply the return of a single spin.
    rtp: perSpin * (1 + freeSpins) + bonusRtp,
    lineRtp: lineRtp * (1 + freeSpins),
    scatterRtp: scatterRtp * (1 + freeSpins),
    bonusRtp,
    perLineHit,
    freeSpins,
    bonusChance,
    bonusValue,
    buyRtp: machine.buy && rule ? buyValue / machine.buy : null,
    bySymbol: bySymbol.sort((a, b) => b.share - a.share),
  };
}
