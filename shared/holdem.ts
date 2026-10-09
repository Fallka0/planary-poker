/**
 * The hand evaluator: the one piece of this game that must not be approximate.
 *
 * Every hand is reduced to a single integer, so comparing two hands is `>`
 * rather than a pile of special cases:
 *
 *     score = category·16⁵ + k₁·16⁴ + k₂·16³ + k₃·16² + k₄·16 + k₅
 *
 * Category 0 is high card and 8 is a straight flush; the kickers follow in the
 * order that decides the hand. Because every rank fits in four bits, the
 * digits never collide and a plain numeric comparison settles any two hands
 * correctly, including which of two identical two-pairs wins on the fifth
 * card. A royal flush is a straight-flush to the ace; it gets its own
 * category (9) only when the hand is *named*, never when it is compared.
 *
 * Ported from the handoff prototype without changing the arithmetic, so the
 * odds printed in the side panel are the odds the table actually deals.
 * scripts/odds.mjs checks it against every distinct five-card hand.
 */

import { type Card, capitalise, rankWord, rankPlural } from "./cards";

/** Hand categories, as the integer above encodes them. */
export const HIGH_CARD = 0;
export const PAIR = 1;
export const TWO_PAIR = 2;
export const TRIPS = 3;
export const STRAIGHT = 4;
export const FLUSH = 5;
export const FULL_HOUSE = 6;
export const QUADS = 7;
export const STRAIGHT_FLUSH = 8;
/** Not a category the evaluator produces — only a name for the best straight flush. */
export const ROYAL_FLUSH = 9;

const CATEGORY_SHIFT = 16 ** 5;

/**
 * Scores exactly five cards.
 *
 * Hot path: called twenty-one times per seven-card hand, and a few hundred
 * thousand times per equity run, so it allocates one small array and nothing
 * else.
 */
export function score5(hand: readonly Card[]): number {
  const r = [hand[0].r, hand[1].r, hand[2].r, hand[3].r, hand[4].r].sort((a, b) => b - a);
  const suit = hand[0].s;
  const flush = hand[1].s === suit && hand[2].s === suit && hand[3].s === suit && hand[4].s === suit;

  // A straight needs five distinct ranks spanning four, or the wheel, whose
  // ace plays low and whose high card is therefore the five.
  let straight = 0;
  if (r[0] !== r[1] && r[1] !== r[2] && r[2] !== r[3] && r[3] !== r[4]) {
    if (r[0] - r[4] === 4) straight = r[0];
    else if (r[0] === 14 && r[1] === 5) straight = 5;
  }

  // Ranks grouped by how many of each, biggest group first, then highest rank:
  // this single ordering gives the kickers for pairs, trips, quads and boats.
  const groups: [count: number, rank: number][] = [];
  for (let i = 0; i < 5; ) {
    let j = i;
    while (j < 5 && r[j] === r[i]) j++;
    groups.push([j - i, r[i]]);
    i = j;
  }
  groups.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const byGroup = groups.map((g) => g[1]);

  if (straight && flush) return encode(STRAIGHT_FLUSH, [straight]);
  if (groups[0][0] === 4) return encode(QUADS, byGroup);
  if (groups[0][0] === 3 && groups[1][0] === 2) return encode(FULL_HOUSE, byGroup);
  if (flush) return encode(FLUSH, r);
  if (straight) return encode(STRAIGHT, [straight]);
  if (groups[0][0] === 3) return encode(TRIPS, byGroup);
  if (groups[0][0] === 2 && groups[1][0] === 2) return encode(TWO_PAIR, byGroup);
  if (groups[0][0] === 2) return encode(PAIR, byGroup);
  return encode(HIGH_CARD, r);
}

function encode(category: number, kickers: readonly number[]): number {
  let value = category;
  for (let i = 0; i < 5; i++) value = value * 16 + (kickers[i] || 0);
  return value;
}

/** The 5-card subsets of an n-card hand, computed once per size. */
const COMBOS = new Map<number, number[][]>();

export function combinations(n: number): number[][] {
  const known = COMBOS.get(n);
  if (known) return known;
  const out: number[][] = [];
  const pick: number[] = [];
  const walk = (start: number) => {
    if (pick.length === 5) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i < n; i++) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  COMBOS.set(n, out);
  return out;
}

/** The score of the best five of however many cards. The equity loop's inner call. */
export function bestScore(cards: readonly Card[]): number {
  if (cards.length === 5) return score5(cards);
  let best = -1;
  const sets = combinations(cards.length);
  for (let k = 0; k < sets.length; k++) {
    const c = sets[k];
    const value = score5([cards[c[0]], cards[c[1]], cards[c[2]], cards[c[3]], cards[c[4]]]);
    if (value > best) best = value;
  }
  return best;
}

