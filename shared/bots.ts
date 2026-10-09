/**
 * The house players.
 *
 * They exist so a table is never dead on arrival: a player who opens
 * poker.planary.ch alone at four in the morning gets a hand, not a lobby
 * saying "waiting for players". Bots sit only at house tables, and a bot
 * gives its seat up to the next human who wants it.
 *
 * ── What they know ──────────────────────────────────────────────────
 * Their own two cards, the board, the betting, and how many hands are still
 * live. Nothing else. `decide` is deliberately given no access to anyone
 * else's hole cards — not as a courtesy, but because a bot that could see
 * them would be a cheat the code made easy to write. The table calls this
 * with a bot's own seat and the public state, and there is nothing else to
 * pass it.
 *
 * ── How they play ───────────────────────────────────────────────────
 * Each one estimates its equity by simulation (shared/equity.ts), compares it
 * to the share a hand would have if every live hand were equal — 1/(n+1) —
 * and to the pot odds it is being offered. Aggression scales the first
 * comparison, so the same cards are a raise for Mika and a call for Juno.
 * It is not a solver and is not meant to be: it folds the bad ones, pays the
 * right price for the drawing ones, raises the good ones, and bluffs about
 * one time in twenty.
 *
 * Ported from the handoff prototype with the numbers unchanged.
 */

import type { Card } from "./cards";
import { BOT_SIMS, equity } from "./equity";

export interface BotProfile {
  name: string;
  initial: string;
  /** Avatar background. */
  av: string;
  /** Avatar ink. */
  avFg: string;
  /** How much it talks itself into a hand. 1 is neutral. */
  aggression: number;
}

export const BOTS: readonly BotProfile[] = [
  { name: "Mika", initial: "M", av: "#ff5b2e", avFg: "#2a0710", aggression: 1.25 },
  { name: "Juno", initial: "J", av: "#23308f", avFg: "#fbf1ea", aggression: 0.85 },
  { name: "Ravi", initial: "R", av: "#e8c7a2", avFg: "#2a0710", aggression: 1.05 },
  { name: "Lea", initial: "L", av: "#b3122e", avFg: "#fbf1ea", aggression: 1.15 },
  { name: "Otto", initial: "O", av: "#1d1846", avFg: "#fbf1ea", aggression: 0.9 },
];

/** Bot player ids are their own namespace, so they can never collide with `u-` accounts. */
export function botPlayerId(name: string) {
  return `b-${name.toLowerCase()}`;
}

export function isBotId(playerId: string) {
  return playerId.startsWith("b-");
}

/** How long a bot appears to think. Long enough to read, short enough not to wait on. */
export function botThinkMs(fast = false) {
  return fast ? 380 : 700 + Math.random() * 600;
}

/** At most this many raises on one street, so three bots cannot raise each other forever. */
export const MAX_RAISES_PER_STREET = 4;

export interface BotView {
  hole: Card[];
  board: Card[];
  /** Chips this bot already has out on this street. */
  bet: number;
  stack: number;
  /** The bet to match. */
  curBet: number;
  /** Size of the last raise, which sets the smallest legal one. */
  lastRaise: number;
  bb: number;
  /** Everything already in the middle, including this street's bets. */
  pot: number;
  /** Live hands other than this one. */
  opponents: number;
  /** How many others could still act, so a bet can actually be called. */
  canRespond: number;
  /** Raises already made on this street. */
  raises: number;
  aggression: number;
}

export type BotAction = { type: "fold" } | { type: "check" } | { type: "call" } | { type: "raise"; to: number };

export function decide(view: BotView): BotAction {
  const toCall = view.curBet - view.bet;
  const most = view.bet + view.stack;

  // Simulating more than four opponents costs a full evaluation each and
  // barely moves the answer, so the count is capped rather than the hand
  // being mis-read as hopeless at a full table.
  const eq = equity(view.hole, view.board, Math.min(view.opponents, 4), BOT_SIMS);
  const fairShare = 1 / (view.opponents + 1);
  const strength = eq * view.aggression;
  const roll = Math.random();
  const canRaise = view.canRespond > 0 && view.raises < MAX_RAISES_PER_STREET && most > view.curBet;

  /** A bet or raise sized as a fraction of the pot, rounded to tens and capped by the stack. */
  const sizeTo = (fraction: number) =>
    Math.min(
      most,
      view.curBet === 0
        ? Math.max(view.bb, Math.round((view.pot * fraction) / 10) * 10)
        : view.curBet + Math.max(view.lastRaise, Math.round(((view.pot + toCall) * fraction) / 10) * 10),
    );

  if (toCall <= 0) {
    // Nothing to beat: bet the good ones, and occasionally one that isn't.
    if (canRaise && (strength > fairShare + 0.18 || roll < 0.06 * view.aggression)) {
      return { type: "raise", to: sizeTo(0.45 + Math.random() * 0.35) };
    }
    return { type: "check" };
  }

  const potOdds = toCall / (view.pot + toCall);
  if (canRaise && strength > fairShare + 0.28 && roll < 0.85) {
    return { type: "raise", to: sizeTo(0.6 + Math.random() * 0.4) };
  }
  // Pay the price when the hand is worth it, and defend the big blind a little
  // wider than the raw odds, as the blind is already invested.
  if (eq >= potOdds * 0.9 || (toCall <= view.bb && eq > fairShare * 0.75)) return { type: "call" };
  return { type: "fold" };
}
