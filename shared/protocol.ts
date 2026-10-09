/**
 * The contract between the table and everyone watching it.
 *
 * ── The one rule this file exists to enforce ────────────────────────
 * A player's hole cards never leave the server while they could still matter.
 * `TableState` is therefore not one document the table broadcasts: it is
 * rendered per connection, with every other seat's cards reduced to a count
 * (see `Seat.hole`), and your own two delivered separately in `you.hole`.
 * There is no code path that puts a live hole card in front of the wrong
 * person, because the shape of the type does not allow one — a seat's cards
 * are `null` until the table has decided they are face up for everybody.
 *
 * Cards become visible in exactly three situations: you are looking at your
 * own, the hand reached a showdown that the seat is part of, or everyone left
 * in the hand is all-in and the table has turned the cards up to run the
 * board out.
 */

import type { Card } from "./cards";
import type { Stakes } from "./tables";

export const SEATS = 6;

/** Every new Planary account starts with this many chips (the wallet lives in planary-casino-api). */
export const STARTER_CHIPS = 5000;

/** How long a player has to act. A table where one person can stall is not a table. */
export const TURN_MS = 25_000;

/** Grace for a player whose connection drops mid-hand before they are folded and stood up. */
export const RECONNECT_GRACE_MS = 45_000;

/** The pause between the end of one hand and the deal of the next. */
export const NEXT_HAND_MS = 6_000;

/** How long a table with nobody in a hand waits before dealing, once two seats are ready. */
export const START_MS = 3_000;

// ── Timings the server paces and the client animates to ──
//
// These are shared because both sides use them: the table waits this long
// before the next thing happens, and the cards on screen take exactly this
// long to arrive. A client that animated for longer than the server waits
// would show the flop landing after the betting had already opened on it.

/** Shuffle flourish before the first hole card. */
export const SHUFFLE_MS = 420;
/** Between hole cards, dealt one at a time around the table. */
export const DEAL_STEP_MS = 90;
/** After the last hole card, before the first player is asked to act. */
export const DEAL_SETTLE_MS = 260;
/** Bets sliding to the pot at the end of a street. */
export const COLLECT_MS = 660;
/** Between a street closing and its cards landing. */
export const STREET_MS = 420;
/** Between the three flop cards. */
export const FLOP_STAGGER_MS = 110;
/** After a street's cards land, before betting opens on them. */
export const STREET_SETTLE_MS = 700;
/** Per street while the board runs out with everyone all-in. */
export const RUNOUT_MS = 600;

export const CHAT_MAX_LENGTH = 200;
export const CHAT_HISTORY = 60;

/** Where a player is sent to check a hand for themselves. */
export const VERIFY_URL = "https://casino.planary.ch/verify";

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

/**
 * `waiting` — too few players to deal.
 * `starting` — enough players, counting down to the first hand.
 * `playing` — a hand is live; `street` says where it is.
 * `done` — the hand is over and the result is up; the next deal is counting down.
 */
export type Phase = "waiting" | "starting" | "playing" | "done";

/** What a seat's label says, which decides its colour. See the tokens in globals.css. */
export type LabelKind = "" | "blind" | "fold" | "check" | "call" | "raise" | "allin" | "hand" | "win" | "sitout";

/** How a player looks at the table, from their Planary Casino profile and shop items. */
export interface PlayerLook {
  /** Path on the casino API, or null for initials. */
  avatar: string | null;
  border: string | null;
  title: string | null;
  chipset: string | null;
}

export interface Seat {
  playerId: string;
  name: string;
  /** The letter on the avatar when there is no picture. */
  initial: string;
  look: PlayerLook;
  /** House player. Gives the seat up to the next human who sits down. */
  isBot: boolean;
  /** Chips in front of this seat. Not the player's wallet: see shared/tables.ts. */
  stack: number;
  /** Chips pushed out on the current street. */
  bet: number;
  /** Chips committed to the pot this whole hand, which is what side pots are built from. */
  total: number;

  /**
   * This seat's cards, or null while they are nobody else's business.
   *
   * Null does not mean "no cards" — `cards` is how many are held. The table
   * fills this in only for a seat whose hand is face up to the whole table,
   * and for the connection belonging to the seat itself.
   */
  hole: Card[] | null;
  /** How many hole cards this seat holds: 2 in a hand, 0 otherwise. */
  cards: number;

  /**
   * Dealt into the hand in progress.
   *
   * Distinct from "holds cards": somebody who sat down mid-hand occupies a
   * seat, has chips in front of them and is not sitting out, but is not in
   * this hand and must not be asked to act in it. They are dealt in next hand.
   */
  inHand: boolean;

  folded: boolean;
  allIn: boolean;
  /** Has acted on the current street since the last raise. */
  acted: boolean;
  /** Cards are face up to everyone. */
  show: boolean;
  /** Not being dealt in: asked to sit out, or waiting to be dealt in after buying a seat mid-hand. */
  sittingOut: boolean;
  connected: boolean;

  label: string;
  labelKind: LabelKind;
  /** Won from the pot on the hand just finished. */
  won: number;
  /** The name of the hand shown at showdown ("Two pair"), null otherwise. */
  handName: string | null;
}

/**
 * One pot. A hand has several as soon as somebody is all-in for less than the
 * bet: each is contested only by the players who paid into it.
 */
export interface Pot {
  amount: number;
  /** Seat indexes still eligible for this pot. */
  seats: number[];
}