/** The best five cards themselves, for ringing the winning hand at showdown. */
export function bestHand(cards: readonly Card[]): { score: number; cards: Card[] } {
  let score = -1;
  let hand: Card[] = [];
  for (const combo of combinations(cards.length)) {
    const five = combo.map((i) => cards[i]);
    const value = score5(five);
    if (value > score) {
      score = value;
      hand = five;
    }
  }
  return { score, cards: hand };
}

export interface HandName {
  /** The category as a player would rank it: 9 for a royal flush. */
  category: number;
  title: string;
  detail: string;
}

/** Reads a score back into words: "Two pair", "Kings and fives". */
export function describe(score: number): HandName {
  const category = Math.floor(score / CATEGORY_SHIFT);
  const kickers: number[] = [];
  let rest = score % CATEGORY_SHIFT;
  for (let i = 4; i >= 0; i--) {
    kickers[i] = rest % 16;
    rest = Math.floor(rest / 16);
  }
  const high = (r: number) => `${capitalise(rankWord(r))} high`;

  switch (category) {
    case STRAIGHT_FLUSH:
      return kickers[0] === 14
        ? { category: ROYAL_FLUSH, title: "Royal flush", detail: "Ace to ten, one suit" }
        : { category, title: "Straight flush", detail: high(kickers[0]) };
    case QUADS:
      return { category, title: "Four of a kind", detail: `Four ${rankPlural(kickers[0])}` };
    case FULL_HOUSE:
      return { category, title: "Full house", detail: `${capitalise(rankPlural(kickers[0]))} full of ${rankPlural(kickers[1])}` };
    case FLUSH:
      return { category, title: "Flush", detail: high(kickers[0]) };
    case STRAIGHT:
      return { category, title: "Straight", detail: high(kickers[0]) };
    case TRIPS:
      return { category, title: "Three of a kind", detail: `Three ${rankPlural(kickers[0])}` };
    case TWO_PAIR:
      return { category, title: "Two pair", detail: `${capitalise(rankPlural(kickers[0]))} and ${rankPlural(kickers[1])}` };
    case PAIR:
      return { category, title: "Pair", detail: `Pair of ${rankPlural(kickers[0])}` };
    default:
      return { category: HIGH_CARD, title: "High card", detail: high(kickers[0]) };
  }
}

/**
 * Names two hole cards on their own, before any board exists.
 *
 * Preflop there is no five-card hand to score, and calling A-K "high card"
 * the way the evaluator would is useless to the player holding it. So the
 * two cards are named the way players name them.
 */
export function describeHole(hole: readonly Card[]): HandName {
  if (hole.length < 2) return { category: HIGH_CARD, title: "—", detail: "" };
  const [high, low] = hole[0].r >= hole[1].r ? [hole[0], hole[1]] : [hole[1], hole[0]];
  if (high.r === low.r) return { category: PAIR, title: "Pair", detail: `Pocket ${rankPlural(high.r)}` };
  return {
    category: HIGH_CARD,
    title: "High card",
    detail: `${capitalise(rankWord(high.r))}-${rankWord(low.r)} ${high.s === low.s ? "suited" : "offsuit"}`,
  };
}

/** What your cards are worth right now: the hole cards alone preflop, the best five after that. */
export function nameHand(hole: readonly Card[], board: readonly Card[]): HandName | null {
  if (hole.length < 2) return null;
  if (board.length === 0) return describeHole(hole);
  return describe(bestScore([...hole, ...board]));
}

/** The ten categories with an example each, for the side panel's rankings list. */
export const HAND_RANKINGS: readonly { category: number; name: string; example: string }[] = [
  { category: ROYAL_FLUSH, name: "Royal flush", example: "A K Q J 10" },
  { category: STRAIGHT_FLUSH, name: "Straight flush", example: "9 8 7 6 5" },
  { category: QUADS, name: "Four of a kind", example: "Q Q Q Q 4" },
  { category: FULL_HOUSE, name: "Full house", example: "J J J 7 7" },
  { category: FLUSH, name: "Flush", example: "K 10 8 5 3" },
  { category: STRAIGHT, name: "Straight", example: "8 7 6 5 4" },
  { category: TRIPS, name: "Three of a kind", example: "6 6 6 K 2" },
  { category: TWO_PAIR, name: "Two pair", example: "A A 9 9 3" },
  { category: PAIR, name: "Pair", example: "10 10 K 7 4" },
  { category: HIGH_CARD, name: "High card", example: "A J 8 5 2" },
];
