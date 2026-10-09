/**
 * Splitting the pot — the arithmetic that decides who gets paid what.
 *
 * This lives here, apart from the table, for one reason: it is the part of
 * the game where a mistake quietly moves somebody's chips to somebody else,
 * and a pure function over numbers can be tested exhaustively while a method
 * on a live Durable Object cannot. scripts/odds.mjs checks it, including that
 * every split conserves the pot to the last chip.
 *
 * ── Side pots ───────────────────────────────────────────────────────
 * A player can only win as much as they put in, matched by each opponent.
 * So the pot is built in layers: every distinct total anybody committed is a
 * level, each level collects what sits above the one below it, and only the
 * players who paid up to that level can win it. A player all-in for 200
 * against two who put in 1'000 contests 600 and no more; the remaining 1'600
 * is a side pot between the other two.
 */

export interface Contribution {
  seat: number;
  /** Everything this player put in over the whole hand. */
  total: number;
  /** Still in the hand at the end: a folded player's chips stay in the pot. */
  live: boolean;
}

export interface Pot {
  amount: number;
  /** Seats that can win this one. */
  seats: number[];
}

export interface Split {
  pots: Pot[];
  /**
   * Chips that were never called by anybody who could win them, back to
   * whoever put them in. See `buildSplit` for when that happens.
   */
  refunds: Map<number, number>;
}

/**
 * The pot, in layers, smallest all-in first — plus whatever has to go back.
 *
 * ── Why anything goes back ──────────────────────────────────────────
 * A layer is only a pot if somebody still in the hand can win it. Bet 500,
 * get called by an all-in for 200, and the top 300 of that bet was never
 * matched by anyone: it is not part of the pot, it is still yours. The same
 * thing happens if the player who put the most in is no longer in the hand —
 * which at a live table means they dropped their connection after betting —
 * and leaving those chips in a pot nobody is eligible for would quietly
 * destroy them.
 *
 * So each layer is checked for an eligible live player. If there is one, it
 * is a pot. If there is not, the layer goes back to the players who paid into
 * it, in the proportions they paid.
 *
 * Between them, the pots and the refunds always account for every chip
 * contributed. scripts/odds.mjs asserts exactly that, over a few hundred
 * thousand random tangles.
 */
export function buildSplit(contributions: readonly Contribution[]): Split {
  const levels = [...new Set(contributions.map((c) => c.total).filter((t) => t > 0))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  const refunds = new Map<number, number>();
  let below = 0;

  for (const level of levels) {
    const paid = contributions.map((c) => Math.max(0, Math.min(c.total, level) - below));
    const amount = paid.reduce((sum, n) => sum + n, 0);
    below = level;
    if (amount <= 0) continue;
    const seats = contributions.filter((c) => c.live && c.total >= level).map((c) => c.seat);
    if (seats.length > 0) {
      pots.push({ amount, seats });
      continue;
    }
    contributions.forEach((c, i) => {
      if (paid[i] > 0) refunds.set(c.seat, (refunds.get(c.seat) ?? 0) + paid[i]);
    });
  }
  return { pots, refunds };
}

/** Just the pots, for the places that only need to show them. */
export function buildPots(contributions: readonly Contribution[]): Pot[] {
  return buildSplit(contributions).pots;
}

/**
 * Shares one pot between its winners.
 *
 * `winners` must already be in order from the dealer's left, because that is
 * what decides the odd chip: a pot of 101 between two players pays 51 to the
 * first of them after the button and 50 to the other. Returned as a list
 * parallel to `winners`, and it always sums to exactly `amount`.
 */
export function sharePot(amount: number, winners: readonly number[]): number[] {
  if (winners.length === 0) return [];
  const share = Math.floor(amount / winners.length);
  let odd = amount - share * winners.length;
  return winners.map(() => {
    const extra = odd > 0 ? 1 : 0;
    if (odd > 0) odd -= 1;
    return share + extra;
  });
}

/**
 * What every seat wins, given the pots, each live hand's score, and the seat
 * order from the dealer's left.
 *
 * Returns a map of seat to chips won. The sum is the whole pot, always.
 */
export function awardPots(pots: readonly Pot[], scores: ReadonlyMap<number, number>, orderFromButton: readonly number[]): Map<number, number> {
  const won = new Map<number, number>();
  for (const pot of pots) {
    const contenders = pot.seats.filter((seat) => scores.has(seat));
    if (contenders.length === 0) continue;
    const best = Math.max(...contenders.map((seat) => scores.get(seat)!));
    const winners = orderFromButton.filter((seat) => contenders.includes(seat) && scores.get(seat) === best);
    const shares = sharePot(pot.amount, winners);
    winners.forEach((seat, i) => won.set(seat, (won.get(seat) ?? 0) + shares[i]));
  }
  return won;
}