export interface LogEntry {
  id: number;
  text: string;
}

/**
 * What the table has promised about this hand's deck, and what it proved
 * about the last one.
 *
 * The commitment is per hand, so `hash` covers the deal in progress and
 * `lastHand` is the one just finished, laid open. See the note at the top of
 * shared/cards.ts for why the reveal waits for the end of the hand.
 */
export interface Fairness {
  /** SHA-256 of the seed this hand's deck was shuffled from. */
  hash: string | null;
  /** Seeds contributed by the players seated when this hand was shuffled. */
  seeds: string[];
  /** Counts hands at this table. */
  nonce: number;
  /** The hand just finished, laid open. */
  lastHand: {
    hash: string;
    serverSeed: string;
    clientSeed: string;
    nonce: number;
    /** Every card the hand pulled, in dealing order, burns included. */
    drawn: string[];
  } | null;
}

export interface Result {
  title: string;
  sub: string;
}

export interface TableState {
  id: string;
  isPrivate: boolean;
  /** A house table's name ("Table 1"), null for a player's table. */
  name: string | null;
  stakes: Stakes;
  /** The house fills spare seats here. */
  bots: boolean;

  phase: Phase;
  street: Street;
  hand: number;
  /** Seat with the dealer button. */
  button: number;
  seats: (Seat | null)[];
  board: Card[];
  /** Chips collected from the streets already closed. Current-street bets sit on the seats. */
  pot: number;
  /** The pot split into its contested parts. One entry in the ordinary case. */
  pots: Pot[];
  /** The bet a player has to match on this street. */
  curBet: number;
  /** The size of the last raise, which sets the smallest next one. */
  lastRaise: number;
  /** Seat being asked to act, or null when nobody is. */
  toAct: number | null;
  /** Epoch ms when the current clock runs out (a turn, or the next deal). */
  deadline: number | null;
  /** Everyone left in the hand is all-in: the board runs out with no more betting. */
  runout: boolean;

  result: Result | null;
  /** Card codes in the winning five, for the showdown ring. */
  winning: string[];
  log: LogEntry[];
  fair: Fairness;
}

export type ClientMessage =
  /** Your contribution to the next hand's shuffle. Taken until the deck is cut. */
  | { type: "seed"; value: string }
  /** Buys in and takes a seat. Without a seat number, the table picks the first free one. */
  | { type: "sit"; seat?: number }
  /** Stands up and sends the stack back to the wallet. */
  | { type: "leave" }
  /** Buys back up to the table's buy-in. Only between hands. */
  | { type: "rebuy" }
  /** Keeps the seat but stops being dealt in. */
  | { type: "sitOut"; out: boolean }
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  /** A bet or a raise, given as the total this seat will have out. */
  | { type: "raise"; to: number }
  /** Ready for the next hand, which starts it early if everyone else is too. */
  | { type: "ready" }
  | { type: "chat"; text: string };

export interface ChatMessage {
  id: string;
  at: number;
  /** Null for table announcements (someone sat down, left, …). */
  name: string | null;
  playerId: string | null;
  text: string;
}

/** What the connection's own player can see, which no other connection is sent. */
export interface You {
  playerId: string;
  seat: number | null;
  verified: boolean;
  /** Your own two cards. */
  hole: Card[] | null;
  /** Your chance of winning the hand, as the table computed it. Null when it can't be known. */
  equity: number | null;
  /** The name of what you are holding right now. */
  handName: { category: number; title: string; detail: string } | null;
  /** The seed you have offered for the next hand. */
  seed: string | null;
  /** Your casino wallet balance, so the table can show what a rebuy would cost. */
  balance: number | null;
}

export type ServerMessage =
  | {
      type: "state";
      state: TableState;
      you: You;
      /** Server clock when sent, so clients can correct deadlines for clock skew. */
      now: number;
    }
  | { type: "chat"; messages: ChatMessage[]; replace: boolean }
  | { type: "error"; message: string };

export interface LobbyTable {
  id: string;
  /** A house table's name, null for a player's table. */
  name: string | null;
  stakes: Stakes;
  seated: number;
  /** How many of the seated are bots. */
  bots: number;
  phase: Phase;
  updatedAt: number;
}

/** `house`: the fixed tables, always all three. `tables`: players' public tables with someone seated. */
export type LobbyMessage = { type: "tables"; house: LobbyTable[]; tables: LobbyTable[] };

/** Asks the lobby to open a table. */
export interface CreateTableRequest {
  stakes: Stakes;
  visibility: "public" | "private";
  /** Fill the spare seats with house players. */
  bots: boolean;
}

/** Table ids: "t-xxxxx" public, "p-xxxxx" private. */
export function isPrivateTableId(id: string) {
  return id.startsWith("p-");
}

/** Swiss thousands separator, formatted by hand so server and browser render identical text. */
export function formatChips(value: number) {
  const sign = value < 0 ? "−" : "";
  return (
    sign +
    Math.abs(Math.round(value))
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, "'")
  );
}

export function initialOf(name: string) {
  return (name.trim()[0] ?? "P").toUpperCase();
}

/** The street after this one, or null after the river. */
export function nextStreet(street: Street): Street | null {
  return street === "preflop" ? "flop" : street === "flop" ? "turn" : street === "turn" ? "river" : null;
}

export const STREET_LABELS: Record<Street, string> = {
  preflop: "Preflop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};
