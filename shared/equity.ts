/**
 * How often a hand wins, by dealing it out a few hundred times.
 *
 * There is no closed form for "ace-king on a nine-high flop against three
 * players", so the table simulates: fill the board, give every opponent two
 * random cards from what is left, see who wins, repeat. Ties split, so a
 * three-way chop counts as a third of a win rather than nothing.
 *
 * ── What this is not ────────────────────────────────────────────────
 * This never touches the committed deck. It draws from the cards the player
 * holding the hand cannot see, in a random order of its own, which is the
 * only honest way to do it: a simulation that peeked at the real deck would
 * be telling the bots what is coming. `Math.random` is right here for the
 * same reason it would be wrong in the deal — nothing is being dealt.
 *
 * The sim counts are a deliberate trade. 220 runs put the answer within
 * roughly a point and a half, which is the difference between "61%" and
 * "62%" on a number that moves by ten when the next card lands — and it
 * costs about a millisecond. The bots get 90, because five of them think on
 * every street and nobody is reading their percentage.
 */

import { type Card, cardKey, orderedDeck } from "./cards";
import { bestScore } from "./holdem";

/** Runs for the player's own win chance: fewer when there are more hands to deal out. */
export function simsForOpponents(opponents: number) {
  return opponents >= 4 ? 120 : 220;
}

/** Runs behind one bot's decision. */
export const BOT_SIMS = 90;

/**
 * The share of the pot this hand wins on average, from 0 to 1.
 *
 * `opponents` is how many hands it is up against; above four the count is
 * worth capping by the caller, since each one costs a full seven-card
 * evaluation per run and the answer barely moves.
 */
export function equity(hole: readonly Card[], board: readonly Card[], opponents: number, sims: number): number {
  if (opponents < 1) return 1;
  if (hole.length < 2) return 0;

  const seen = new Set<number>();
  for (const card of hole) seen.add(cardKey(card));
  for (const card of board) seen.add(cardKey(card));
  const deck = orderedDeck().filter((c) => !seen.has(cardKey(c)));

  // A Hold'em board is five cards. Clamping rather than trusting it keeps a
  // caller's mistake from reading past the end of the deck and throwing in
  // the middle of a deal: the hand is still scored, from every card given.
  const needed = Math.max(0, 5 - board.length);
  const draw = needed + 2 * opponents;
  if (draw > deck.length) return 0;

  let won = 0;
  for (let run = 0; run < sims; run++) {
    // Partial Fisher–Yates: only the cards this run uses are shuffled into
    // place, which is the whole saving over shuffling 45 cards each time.
    for (let i = 0; i < draw; i++) {
      const j = i + Math.floor(Math.random() * (deck.length - i));
      const swap = deck[i];
      deck[i] = deck[j];
      deck[j] = swap;
    }
    const full = needed ? [...board, ...deck.slice(0, needed)] : board;
    const mine = bestScore([...hole, ...full]);

    let ties = 0;
    let lost = false;
    for (let o = 0; o < opponents; o++) {
      const theirs = bestScore([deck[needed + 2 * o], deck[needed + 2 * o + 1], ...full]);
      if (theirs > mine) {
        lost = true;
        break;
      }
      if (theirs === mine) ties++;
    }
    if (!lost) won += 1 / (ties + 1);
  }
  return won / sims;
}
