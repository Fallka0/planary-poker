/**
 * The shoe — one definition, shared by the table that deals it and the page
 * that checks it.
 *
 * ── Canonical copy ──────────────────────────────────────────────────
 * Lives at planary-casino/shared/deck.ts and is copied into each game by
 * `scripts/sync-fair.sh`. Never edit a copy.
 *
 * The order the decks are laid out in before shuffling is part of the proof:
 * a verifier that built its 312 cards in a different order would reconstruct a
 * different shoe from the same seed and call an honest hand a lie. So the
 * factory order lives here rather than in either side, and the frozen vectors
 * in fair.vectors.json pin it down.
 */

import { open as openStream, shuffle } from "./fair";

export const SUITS = ["spade", "heart", "diamond", "club"] as const;
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

/** Six decks, as in a Swiss casino's blackjack shoe. */
export const DECKS = 6;

/** How a card is written down everywhere: rank then suit, e.g. "Aspade", "10heart". */
export type CardCode = string;

export function cardCode(rank: string, suit: string): CardCode {
  return `${rank}${suit}`;
}

/** A card as a person reads it: A♠, 10♥. */
export function prettyCard(code: CardCode): string {
  const pips: Record<string, string> = { spade: "♠", heart: "♥", diamond: "♦", club: "♣" };
  const match = /^(.+?)(spade|heart|diamond|club)$/.exec(code);
  return match ? `${match[1]}${pips[match[2]]}` : code;
}

/** The decks in factory order, before anybody shuffles them. */
export function orderedShoe(decks = DECKS): CardCode[] {
  const cards: CardCode[] = [];
  for (let d = 0; d < decks; d++) for (const suit of SUITS) for (const rank of RANKS) cards.push(cardCode(rank, suit));
  return cards;
}

/** The shoe as the table shuffled it, from a seed it committed to beforehand. */
export async function shuffledShoe(serverSeed: string, clientSeed: string, nonce: number, decks = DECKS): Promise<CardCode[]> {
  return shuffle(orderedShoe(decks), serverSeed, clientSeed, nonce);
}

/**
 * Where the cut card sits: 60–80 cards from the back, so 74–81% of a six-deck
 * shoe is dealt. Drawn from its own stream, so it cannot be read off the
 * shuffle — but from the same seed, so where the shoe ends is settled in
 * advance rather than chosen by the house.
 */
export async function cutCardFor(serverSeed: string, clientSeed: string, nonce: number): Promise<number> {
  return 60 + (await openStream(serverSeed, `${clientSeed}:cut`, nonce).below(21));
}

export type CardCheck =
  | { ok: true; from: number; cards: CardCode[] }
  | { ok: false; reason: "sealed" | "hash mismatch" | "cards do not match"; expected?: CardCode[]; got?: CardCode[]; at?: number };

/**
 * Checks that a round's cards are the ones the committed shoe had to produce.
 *
 * `from` is the shoe position the round's first card came off, and `drawn` is
 * every card the table pulled, in the order it pulled them. Both are recorded
 * when the round is filed, which is what makes a hand checkable at all: the
 * cards alone would not say what order they left the shoe in.
 */
export function checkCards(shoe: CardCode[], from: number, drawn: CardCode[]): CardCheck {
  for (let i = 0; i < drawn.length; i++) {
    const expected = shoe[from + i];
    if (expected !== drawn[i]) {
      return { ok: false, reason: "cards do not match", expected: shoe.slice(from, from + drawn.length), got: drawn, at: i };
    }
  }
  return { ok: true, from, cards: drawn };
}
