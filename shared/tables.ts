/**
 * What a table is: its blinds, its buy-in, whether the house keeps it alive
 * with bots, and whether the lobby lists it.
 *
 * ── Why a buy-in, and not just the wallet ───────────────────────────
 * Blackjack bets straight out of the casino wallet: the seat's stack *is* the
 * balance, and that works because every hand is settled against the dealer
 * before the next one starts. Poker cannot do that. The size of the stack in
 * front of you is the game — it decides what you can be raised off, what an
 * all-in costs, and how much of your hand you can defend. A player who could
 * reach into their pocket mid-hand would be playing something else.
 *
 * So sitting down moves chips out of the wallet and onto the table, leaving
 * is what moves them back, and between those two moments the wallet is not
 * part of the hand. See the escrow note in party/table.ts for how those chips
 * survive a worker eviction, which is the part that actually matters.
 */

import { formatChips } from "./protocol";

export interface Stakes {
  /** Small blind. */
  sb: number;
  /** Big blind. The table's unit: the minimum bet and the minimum raise. */
  bb: number;
  /** What a seat buys in for, and tops back up to. */
  buyIn: number;
}

export interface TableConfig {
  stakes: Stakes;
  /** The house fills empty seats so a table is playable the moment someone arrives. */
  bots: boolean;
}

export interface HouseTable {
  /** A table id like any other, so casino presence and invites can point at it. */
  id: string;
  name: string;
  stakes: Stakes;
}

/**
 * The stakes a table can be opened at. A buy-in of 100 big blinds is the
 * standard stack at a cash table, and it is what every one of these is.
 */
export const STAKE_LEVELS: readonly Stakes[] = [
  { sb: 5, bb: 10, buyIn: 1_000 },
  { sb: 10, bb: 20, buyIn: 2_000 },
  { sb: 50, bb: 100, buyIn: 10_000 },
  { sb: 250, bb: 500, buyIn: 50_000 },
  { sb: 1_000, bb: 2_000, buyIn: 200_000 },
];

/** Tables that predate a stored config keep the stakes every table used to have. */
export const DEFAULT_STAKES: Stakes = { sb: 10, bb: 20, buyIn: 2_000 };

/**
 * The house tables: always in the lobby, never closed, and never empty —
 * each one fills its spare seats with bots, so a player who arrives alone at
 * four in the morning still gets a hand. A bot gives its seat up to the next
 * human who sits down.
 *
 * The ids keep the `t-` plus six characters every table id has, and contain
 * an "o", which the random ids never use, so no player's table can be handed
 * one of these by chance.
 */
export const HOUSE_TABLES: readonly HouseTable[] = [
  { id: "t-house1", name: "Table 1", stakes: { sb: 10, bb: 20, buyIn: 2_000 } },
  { id: "t-house2", name: "Table 2", stakes: { sb: 50, bb: 100, buyIn: 10_000 } },
  { id: "t-house3", name: "Table 3", stakes: { sb: 250, bb: 500, buyIn: 50_000 } },
];

export function houseTable(id: string): HouseTable | null {
  return HOUSE_TABLES.find((t) => t.id === id) ?? null;
}

/** Whether these are stakes a table may be opened at. Anything else is refused. */
export function knownStakes(stakes: unknown): Stakes | null {
  if (!stakes || typeof stakes !== "object") return null;
  const { sb, bb } = stakes as Partial<Stakes>;
  return STAKE_LEVELS.find((level) => level.sb === sb && level.bb === bb) ?? null;
}

/** "Blinds 10 / 20". */
export function describeStakes(stakes: Stakes) {
  return `Blinds ${formatChips(stakes.sb)} / ${formatChips(stakes.bb)}`;
}

/** "10 / 20", for a lobby row where the word "blinds" is already in the header. */
export function shortStakes(stakes: Stakes) {
  return `${formatChips(stakes.sb)} / ${formatChips(stakes.bb)}`;
}

/**
 * The smallest raise allowed over the current bet.
 *
 * A raise has to be at least as big as the last one, and at least one big
 * blind when there has not been a raise yet. Going all-in for less is always
 * allowed — that is a short all-in, not a raise, and it does not reopen the
 * betting.
 */
export function minRaiseTo(curBet: number, lastRaise: number, bb: number) {
  return curBet + Math.max(lastRaise, bb);
}

/** Checks a raise a player asked for. Returns the problem, or null if it stands. */
export function raiseProblem(to: unknown, curBet: number, lastRaise: number, bb: number, stack: number, committed: number): string | null {
  if (typeof to !== "number" || !Number.isInteger(to)) return "A raise is a whole number of chips.";
  const most = committed + stack;
  if (to > most) return "You don't have that many chips.";
  // All-in for less than a full raise is always allowed.
  if (to === most) return null;
  const least = minRaiseTo(curBet, lastRaise, bb);
  if (to < least) return `The smallest raise here is ${formatChips(least)}.`;
  return null;
}

/** "5'000", "5 000" and "5000" all mean five thousand. Null when it isn't a number at all. */
export function readChips(text: string): number | null {
  const digits = text.replace(/['’\s]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : null;
}
