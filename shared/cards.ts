/**
 * Cards, and the deal nobody has to take on trust.
 *
 * A rank is a number (2–14, ace high) rather than a character, because the
 * hand evaluator in holdem.ts compares ranks a few million times a minute
 * when the bots are thinking. The wire and the archive use the two-character
 * code instead — "As", "Td" — so a hand history reads like a hand history.
 *
 * ── Why the deal is committed per hand ──────────────────────────────
 * Blackjack commits to a whole six-deck shoe and reveals the seed when the
 * shoe is retired, because the cards keep coming out of the same shoe. A
 * Hold'em deck is shuffled fresh for every hand, so the commitment can be
 * per hand and the seed can be published the moment that hand is over.
 * A player can check the hand they just played, not the one they played
 * twenty minutes ago.
 *
 * The price is that revealing a hand's deck reveals every hole card in it,
 * including the ones that were mucked. That is a real cost — at a real table
 * a fold stays private — and it is the reason the reveal waits for the end of
 * the hand rather than happening while the betting is live. Nobody ever
 * learns a card they could still act on. What they learn afterwards is what a
 * provable deal costs, and the table says so plainly rather than quietly
 * keeping the seed.
 */

import { shuffle } from "./fair";

export type Suit = "s" | "h" | "d" | "c";

/** 11 = jack, 12 = queen, 13 = king, 14 = ace. Aces are high everywhere except the wheel (A-2-3-4-5). */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  r: Rank;
  s: Suit;
}

/** How a card is written down everywhere outside the evaluator: "As", "10h", "2c". */
export type CardCode = string;

export const SUITS: readonly Suit[] = ["s", "h", "d", "c"];
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const SUIT_INDEX: Record<Suit, number> = { s: 0, h: 1, d: 2, c: 3 };

export const SUIT_NAMES: Record<Suit, string> = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };
export const SUIT_GLYPHS: Record<Suit, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

export function isRed(card: Card) {
  return card.s === "h" || card.s === "d";
}

/** "A", "K", "Q", "J", "10", "9"… — what the corner of the card says. */
export function rankLabel(r: Rank | number): string {
  return r === 14 ? "A" : r === 13 ? "K" : r === 12 ? "Q" : r === 11 ? "J" : String(r);
}

/** One card as a unique small integer, for "have I used this card" sets. */
export function cardKey(card: Card): number {
  return card.r * 4 + SUIT_INDEX[card.s];
}

export function code(card: Card): CardCode {
  return `${rankLabel(card.r)}${card.s}`;
}

export function parseCode(text: CardCode): Card | null {
  const match = /^(10|[2-9]|[AKQJ])([shdc])$/.exec(text.trim());
  if (!match) return null;
  const [, rank, suit] = match;
  const r = rank === "A" ? 14 : rank === "K" ? 13 : rank === "Q" ? 12 : rank === "J" ? 11 : (Number(rank) as Rank);
  return { r: r as Rank, s: suit as Suit };
}

/** A card as a person reads it: A♠, 10♥. */
export function prettyCard(card: Card): string {
  return `${rankLabel(card.r)}${SUIT_GLYPHS[card.s]}`;
}

/**
 * The deck in factory order, before anybody shuffles it.
 *
 * This order is part of the proof: a verifier that built its 52 cards in a
 * different order would reconstruct a different deck from the same seed and
 * call an honest hand a lie. So it lives here, in the one file both the table
 * and the checker import, and scripts/odds.mjs pins it down.
 */
export function orderedDeck(): Card[] {
  const cards: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) cards.push({ r, s });
  return cards;
}

/** The deck as the table shuffled it, from a seed it committed to before dealing. */
export async function shuffledDeck(serverSeed: string, clientSeed: string, nonce: number): Promise<Card[]> {
  return shuffle(orderedDeck(), serverSeed, clientSeed, nonce);
}

/**
 * Checks that a hand's cards are the ones the committed deck had to produce.
 *
 * Cards come off the front of the shuffled deck in dealing order, so the
 * record only has to say which cards came out, in order, and the whole deal —
 * hole cards, burns and board — can be replayed from the seed.
 */
export type DealCheck =
  | { ok: true }
  | { ok: false; reason: "sealed" | "hash mismatch" | "cards do not match"; at?: number; expected?: CardCode; got?: CardCode };

export function checkDeal(deck: Card[], drawn: readonly CardCode[]): DealCheck {
  for (let i = 0; i < drawn.length; i++) {
    const expected = deck[i] ? code(deck[i]) : "";
    if (expected !== drawn[i]) return { ok: false, reason: "cards do not match", at: i, expected, got: drawn[i] };
  }
  return { ok: true };
}

// ── Words for ranks, used by the hand descriptions ───

const SINGULAR: Record<number, string> = {
  14: "ace",
  13: "king",
  12: "queen",
  11: "jack",
  10: "ten",
  9: "nine",
  8: "eight",
  7: "seven",
  6: "six",
  5: "five",
  4: "four",
  3: "three",
  2: "two",
};

export function rankWord(r: number) {
  return SINGULAR[r] ?? String(r);
}

/** "sixes", not "sixs". */
export function rankPlural(r: number) {
  return r === 6 ? "sixes" : `${rankWord(r)}s`;
}

export function capitalise(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
