import { type Connection, type ConnectionContext, getServerByName, Server, type WSMessage } from "partyserver";
import type { Env } from "./env";
import { commit, joinClientSeeds, newServerSeed, sanitiseClientSeed } from "../shared/fair";
import { type Card, code, prettyCard, shuffledDeck } from "../shared/cards";
import { bestHand, describe, nameHand } from "../shared/holdem";
import { equity, simsForOpponents } from "../shared/equity";
import { awardPots, buildSplit } from "../shared/pots";
import { BOTS, botPlayerId, botThinkMs, decide, isBotId } from "../shared/bots";
import {
  CHAT_HISTORY,
  CHAT_MAX_LENGTH,
  type ChatMessage,
  type ClientMessage,
  COLLECT_MS,
  DEAL_SETTLE_MS,
  DEAL_STEP_MS,
  FLOP_STAGGER_MS,
  formatChips,
  initialOf,
  isPrivateTableId,
  type LabelKind,
  type LogEntry,
  NEXT_HAND_MS,
  nextStreet,
  type PlayerLook,

  RECONNECT_GRACE_MS,
  RUNOUT_MS,
  type Seat,
  SEATS,
  type ServerMessage,
  SHUFFLE_MS,
  START_MS,
  STREET_MS,
  STREET_SETTLE_MS,
  type TableState,
  TURN_MS,
  type You,
} from "../shared/protocol";
import { DEFAULT_STAKES, houseTable, raiseProblem, type Stakes, type TableConfig } from "../shared/tables";

/** The game this table reports to the casino as. */
const GAME = "poker";

/** A beat between one player acting and the next being asked to. */
const ACT_GAP_MS = 360;

/**
 * A seat as the table writes it down.
 *
 * ── Why seats are persisted at all ──────────────────────────────────
 * Blackjack keeps its seats in memory and loses them when the Durable Object
 * goes away, which is harmless there: a seat's stack *is* the wallet balance,
 * so there is nothing at the table to lose. Poker is the opposite. Sitting
 * down moves chips out of the wallet and onto the felt, and from that moment
 * the only record that those chips exist is this one. An eviction that lost
 * it would destroy a player's buy-in.
 *
 * So the money is written down on every move, and `escrow` below is the
 * invariant that keeps it honest.
 */
interface SeatRecord {
  playerId: string;
  name: string;
  initial: string;
  look: PlayerLook;
  isBot: boolean;
  stack: number;
  sittingOut: boolean;
}

/**
 * The hand in progress, as far as the money is concerned.
 *
 * `committed` is what each player has put in so far. It is the other half of
 * the escrow: a player's chips are either in front of them (`stack`) or in
 * the middle (`committed`), and the two together are what the table owes
 * them. If the table is restarted mid-hand, the hand cannot be fairly
 * resumed — the betting round's shape is gone — so it is voided and every
 * entry here goes back to the stack it came from. Nobody wins, nobody loses,
 * and the chip count is unchanged.
 */
interface HandRecord {
  serverSeed: string;
  clientSeed: string;
  seeds: string[];
  hash: string;
  nonce: number;
  commitmentId: string | null;
  committed: Record<string, number>;
  /** Every card dealt so far, in order, for the hand's record. */
  drawn: string[];
}

const SEATS_KEY = "seats";
const CONFIG_KEY = "config";
const HAND_KEY = "hand";
const META_KEY = "meta";

/** What survives between hands: the button's place and the hand count. */
interface Meta {
  button: number;
  hands: number;
}

interface Identity {
  playerId: string;
  name: string;
  verified: boolean;
}

function cleanName(raw: unknown) {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, 18);
  return name || "Player";
}

/** A fresh seat's per-hand fields, reset before every deal. */
function clearHand(seat: Seat) {
  seat.bet = 0;
  seat.total = 0;
  seat.hole = null;
  seat.cards = 0;
  seat.inHand = false;
  seat.folded = false;
  seat.allIn = false;
  seat.acted = false;
  seat.show = false;
  seat.label = "";
  seat.labelKind = "";
  seat.won = 0;
  seat.handName = null;
}

export class Table extends Server<Env> {
  state!: TableState;
  config: TableConfig = { stakes: DEFAULT_STAKES, bots: false };

  /** The hole cards, held here and never put in a broadcast. Keyed by seat. */
  hole = new Map<number, Card[]>();
  /** The deck this hand was dealt from, and how far into it the dealer has got. */
  deck: Card[] = [];
  deckAt = 0;
  /** The best five of seven at showdown, by seat, for the winner's ring. */
  bestFive = new Map<number, Card[]>();
  /** Hand scores at showdown, by seat. */
  scores = new Map<number, number>();

  hand: HandRecord | null = null;
  /** Seeds offered for the next shuffle, by player. */
  offeredSeeds = new Map<string, string>();
  /** Each connected human's chance of winning, recomputed as the board changes. */
  equities = new Map<string, number>();
  /** Wallet balances, so a seat can be told what a rebuy would cost. */
  balances = new Map<string, number>();

  /** Humans waiting for a seat a bot is keeping warm. */
  waiting: string[] = [];
  /** Players who have confirmed they want the next hand now. */
  ready = new Set<string>();

  /** The turn or next-hand clock. One at a time, and always the one in `state.deadline`. */
  clock: ReturnType<typeof setTimeout> | null = null;
  /** Sequenced timers for a deal: cleared at every hand boundary, as the handoff requires. */
  pending = new Set<ReturnType<typeof setTimeout>>();
  graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  chat: ChatMessage[] = [];
  lastChatAt = new Map<string, number>();
  logId = 0;
  /** True while a seat is being bought or cashed out, so two clicks can't both spend. */
  busy = new Set<string>();
  /** When the hand now being played began, for the archive. */
  handStartedAt = Date.now();
  /** Set if the deck ever had to be cut without a commitment, so the record says so. */
  unprovable = false;

  async onStart() {
    const house = houseTable(this.name);
    const [stored, seats, meta] = await Promise.all([
      house ? Promise.resolve(undefined) : this.ctx.storage.get<TableConfig>(CONFIG_KEY),
      this.ctx.storage.get<(SeatRecord | null)[]>(SEATS_KEY),
      this.ctx.storage.get<Meta>(META_KEY),
    ]);
    this.config = house ? { stakes: house.stakes, bots: true } : (stored ?? { stakes: DEFAULT_STAKES, bots: false });

    this.state = {
      id: this.name,
      isPrivate: isPrivateTableId(this.name),
      name: house?.name ?? null,
      stakes: this.config.stakes,
      bots: this.config.bots,
      phase: "waiting",
      street: "preflop",
      hand: meta?.hands ?? 0,
      button: meta?.button ?? 0,
      seats: Array.from({ length: SEATS }, () => null),
      board: [],
      pot: 0,
      pots: [],
      curBet: 0,
      lastRaise: 0,
      toAct: null,
      deadline: null,
      runout: false,
      result: null,
      winning: [],
      log: [],
      fair: { hash: null, seeds: [], nonce: meta?.hands ?? 0, lastHand: null },
    };

    // Chips that were on the felt when the table went away come back to the
    // seats that owned them, and a hand that was live is voided.
    if (seats) {
      for (let i = 0; i < SEATS; i++) {
        const record = seats[i];
        if (!record) continue;
        this.state.seats[i] = this.seatFrom(record);
        this.state.seats[i]!.connected = false;
      }
      await this.voidHand();
    }
    // Nobody is connected yet. Anyone who doesn't come back gets cashed out.
    await this.armGrace();
  }

  seatFrom(record: SeatRecord): Seat {
    const seat: Seat = {
      playerId: record.playerId,
      name: record.name,
      initial: record.initial,
      look: record.look,
      isBot: record.isBot,
      stack: record.stack,
      bet: 0,
      total: 0,
      hole: null,
      cards: 0,
      inHand: false,
      folded: false,
      allIn: false,
      acted: false,
      show: false,
      sittingOut: record.sittingOut,
      connected: record.isBot,
      label: "",
      labelKind: "",
      won: 0,
      handName: null,
    };
    return seat;
  }

  /**
   * Gives back the chips of a hand that cannot be finished, and forgets it.
   *
   * Called when the table wakes to find a hand recorded as live. The betting
   * round's state — who had acted, what reopened the action — lived in memory
   * and is gone, so there is no honest way to carry on. Returning every chip
   * is the only resolution that cannot favour anybody.
   */
  async voidHand() {
    const record = await this.ctx.storage.get<HandRecord>(HAND_KEY);
    if (!record) return;
    let returned = 0;
    for (const seat of this.state.seats) {
      if (!seat) continue;
      const back = record.committed[seat.playerId] ?? 0;
      if (back <= 0) continue;
      seat.stack += back;
      returned += back;
    }
    await this.ctx.storage.delete(HAND_KEY);
    this.hand = null;
    if (returned > 0) {
      this.log(`Hand #${record.nonce} was voided when the table restarted. Every chip went back.`);
      this.postChat({ name: null, playerId: null, text: `Hand #${record.nonce} was voided by a restart. All bets were returned.` });
    }
    // The deck was committed to and then not played out. Say so rather than
    // leaving a commitment in the archive that no hand ever answers.
    if (record.commitmentId) {
      await this.casino(`/internal/commitments/${record.commitmentId}/reveal`, { serverSeed: record.serverSeed }).catch((error) =>
        console.error("void reveal not filed", error),
      );
    }
    await this.persist();
  }

  /** Writes down the money: the seats, and what the live hand holds of theirs. */
  async persist() {
    const seats = this.state.seats.map((seat) =>
      seat
        ? ({
            playerId: seat.playerId,
            name: seat.name,
            initial: seat.initial,
            look: seat.look,
            isBot: seat.isBot,
            stack: seat.stack,
            sittingOut: seat.sittingOut,
          } satisfies SeatRecord)
        : null,
    );
    if (this.hand) {
      this.hand.committed = {};
      for (const seat of this.state.seats) if (seat && seat.total > 0) this.hand.committed[seat.playerId] = seat.total;
    }
    await this.ctx.storage.put({
      [SEATS_KEY]: seats,
      [META_KEY]: { button: this.state.button, hands: this.state.hand } satisfies Meta,
      ...(this.hand ? { [HAND_KEY]: this.hand } : {}),
    });
  }

  // ── Called by the lobby, worker to worker ─────
  //
  // Durable Object RPC: only code holding the Table binding can reach these,
  // never a request from the internet. They read storage directly and don't
  // wake the table into a game, so asking about a table doesn't deal it a hand.

  /**
   * Gives a brand-new table its stakes. Refuses (false) once the table has a
   * config or has ever opened, so the blinds of a table in play can't change.
   */
  async configure(config: TableConfig): Promise<boolean> {
    const [existing, seats] = await Promise.all([this.ctx.storage.get(CONFIG_KEY), this.ctx.storage.get(SEATS_KEY)]);
    if (existing !== undefined || seats !== undefined) return false;
    await this.ctx.storage.put(CONFIG_KEY, config);
    return true;
  }

  /** Who sits here right now, for a lobby that has just woken up and lost count. */
  async listing(): Promise<{ seated: number; bots: number; phase: TableState["phase"]; stakes: Stakes } | null> {
    if (!this.state) return null;
    const seated = this.state.seats.filter(Boolean) as Seat[];
    return {
      seated: seated.length,
      bots: seated.filter((s) => s.isBot).length,
      phase: this.state.phase,
      stakes: this.state.stakes,
    };
  }

  /** Whether this table was ever created or opened: a code for it leads somewhere. */
  async exists(): Promise<boolean> {
    const [config, seats] = await Promise.all([this.ctx.storage.get(CONFIG_KEY), this.ctx.storage.get(SEATS_KEY)]);
    return config !== undefined || seats !== undefined;
  }

  // ── Connections ───────────────────────────────

  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const identity = await this.identify(url.searchParams.get("token"));
    conn.setState(identity);
    conn.send(JSON.stringify({ type: "chat", messages: this.chat, replace: true } satisfies ServerMessage));

    const index = this.seatOf(identity.playerId);
    if (index !== null) {
      this.state.seats[index]!.connected = true;
      const grace = this.graceTimers.get(identity.playerId);
      if (grace) clearTimeout(grace);
      this.graceTimers.delete(identity.playerId);
    }
    if (identity.verified) void this.refreshBalance(identity.playerId);
    this.broadcastState();
  }

  onClose(conn: Connection) {
    const identity = conn.state as Identity | null;
    if (!identity) return;
    const stillHere = [...this.getConnections<Identity>()].some((c) => c.id !== conn.id && c.state?.playerId === identity.playerId);
    if (stillHere) return;
    const index = this.seatOf(identity.playerId);
    if (index === null) return;
    this.state.seats[index]!.connected = false;
    this.startGrace(identity.playerId);
    this.broadcastState();
  }

  /**
   * A seat whose player has gone gets cashed out, rather than holding chips
   * at a table nobody is at.
   */
  startGrace(playerId: string) {
    if (isBotId(playerId)) return;
    const existing = this.graceTimers.get(playerId);
    if (existing) clearTimeout(existing);
    this.graceTimers.set(
      playerId,
      setTimeout(() => {
        this.graceTimers.delete(playerId);
        void this.standUp(playerId, "disconnected");
      }, RECONNECT_GRACE_MS),
    );
  }

  /**
   * An alarm, so a table nobody reconnects to still gives the chips back.
   *
   * The grace timers above live in memory. If the table is evicted before one
   * fires, there is nothing left to fire it — so the same promise is also
   * written to disk, where an eviction cannot reach it.
   */
  async armGrace() {
    const waiting = this.state.seats.some((s) => s && !s.isBot && !s.connected);
    if (!waiting) return;
    const at = await this.ctx.storage.getAlarm();
    if (at === null) await this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
  }

  async onAlarm() {
    for (const seat of [...this.state.seats]) {
      if (!seat || seat.isBot || seat.connected) continue;
      await this.standUp(seat.playerId, "disconnected");
    }
    this.broadcastState();
    await this.armGrace();
  }

  /** Only Planary accounts can play; a connection without a valid token may only watch. */
  async identify(token: string | null): Promise<Identity> {
    if (token) {
      try {
        const res = await fetch(`${this.env.AUTH_API_URL || "https://auth.planary.ch"}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const { user } = (await res.json()) as { user?: { id: string; email?: string; name?: string } };
          if (user?.id) {
            return { playerId: `u-${user.id}`, name: cleanName(user.name || user.email?.split("@")[0]), verified: true };
          }
        }
      } catch {
        // Auth unreachable: treat as a spectator.
      }
    }
    return { playerId: `s-${crypto.randomUUID()}`, name: "Spectator", verified: false };
  }

  // ── Wallet (planary-casino-api) ───────────────

  /** Chips live in the casino wallet; the table only moves them, worker to worker. */
  async wallet(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok?: boolean; balance: number; reason?: string; blocked?: string | null; muted?: boolean } & Partial<PlayerLook>> {
    const res = await this.env.CASINO.fetch(
      new Request(`https://casino.internal${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": this.env.INTERNAL_KEY },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) throw new Error(`wallet ${path} → ${res.status}`);
    return res.json();
  }

  async casino<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return (await this.wallet(path, body)) as unknown as T;
  }

  userId(playerId: string) {
    return playerId.replace(/^u-/, "");
  }

  async refreshBalance(playerId: string) {
    try {
      const res = await this.wallet("/internal/status", { userId: this.userId(playerId) });
      this.balances.set(playerId, res.balance);
      this.muted.set(playerId, { value: Boolean(res.muted), at: Date.now() });
    } catch {
      // Balance stays unknown; the rebuy button asks the wallet again anyway.
    }
  }

  /** Chat mutes come from the casino; remembered for a minute per player. */
  muted = new Map<string, { value: boolean; at: number }>();
  async isMuted(playerId: string) {
    const known = this.muted.get(playerId);
    if (known && Date.now() - known.at < 60_000) return known.value;
    try {
      const res = await this.wallet("/internal/status", { userId: this.userId(playerId) });
      this.muted.set(playerId, { value: Boolean(res.muted), at: Date.now() });
      return Boolean(res.muted);
    } catch {
      return false;
    }
  }

  /** Sends a message to one player's open connections. */
  tell(playerId: string, message: string) {
    for (const conn of this.getConnections<Identity>()) {
      if (conn.state?.playerId === playerId) conn.send(JSON.stringify({ type: "error", message } satisfies ServerMessage));
    }
  }

  // ── Messages ──────────────────────────────────

  async onMessage(sender: Connection, raw: WSMessage) {
    const identity = sender.state as Identity | null;
    if (!identity || typeof raw !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const error = await this.handle(msg, identity);
    if (error) sender.send(JSON.stringify({ type: "error", message: error } satisfies ServerMessage));
    this.broadcastState();
  }

  async handle(msg: ClientMessage, who: Identity): Promise<string | void> {
    const index = this.seatOf(who.playerId);
    const seat = index === null ? null : this.state.seats[index]!;

    // Watching is open, playing and chatting need a Planary account.
    if (!who.verified && msg.type !== "leave") return "Sign in with your Planary account to play.";

    switch (msg.type) {
      case "chat": {
        const text = String(msg.text ?? "")
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .trim()
          .slice(0, CHAT_MAX_LENGTH);
        if (!text) return;
        if (await this.isMuted(who.playerId)) return "Chat is paused on your account for now.";
        const last = this.lastChatAt.get(who.playerId) ?? 0;
        if (Date.now() - last < 700) return "Slow down a little.";
        this.lastChatAt.set(who.playerId, Date.now());
        this.postChat({ name: seat?.name ?? who.name, playerId: who.playerId, text });
        return;
      }
      case "seed": {
        // The deck is committed to before its first card, so a seed offered
        // now goes into the next hand, not this one. Saying so is the point.
        const value = sanitiseClientSeed(String(msg.value ?? ""));
        if (!value) {
          this.offeredSeeds.delete(who.playerId);
          return;
        }
        this.offeredSeeds.set(who.playerId, value);
        return "Your seed goes into the next hand, when the deck is shuffled.";
      }
      case "sit":
        return this.sit(who, msg.seat);
      case "leave":
        if (!seat) return;
        return this.standUp(who.playerId, "left");
      case "rebuy":
        return this.rebuy(who.playerId);
      case "sitOut": {
        if (!seat) return "Take a seat first.";
        seat.sittingOut = Boolean(msg.out);
        if (!seat.sittingOut && seat.stack <= 0) {
          seat.sittingOut = true;
          return "Buy some chips back first.";
        }
        seat.label = seat.sittingOut && !seat.inHand ? "Sitting out" : seat.label;
        seat.labelKind = seat.sittingOut && !seat.inHand ? "sitout" : seat.labelKind;
        await this.persist();
        if (!seat.sittingOut) this.maybeStart();
        return;
      }
      case "ready": {
        if (!seat) return;
        this.ready.add(who.playerId);
        // Everybody who could play has had enough of looking at the result.
        const waitingOn = this.playable().filter((i) => !this.state.seats[i]!.isBot && !this.ready.has(this.state.seats[i]!.playerId));
        if (this.state.phase === "done" && waitingOn.length === 0) {
          this.clearClock();
          this.nextHand();
        }
        return;
      }
      case "fold":
      case "check":
      case "call":
        return this.playerAct(index, msg.type);
      case "raise":
        return this.playerAct(index, "raise", msg.to);
    }
  }

  // ── Seats and money ───────────────────────────

  /**
   * Buys in and sits down.
   *
   * The wallet is debited before the seat exists, and the seat is written to
   * storage before the player is told they are in it: if anything fails in
   * between, the chips are put back rather than left in limbo.
   */
  async sit(who: Identity, wanted?: number): Promise<string | void> {
    if (this.seatOf(who.playerId) !== null) return "You're already seated.";
    if (this.busy.has(who.playerId)) return "One moment…";
    if (this.waiting.includes(who.playerId)) return "You're next up — you'll be seated after this hand.";

    const buyIn = this.state.stakes.buyIn;
    let index = this.freeSeat(wanted);

    // Every seat taken, but some by house players: a human gets one of theirs.
    if (index === null && this.state.bots) {
      const spare = this.botSeats().find((i) => !this.state.seats[i]!.inHand);
      if (spare !== undefined) {
        this.removeSeat(spare);
        index = spare;
      } else if (this.botSeats().length > 0) {
        this.waiting.push(who.playerId);
        return "Taking a seat for you — you're in after this hand.";
      }
    }
    if (index === null) return "This table is full. You can watch, or pick another table.";

    this.busy.add(who.playerId);
    try {
      const res = await this.wallet("/internal/debit", { userId: this.userId(who.playerId), amount: buyIn, game: GAME, ref: this.name });
      this.balances.set(who.playerId, res.balance);
      if (res.blocked) return res.blocked;
      if (!res.ok) {
        return res.reason ?? `A seat here costs ${formatChips(buyIn)} chips, and your balance is ${formatChips(res.balance)}.`;
      }
      // The seat may have been taken while we were at the wallet.
      const still = this.state.seats[index] === null ? index : this.freeSeat();
      if (still === null || this.seatOf(who.playerId) !== null) {
        await this.wallet("/internal/credit", { userId: this.userId(who.playerId), amount: buyIn, game: GAME, ref: this.name }).catch((error) =>
          console.error("buy-in refund failed", error),
        );
        return "That seat was taken. Try another.";
      }
      await this.seatPlayer(still, {
        playerId: who.playerId,
        name: who.name,
        initial: initialOf(who.name),
        look: { avatar: res.avatar ?? null, border: res.border ?? null, title: res.title ?? null, chipset: res.chipset ?? null },
        isBot: false,
        stack: buyIn,
        sittingOut: false,
      });
    } catch {
      return "Chips are unavailable right now. Try again in a moment.";
    } finally {
      this.busy.delete(who.playerId);
    }
  }

  async seatPlayer(index: number, record: SeatRecord) {
    const seat = this.seatFrom(record);
    seat.connected = true;
    this.state.seats[index] = seat;
    this.postChat({ name: null, playerId: null, text: `${seat.name} sat down with ${formatChips(seat.stack)}.` });
    this.log(`${seat.name} sits down with ${formatChips(seat.stack)}`);
    await this.persist();
    this.notifyLobby();
    this.maybeStart();
  }

  /**
   * Stands up and sends the stack back to the wallet.
   *
   * A player in a live hand keeps their seat until the hand is over — their
   * chips are in the pot and cannot be withdrawn from it — so they are folded
   * and cashed out at the end. Standing up is never refused, only deferred.
   */
  async standUp(playerId: string, why: "left" | "disconnected"): Promise<string | void> {
    const index = this.seatOf(playerId);
    if (index === null) return;
    const seat = this.state.seats[index]!;

    if (seat.inHand && !seat.folded && this.state.phase === "playing") {
      // Fold now so the hand can finish, and cash out when it does.
      this.leaving.add(playerId);
      if (this.state.toAct === index) {
        await this.applyAction(index, "fold");
        return;
      }
      seat.folded = true;
      seat.label = "Fold";
      seat.labelKind = "fold";
      this.log(`${seat.name} ${why === "left" ? "left" : "dropped"} and folds`);
      this.updateEquities();
      // Their folding may have settled the hand — left to itself, the table
      // would sit waiting on a player who has gone. Only when somebody is
      // actually on the clock: if nobody is, a deal is in flight and will
      // pick the hand up when its cards land.
      if (this.state.toAct !== null) this.step();
      this.broadcastState();
      return;
    }
    if (seat.inHand && this.state.phase === "playing") {
      this.leaving.add(playerId);
      return;
    }
    await this.cashOut(index, why);
  }

  /** Players who asked to go (or dropped) mid-hand; cashed out when it ends. */
  leaving = new Set<string>();

  async cashOut(index: number, why: "left" | "disconnected" | "bust") {
    const seat = this.state.seats[index];
    if (!seat) return;
    const amount = seat.stack;
    this.removeSeat(index);
    this.leaving.delete(seat.playerId);
    if (!seat.isBot && amount > 0) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await this.wallet("/internal/credit", { userId: this.userId(seat.playerId), amount, game: GAME, ref: this.name });
          this.balances.set(seat.playerId, res.balance);
          break;
        } catch (error) {
          // The chips are the player's and the table no longer holds a record
          // of them, so this must not be allowed to fail quietly.
          if (attempt === 1) console.error("cash-out failed", { playerId: seat.playerId, amount, table: this.name }, error);
        }
      }
    }
    if (!seat.isBot) {
      const line = why === "disconnected" ? `${seat.name} dropped out and took ${formatChips(amount)}.` : `${seat.name} left with ${formatChips(amount)}.`;
      this.postChat({ name: null, playerId: null, text: line });
    }
    await this.persist();
    this.notifyLobby();
  }

  removeSeat(index: number) {
    const seat = this.state.seats[index];
    if (!seat) return;
    this.state.seats[index] = null;
    this.hole.delete(index);
    this.equities.delete(seat.playerId);
    this.ready.delete(seat.playerId);
    const grace = this.graceTimers.get(seat.playerId);
    if (grace) clearTimeout(grace);
    this.graceTimers.delete(seat.playerId);
  }

  /** Buys back up to the table's buy-in, between hands. */
  async rebuy(playerId: string): Promise<string | void> {
    const index = this.seatOf(playerId);
    if (index === null) return "Take a seat first.";
    const seat = this.state.seats[index]!;
    if (seat.inHand && this.state.phase === "playing") return "You can buy chips back when this hand is over.";
    if (this.busy.has(playerId)) return "One moment…";
    const amount = this.state.stakes.buyIn - seat.stack;
    if (amount <= 0) return "You already have a full stack.";

    this.busy.add(playerId);
    try {
      const res = await this.wallet("/internal/debit", { userId: this.userId(playerId), amount, game: GAME, ref: this.name });
      this.balances.set(playerId, res.balance);
      if (res.blocked) return res.blocked;
      if (!res.ok) return res.reason ?? `That would cost ${formatChips(amount)} chips, and your balance is ${formatChips(res.balance)}.`;
      seat.stack += amount;
      seat.sittingOut = false;
      this.log(`${seat.name} buys ${formatChips(amount)} more`);
      await this.persist();
      this.maybeStart();
    } catch {
      return "Chips are unavailable right now. Try again in a moment.";
    } finally {
      this.busy.delete(playerId);
    }
  }

  // ── Bots ──────────────────────────────────────

  /** Fills the spare seats at a house table, so somebody arriving alone gets a hand. */
  fillBots() {
    if (!this.state.bots) return;
    const taken = new Set(this.state.seats.filter(Boolean).map((s) => s!.playerId));
    for (const profile of BOTS) {
      const id = botPlayerId(profile.name);
      if (taken.has(id)) continue;
      const index = this.freeSeat();
      if (index === null) return;
      this.state.seats[index] = this.seatFrom({
        playerId: id,
        name: profile.name,
        initial: profile.initial,
        look: { avatar: null, border: null, title: null, chipset: null },
        isBot: true,
        stack: this.state.stakes.buyIn,
        sittingOut: false,
      });
      taken.add(id);
    }
  }

  botSeats() {
    const out: number[] = [];
    this.state.seats.forEach((seat, i) => {
      if (seat?.isBot) out.push(i);
    });
    return out;
  }

  profileOf(seat: Seat) {
    return BOTS.find((b) => botPlayerId(b.name) === seat.playerId) ?? BOTS[0];
  }

  /** A bot's turn: it looks at its own cards and the public betting, and nothing else. */
  botTurn(index: number) {
    const seat = this.state.seats[index];
    if (!seat || this.state.toAct !== index || this.state.phase !== "playing") return;
    const hole = this.hole.get(index);
    if (!hole) return void this.applyAction(index, "check");

    const live = this.inHandSeats().filter((i) => !this.state.seats[i]!.folded);
    const canRespond = live.filter((i) => i !== index && !this.state.seats[i]!.allIn).length;
    const action = decide({
      hole,
      board: this.state.board,
      bet: seat.bet,
      stack: seat.stack,
      curBet: this.state.curBet,
      lastRaise: this.state.lastRaise,
      bb: this.state.stakes.bb,
      pot: this.state.pot + this.streetBets(),
      opponents: live.length - 1,
      canRespond,
      raises: this.raises,
      aggression: this.profileOf(seat).aggression,
    });
    void this.applyAction(index, action.type, action.type === "raise" ? action.to : undefined);
  }

  // ── Hand flow ─────────────────────────────────

  /** Raises made on the street in progress, which caps a bot raising war. */
  raises = 0;

  /**
   * True from the moment a street closes until its cards are on the table.
   *
   * The cards are dealt on a timer, so that the chips have time to slide to
   * the pot first — which leaves a window where the street has closed but
   * `state.street` has not moved yet. A second call to `endStreet` inside
   * that window would compute the same next street and deal it again: two
   * flops, a six-card board, and a hand that cannot be scored. More than one
   * caller can reach it (the betting round closing, and the run-out loop), so
   * the window is held shut rather than assumed to be empty.
   */
  closing = false;

  /**
   * True while a hand is being dealt.
   *
   * Two things ask for the next hand: the clock that runs down after a result,
   * and the last player confirming they are ready. `newHand` awaits the
   * wallet and the deck commitment on its way through, so without this both
   * could be inside it at once — and the second would reset the seats while
   * the first still had chips in the pot, which is a buy-in quietly deleted.
   */
  dealing = false;

  /** Seats that can be dealt in: chips in front of them, and not sitting out. */
  playable(): number[] {
    const out: number[] = [];
    this.state.seats.forEach((seat, i) => {
      if (seat && !seat.sittingOut && seat.stack > 0) out.push(i);
    });
    return out;
  }

  inHandSeats(): number[] {
    const out: number[] = [];
    this.state.seats.forEach((seat, i) => {
      if (seat?.inHand) out.push(i);
    });
    return out;
  }

  streetBets() {
    return this.state.seats.reduce((sum, seat) => sum + (seat?.bet ?? 0), 0);
  }

  /** Opens a hand when there are two players for it, after a beat so people can see the table. */
  maybeStart() {
    if (this.state.phase === "playing" || this.state.phase === "starting") return;
    this.fillBots();
    if (this.playable().length < 2) {
      if (this.state.phase !== "waiting") {
        this.state.phase = "waiting";
        this.state.deadline = null;
        this.clearClock();
      }
      return;
    }
    if (this.state.phase === "done") return;
    this.state.phase = "starting";
    this.state.deadline = Date.now() + START_MS;
    this.setClock(START_MS, () => this.nextHand());
  }

  nextHand() {
    void this.newHand();
  }

  async newHand() {
    if (this.dealing) return;
    this.dealing = true;
    try {
      await this.deal();
    } finally {
      this.dealing = false;
    }
  }

  async deal() {
    this.clearTimers();
    this.ready.clear();

    // Nothing should be left in the middle between hands. If anything is, a
    // hand ended in a way that did not pay out, and the chips belong to the
    // players who put them there — not to the next pot.
    const stranded = this.state.pot + this.streetBets();
    if (stranded > 0) {
      console.error("chips left over between hands", { table: this.name, hand: this.state.hand, stranded });
      for (const seat of this.state.seats) {
        if (!seat) continue;
        seat.stack += seat.total;
        seat.bet = 0;
        seat.total = 0;
      }
      this.state.pot = 0;
      this.state.pots = [];
    }

    // Everyone who asked to leave, and everyone out of chips, is dealt with
    // before the cards come out rather than during the hand.
    for (const playerId of [...this.leaving]) {
      const index = this.seatOf(playerId);
      if (index !== null) await this.cashOut(index, "left");
    }
    for (const index of [...this.state.seats.keys()]) {
      const seat = this.state.seats[index];
      if (!seat) continue;
      if (seat.isBot && seat.stack < this.state.stakes.bb) {
        // House players top themselves up: their chips are the house's, never a wallet's.
        seat.stack = this.state.stakes.buyIn;
        this.log(`${seat.name} tops up to ${formatChips(seat.stack)}`);
      }
      if (!seat.isBot && seat.stack <= 0) seat.sittingOut = true;
    }
    // Humans waiting on a bot's seat get it now.
    await this.seatWaiting();
    this.fillBots();

    const playing = this.playable();
    if (playing.length < 2) {
      this.state.phase = "waiting";
      this.state.street = "preflop";
      this.state.toAct = null;
      this.state.deadline = null;
      this.state.board = [];
      this.state.pot = 0;
      this.state.pots = [];
      for (const seat of this.state.seats) if (seat) clearHand(seat);
      await this.persist();
      this.broadcastState();
      this.notifyLobby();
      return;
    }

    // The hand just finished is proved before the next one is committed to.
    await this.retireHand();

    this.state.hand += 1;
    this.state.phase = "playing";
    this.state.street = "preflop";
    this.state.board = [];
    this.state.pot = 0;
    this.state.pots = [];
    this.state.curBet = 0;
    this.state.lastRaise = 0;
    this.state.toAct = null;
    this.state.deadline = null;
    this.state.runout = false;
    this.state.result = null;
    this.state.winning = [];
    this.raises = 0;
    this.closing = false;
    this.hole.clear();
    this.bestFive.clear();
    this.scores.clear();
    this.equities.clear();
    this.handStartedAt = Date.now();
    for (const seat of this.state.seats) if (seat) clearHand(seat);

    // The button moves to the next player who is in. With two players it is
    // also the small blind, and acts first before the flop and last after it.
    this.state.button = this.nextIn(this.state.button, playing);
    const heads = playing.length === 2;
    const sb = heads ? this.state.button : this.nextIn(this.state.button, playing);
    const bb = this.nextIn(sb, playing);

    const deck = await this.cutDeck();
    this.deck = deck;
    this.deckAt = 0;

    for (const index of playing) {
      const seat = this.state.seats[index]!;
      seat.inHand = true;
      seat.cards = 2;
    }
    // Two rounds, one card at a time, starting left of the button — as dealt.
    for (let round = 0; round < 2; round++) {
      for (const index of this.orderFrom(this.nextIn(this.state.button, playing), playing)) {
        const card = this.draw();
        const held = this.hole.get(index) ?? [];
        held.push(card);
        this.hole.set(index, held);
      }
    }

    this.log(
      `Hand #${this.state.hand} · ${this.state.seats[this.state.button]!.name} has the button`,
    );
    this.postBlind(sb, this.state.stakes.sb, "SB");
    this.postBlind(bb, this.state.stakes.bb, "BB");
    this.state.curBet = this.state.stakes.bb;
    this.state.lastRaise = this.state.stakes.bb;
    await this.persist();
    this.broadcastState();

    // The cards are on their way; nobody is asked to act until they land.
    const dealMs = SHUFFLE_MS + playing.length * 2 * DEAL_STEP_MS + DEAL_SETTLE_MS;
    this.later(dealMs, () => {
      this.updateEquities();
      // Preflop the first to act is left of the big blind; heads-up that is the button.
      this.state.toAct = heads ? this.state.button : this.nextIn(bb, playing);
      this.step();
    });
  }

  /** Seats the humans who were waiting on a house player's chair. */
  async seatWaiting() {
    while (this.waiting.length > 0) {
      const playerId = this.waiting[0];
      const free = this.freeSeat() ?? this.botSeats()[0];
      if (free === undefined) return;
      this.waiting.shift();
      const conn = [...this.getConnections<Identity>()].find((c) => c.state?.playerId === playerId);
      if (!conn?.state) continue;
      if (this.state.seats[free]?.isBot) this.removeSeat(free);
      const problem = await this.sit(conn.state, free);
      if (problem) this.tell(playerId, problem);
    }
  }

  postBlind(index: number, amount: number, label: string) {
    const put = this.put(index, amount);
    const seat = this.state.seats[index]!;
    seat.label = `${label} ${formatChips(put)}`;
    seat.labelKind = "blind";
    this.log(`${seat.name} posts ${formatChips(put)}`);
  }

  /**
   * Moves chips from a seat's stack to its bet, up to `target` in total on
   * this street. Returns what actually went in, which is less when the seat
   * does not have it — that is a short all-in, and it is allowed.
   */
  put(index: number, target: number) {
    const seat = this.state.seats[index]!;
    const add = Math.max(0, Math.min(target - seat.bet, seat.stack));
    seat.stack -= add;
    seat.bet += add;
    seat.total += add;
    if (seat.stack === 0) seat.allIn = true;
    return add;
  }

  canAct(index: number) {
    const seat = this.state.seats[index];
    return Boolean(seat?.inHand && !seat.folded && !seat.allIn);
  }

  /** The next seat after `from` that is in this hand (or in `among`). */
  nextIn(from: number, among: number[]) {
    for (let step = 1; step <= SEATS; step++) {
      const index = (from + step) % SEATS;
      if (among.includes(index)) return index;
    }
    return from;
  }

  /** Seats in dealing order, starting at `from`. */
  orderFrom(from: number, among: number[]) {
    const out: number[] = [];
    let index = from;
    for (let n = 0; n < SEATS && out.length < among.length; n++) {
      if (among.includes(index)) out.push(index);
      index = (index + 1) % SEATS;
    }
    return out;
  }

  /** Takes the next card off the front of the committed deck. */
  draw(): Card {
    if (this.deckAt >= this.deck.length) {
      // Unreachable in a 6-max hand, which needs at most 17 cards of 52, but
      // a live table must never deal from an empty deck.
      this.unprovable = true;
      this.deck = [...this.deck, ...this.deck];
    }
    const card = this.deck[this.deckAt++];
    if (this.hand) this.hand.drawn.push(code(card));
    return card;
  }

  /**
   * Asks the next player to act, or closes the street.
   *
   * A street is over when everybody still able to act has matched the bet and
   * has acted since the last raise. The `acted` flags are cleared on every
   * raise, which is what reopens the action.
   */
  step() {
    if (this.state.phase !== "playing") return;
    const live = this.inHandSeats().filter((i) => !this.state.seats[i]!.folded);
    if (live.length === 1) return void this.uncontested(live[0]);
    // Nobody left at all. It takes two players walking out of the same hand
    // within a moment of each other, and it should not be reachable — but a
    // pot with no claimant is exactly the shape of a lost buy-in, so it is
    // handled rather than trusted not to happen.
    if (live.length === 0) return void this.abandonHand();

    const able = live.filter((i) => this.canAct(i));
    const settled = able.every((i) => {
      const seat = this.state.seats[i]!;
      return seat.bet === this.state.curBet && (seat.acted || able.length === 1);
    });
    if (settled) return void this.endStreet();

    let index = this.state.toAct ?? this.nextIn(this.state.button, live);
    for (let n = 0; n < SEATS; n++) {
      const seat = this.state.seats[index];
      if (seat && this.canAct(index) && (!seat.acted || seat.bet < this.state.curBet)) break;
      index = (index + 1) % SEATS;
    }
    this.state.toAct = index;
    const seat = this.state.seats[index]!;

    if (seat.isBot) {
      this.state.deadline = null;
      this.broadcastState();
      this.later(botThinkMs(), () => this.botTurn(index));
      return;
    }

    this.state.deadline = Date.now() + TURN_MS;
    this.setClock(TURN_MS, () => {
      // Out of time: check if it's free, fold if it isn't. A player who has
      // also dropped off is stood up, so the seat doesn't stall every hand.
      const owed = this.state.curBet - seat.bet;
      void this.applyAction(index, owed > 0 ? "fold" : "check", undefined, true);
    });
    this.broadcastState();
  }

  /** A player's own action, checked against whose turn it is. */
  async playerAct(index: number | null, type: "fold" | "check" | "call" | "raise", to?: number): Promise<string | void> {
    if (index === null) return "Take a seat first.";
    if (this.state.phase !== "playing" || this.state.toAct !== index) return "It's not your turn.";
    const seat = this.state.seats[index]!;
    const owed = this.state.curBet - seat.bet;
    if (type === "check" && owed > 0) return `There's ${formatChips(owed)} to call.`;
    if (type === "raise") {
      const problem = raiseProblem(to, this.state.curBet, this.state.lastRaise, this.state.stakes.bb, seat.stack, seat.bet);
      if (problem) return problem;
    }
    await this.applyAction(index, type, to);
  }

  async applyAction(index: number, type: "fold" | "check" | "call" | "raise", to?: number, timedOut = false) {
    if (this.state.phase !== "playing" || this.state.toAct !== index) return;
    const seat = this.state.seats[index];
    if (!seat) return;
    this.clearClock();
    this.state.deadline = null;

    const owed = this.state.curBet - seat.bet;
    // A call with nothing owed is a check; a raise that isn't one is a call.
    if (type === "call" && owed <= 0) type = "check";
    if (type === "raise" && (to ?? 0) <= this.state.curBet) type = owed > 0 ? "call" : "check";

    if (type === "fold") {
      seat.folded = true;
      this.label(seat, "Fold", "fold");
      this.log(`${seat.name} folds${timedOut ? " (out of time)" : ""}`);
    } else if (type === "check") {
      this.label(seat, "Check", "check");
      this.log(`${seat.name} checks`);
    } else if (type === "call") {
      const add = this.put(index, this.state.curBet);
      this.label(seat, seat.allIn ? "All-in" : `Call ${formatChips(add)}`, seat.allIn ? "allin" : "call");
      this.log(`${seat.name} calls ${formatChips(add)}${seat.allIn ? " and is all-in" : ""}`);
    } else {
      const was = this.state.curBet;
      this.put(index, to ?? 0);
      if (seat.bet > was) {
        const increment = seat.bet - was;
        // A full raise sets the new minimum and reopens the action. A short
        // all-in does neither: nobody owes more than they were already owed.
        if (increment >= Math.max(this.state.lastRaise, this.state.stakes.bb)) {
          this.state.lastRaise = increment;
          this.raises += 1;
          for (const other of this.state.seats) if (other && other !== seat) other.acted = false;
        }
        this.state.curBet = seat.bet;
      }
      this.label(
        seat,
        seat.allIn ? `All-in ${formatChips(seat.bet)}` : `${was === 0 ? "Bet" : "Raise"} ${formatChips(seat.bet)}`,
        seat.allIn ? "allin" : "raise",
      );
      this.log(`${seat.name} ${was === 0 ? "bets" : "raises to"} ${formatChips(seat.bet)}${seat.allIn ? " and is all-in" : ""}`);
    }

    seat.acted = true;
    if (type === "fold") this.updateEquities();
    // A player who timed out while disconnected has their seat given back.
    if (timedOut && !seat.connected) this.leaving.add(seat.playerId);
    this.state.toAct = (index + 1) % SEATS;
    await this.persist();
    this.broadcastState();
    this.later(ACT_GAP_MS, () => this.step());
  }

  label(seat: Seat, text: string, kind: LabelKind) {
    seat.label = text;
    seat.labelKind = kind;
  }

  /**
   * Closes a street: the bets go to the middle, and the next cards come out.
   *
   * The bets are left on the seats for COLLECT_MS first, because that is how
   * long the chips take to slide to the pot on screen. The server is pacing
   * the animation, not waiting for it.
   */
  async endStreet() {
    if (this.closing || this.state.phase !== "playing") return;
    this.closing = true;
    const moved = this.streetBets();
    for (const seat of this.state.seats) {
      if (!seat) continue;
      this.state.pot += seat.bet;
      seat.bet = 0;
      seat.acted = false;
      // Fold and all-in labels stay up; the rest are spent.
      if (seat.labelKind !== "fold" && seat.labelKind !== "allin") this.label(seat, "", "");
    }
    this.state.curBet = 0;
    this.state.lastRaise = 0;
    this.state.toAct = null;
    this.state.deadline = null;
    this.raises = 0;
    const { pots, refunds } = this.split();
    this.refund(refunds);
    this.state.pots = refunds.size > 0 ? this.split().pots : pots;
    await this.persist();
    this.broadcastState();

    if (this.state.street === "river") {
      this.later(moved ? COLLECT_MS : 300, () => {
        this.closing = false;
        void this.showdown();
      });
      return;
    }

    const live = this.inHandSeats().filter((i) => !this.state.seats[i]!.folded);
    // At most one player can still act: the rest are all-in, so there is
    // nothing left to decide and the cards go face up for the run-out.
    const runout = live.filter((i) => !this.state.seats[i]!.allIn).length < 2;
    if (runout && !this.state.runout) {
      this.state.runout = true;
      for (const index of live) this.state.seats[index]!.show = true;
      this.log("Cards up");
    }

    const next = nextStreet(this.state.street)!;
    this.later(moved ? COLLECT_MS : STREET_MS, () => {
      this.state.street = next;
      // A card is burned before every street, as at the table.
      this.draw();
      const count = next === "flop" ? 3 : 1;
      for (let i = 0; i < count; i++) this.state.board.push(this.draw());
      this.log(`${next[0].toUpperCase()}${next.slice(1)}: ${this.state.board.slice(-count).map(prettyCard).join(" ")}`);
      // The street has moved on and its cards are down, so the next one may
      // be closed whenever the betting on this one finishes.
      this.closing = false;
      this.updateEquities();
      void this.persist();
      this.broadcastState();

      const landed = count === 3 ? STREET_SETTLE_MS + 2 * FLOP_STAGGER_MS : STREET_SETTLE_MS;
      this.later(landed, () => {
        if (this.state.runout) {
          this.later(RUNOUT_MS, () => void this.endStreet());
          return;
        }
        // After the flop the action starts left of the button, every street.
        const stillLive = this.inHandSeats().filter((i) => !this.state.seats[i]!.folded);
        this.state.toAct = this.nextIn(this.state.button, stillLive);
        this.step();
      });
    });
  }

  /**
   * The pot in its contested layers, and anything that has to go back. The
   * arithmetic is in shared/pots.ts, where it can be tested; this only says
   * who is still live.
   */
  split() {
    return buildSplit(
      this.state.seats.flatMap((seat, index) =>
        seat ? [{ seat: index, total: seat.total, live: seat.inHand && !seat.folded }] : [],
      ),
    );
  }

  /**
   * Hands back chips nobody could win: a bet that was only called by a
   * shorter all-in, or one made by a player who has since dropped out of the
   * hand. They return to the stack they came from, and the hand's record of
   * what each player committed comes down with them, so the result a player
   * is shown is what they actually won or lost.
   */
  refund(refunds: Map<number, number>) {
    for (const [index, amount] of refunds) {
      const seat = this.state.seats[index];
      if (!seat || amount <= 0) continue;
      seat.stack += amount;
      seat.total -= amount;
      // The chips were counted into the middle when the street closed, so
      // they have to come out of it again or the pot on screen would promise
      // more than it can pay.
      this.state.pot -= amount;
      this.log(`${formatChips(amount)} goes back to ${seat.name}, uncalled`);
    }
  }

  /**
   * Gives a hand back when there is no one left to win it.
   *
   * Each player's own contribution returns to their own stack, which is the
   * only division that cannot favour anybody. The pot is never left sitting
   * on a table that has been walked away from.
   */
  async abandonHand() {
    let returned = 0;
    for (const seat of this.state.seats) {
      if (!seat) continue;
      // `total` is everything this player put in this hand, the chips still
      // sitting in front of them on this street included — so it is the whole
      // refund, and adding `bet` on top of it would hand those back twice.
      const back = seat.total;
      if (back <= 0) continue;
      seat.stack += back;
      seat.bet = 0;
      seat.total = 0;
      returned += back;
    }
    this.state.pot = 0;
    this.state.pots = [];
    this.state.result = { title: "Hand abandoned", sub: "Everybody left, so every chip went back" };
    this.log(`Hand #${this.state.hand} abandoned · ${formatChips(returned)} returned`);
    await this.finishHand();
  }

  /** Everyone else folded: the last hand standing takes it, with no showdown. */
  async uncontested(index: number) {
    const seat = this.state.seats[index];
    if (!seat) return;
    const amount = this.state.pot + this.streetBets();
    for (const other of this.state.seats) if (other) other.bet = 0;
    seat.stack += amount;
    seat.won = amount;
    this.state.pot = 0;
    this.state.pots = [];
    this.label(seat, `Wins ${formatChips(amount)}`, "win");
    this.state.result = { title: `${seat.name} wins ${formatChips(amount)}`, sub: "Everyone else folded" };
    this.log(`${seat.name} takes ${formatChips(amount)} uncontested`);
    await this.finishHand();
  }

  /** Best five of seven, pot by pot. */
  async showdown() {
    this.state.street = "showdown";
    const live = this.inHandSeats().filter((i) => !this.state.seats[i]!.folded);
    for (const index of live) {
      const seat = this.state.seats[index]!;
      const hole = this.hole.get(index) ?? [];
      const best = bestHand([...hole, ...this.state.board]);
      this.scores.set(index, best.score);
      this.bestFive.set(index, best.cards);
      seat.show = true;
      seat.handName = describe(best.score).title;
      this.label(seat, seat.handName, "hand");
    }

    const { pots, refunds } = this.split();
    this.refund(refunds);
    // Seat order from the dealer's left, which is what decides the odd chip
    // in a split pot.
    const order = this.orderFrom(this.nextIn(this.state.button, live), live);
    const won = awardPots(pots, this.scores, order);
    for (const [index, amount] of won) this.state.seats[index]!.won += amount;

    // The main pot's winners are the ones whose cards get the ring.
    const main = pots[0];
    const mainContenders = (main?.seats ?? live).filter((i) => this.scores.has(i));
    const top = mainContenders.length > 0 ? Math.max(...mainContenders.map((i) => this.scores.get(i)!)) : -1;
    const firstWinners = order.filter((i) => mainContenders.includes(i) && this.scores.get(i) === top);

    for (const seat of this.state.seats) {
      if (!seat || seat.won <= 0) continue;
      seat.stack += seat.won;
      this.label(seat, `Wins ${formatChips(seat.won)}`, "win");
      this.log(`${seat.name} wins ${formatChips(seat.won)} with ${(seat.handName ?? "").toLowerCase()}`);
    }
    this.state.pot = 0;
    this.state.pots = pots;
    this.state.winning = firstWinners.flatMap((i) => (this.bestFive.get(i) ?? []).map(code));

    const winners = this.state.seats
      .map((seat, i) => ({ seat, i }))
      .filter(({ seat }) => seat && seat.won > 0) as { seat: Seat; i: number }[];
    const best = firstWinners[0];
    const bestName = best === undefined ? null : describe(this.scores.get(best) ?? 0);
    this.state.result = {
      title:
        winners.length === 0
          ? "No winner"
          : winners.length === 1
            ? `${winners[0].seat.name} wins ${formatChips(winners[0].seat.won)}`
            : `Split · ${winners.map(({ seat }) => `${seat.name} ${formatChips(seat.won)}`).join(" · ")}`,
      sub: winners.length === 0 ? "Every chip went back" : bestName ? `${bestName.title} · ${bestName.detail}` : "",
    };
    await this.finishHand();
  }

  /**
   * Files the hand, pays the archive, and starts the clock on the next deal.
   *
   * The seed is published here, which is what makes the hand checkable: see
   * the note at the top of shared/cards.ts for why it waits until now.
   */
  async finishHand() {
    this.clearClock();
    this.state.phase = "done";
    this.closing = false;
    this.state.toAct = null;
    this.state.runout = false;
    this.state.deadline = Date.now() + NEXT_HAND_MS;
    for (const seat of this.state.seats) {
      if (!seat) continue;
      seat.acted = false;
      if (!seat.isBot && seat.stack <= 0) seat.sittingOut = true;
    }
    this.reportHand();
    await this.persist();
    this.broadcastState();
    this.notifyLobby();
    this.setClock(NEXT_HAND_MS, () => this.nextHand());
  }

  // ── The committed deck ────────────────────────

  /**
   * Commits to a deck and shuffles it.
   *
   * The seed is drawn and its hash published before a single card is dealt,
   * and the seeds the players offered go in alongside it. Neither side can
   * steer the deal: the table committed before it saw the players' seeds, and
   * the players chose before they saw the table's.
   */
  async cutDeck(): Promise<Card[]> {
    const serverSeed = newServerSeed();
    const hash = await commit(serverSeed);
    const seeds = [...this.offeredSeeds.values()];
    const clientSeed = joinClientSeeds(seeds);
    const nonce = this.state.hand;

    this.hand = { serverSeed, clientSeed, seeds, hash, nonce, commitmentId: null, committed: {}, drawn: [] };
    this.state.fair = { hash, seeds, nonce, lastHand: this.state.fair.lastHand };
    this.offeredSeeds.clear();
    this.unprovable = false;
    await this.ctx.storage.put(HAND_KEY, this.hand);

    // Filed with the casino so the commitment exists somewhere the table
    // cannot quietly change it. A table whose archive is unreachable deals
    // on, and the hand records carry their commitment inline instead.
    this.casino<{ id: string }>("/internal/commitments", { game: GAME, tableId: this.name, kind: "deck", hash, clientSeed, nonce })
      .then((filed) => {
        if (this.hand?.nonce === nonce) {
          this.hand.commitmentId = filed.id;
          return this.ctx.storage.put(HAND_KEY, this.hand);
        }
      })
      .catch((error) => console.error("deck commitment not filed", error));

    return shuffledDeck(serverSeed, clientSeed, nonce);
  }

  /** Publishes the seed behind the hand just played, so anyone can replay the deal. */
  async retireHand() {
    const record = this.hand;
    if (!record) return;
    this.state.fair.lastHand = {
      hash: record.hash,
      serverSeed: record.serverSeed,
      clientSeed: record.clientSeed,
      nonce: record.nonce,
      drawn: [...record.drawn],
    };
    this.hand = null;
    await this.ctx.storage.delete(HAND_KEY);
    if (record.commitmentId) {
      await this.casino(`/internal/commitments/${record.commitmentId}/reveal`, { serverSeed: record.serverSeed }).catch((error) =>
        console.error("deck reveal not filed", error),
      );
    }
  }

  // ── Reporting ─────────────────────────────────

  /** Tells the casino how each player's hand went, for stats and achievements, and files it. */
  reportHand() {
    const played = this.inHandSeats()
      .map((i) => ({ index: i, seat: this.state.seats[i]! }))
      .filter(({ seat }) => !seat.isBot && seat.playerId.startsWith("u-"));
    if (played.length === 0) return;
    const tablemates = played.map(({ seat }) => this.userId(seat.playerId));
    const showdown = this.state.street === "showdown";
    const potTotal = this.state.seats.reduce((sum, seat) => sum + (seat?.total ?? 0), 0);

    for (const { index, seat } of played) {
      const score = this.scores.get(index);
      const round = {
        game: GAME,
        net: seat.won - seat.total,
        won: seat.won > 0,
        showdown: showdown && seat.show,
        /** The category of the hand shown down, 0–9, or null if it never got there. */
        category: showdown && score !== undefined ? describe(score).category : null,
        allIn: seat.allIn,
        folded: seat.folded,
        players: this.inHandSeats().length,
        pot: potTotal,
      };
      void this.casino<{ unlocked: { id: string; name: string }[] }>("/internal/round", {
        userId: this.userId(seat.playerId),
        round,
        tablemates,
      })
        .then(({ unlocked }) => {
          for (const a of unlocked ?? []) this.postChat({ name: null, playerId: null, text: `${seat.name} unlocked ${a.name}.` });
        })
        .catch((error) => console.error("hand report failed", error));
    }
    void this.fileHand(played.map(({ index }) => index));
  }

  /**
   * Files the hand under the commitment of the deck it came out of.
   *
   * The record carries every card in dealing order, so once the seed is
   * published the whole deal can be replayed and checked — the hole cards,
   * the burns and the board, in the order they left the deck.
   */
  async fileHand(seatsPlayed: number[]) {
    const record = this.hand;
    const fair = record ?? this.state.fair.lastHand;
    if (!fair) return;
    try {
      await this.casino("/internal/archive", {
        game: GAME,
        tableId: this.name,
        commitmentId: record?.commitmentId ?? undefined,
        commitment: record?.commitmentId
          ? undefined
          : { game: GAME, tableId: this.name, kind: "deck", hash: fair.hash, clientSeed: fair.clientSeed, nonce: fair.nonce },
        startedAt: this.handStartedAt,
        endedAt: Date.now(),
        outcome: this.state.result?.title ?? "hand over",
        log: {
          stakes: `${this.state.stakes.sb}/${this.state.stakes.bb}`,
          rules: "No-limit Texas Hold'em, 6-max, blinds, min-raise, side pots",
          button: this.state.button,
          board: this.state.board.map(code),
          /** Every card the hand pulled, in order: the deck read back. */
          drawn: record ? [...record.drawn] : fair.drawn,
          /** The hole cards, so a showdown can be checked without the seed. */
          hole: Object.fromEntries(
            [...this.hole.entries()].map(([index, cards]) => [String(index), cards.map(code)]),
          ),
          /** True only if the deck ever had to be extended without a commitment. */
          unprovable: this.unprovable,
        },
        players: seatsPlayed.map((index) => {
          const seat = this.state.seats[index]!;
          return {
            userId: this.userId(seat.playerId),
            seat: index,
            staked: seat.total,
            returned: seat.won,
            detail: {
              hole: (this.hole.get(index) ?? []).map(code),
              hand: seat.handName,
              folded: seat.folded,
              won: seat.won,
            },
          };
        }),
      });
    } catch (error) {
      console.error("hand not archived", error);
    }
  }

  // ── Odds ──────────────────────────────────────

  /**
   * Recomputes each seated human's chance of winning.
   *
   * Only for players still in the hand and still connected: this costs a
   * few hundred thousand hand evaluations and there is no point spending
   * them on a folded hand or a closed tab.
   */
  updateEquities() {
    this.equities.clear();
    if (this.state.phase !== "playing") return;
    const live = this.inHandSeats().filter((i) => !this.state.seats[i]!.folded);
    if (live.length < 2) return;
    for (const index of live) {
      const seat = this.state.seats[index]!;
      if (seat.isBot || !seat.connected) continue;
      const hole = this.hole.get(index);
      if (!hole || hole.length < 2) continue;
      const opponents = live.length - 1;
      this.equities.set(seat.playerId, equity(hole, this.state.board, Math.min(opponents, 5), simsForOpponents(opponents)));
    }
  }

  // ── Helpers ───────────────────────────────────

  freeSeat(wanted?: number): number | null {
    if (wanted !== undefined) {
      if (!Number.isInteger(wanted) || wanted < 0 || wanted >= SEATS) return null;
      return this.state.seats[wanted] ? null : wanted;
    }
    const index = this.state.seats.findIndex((s) => !s);
    return index === -1 ? null : index;
  }

  seatOf(playerId: string): number | null {
    const index = this.state.seats.findIndex((s) => s?.playerId === playerId);
    return index === -1 ? null : index;
  }

  log(text: string) {
    this.state.log.unshift({ id: ++this.logId, text } satisfies LogEntry);
    if (this.state.log.length > 30) this.state.log.length = 30;
  }

  postChat(entry: Omit<ChatMessage, "id" | "at">) {
    const message: ChatMessage = { id: crypto.randomUUID(), at: Date.now(), ...entry };
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.broadcast(JSON.stringify({ type: "chat", messages: [message], replace: false } satisfies ServerMessage));
  }

  /** The turn / next-hand clock: exactly one, and it matches `state.deadline`. */
  setClock(ms: number, fn: () => void) {
    this.clearClock();
    this.clock = setTimeout(() => {
      this.clock = null;
      fn();
      this.broadcastState();
    }, ms);
  }

  clearClock() {
    if (this.clock) clearTimeout(this.clock);
    this.clock = null;
  }

  /**
   * A step in a deal. Plain timers, so a backgrounded tab can't stall the
   * table.
   *
   * A deal is a chain of these, and an exception part-way along it would
   * otherwise leave the hand frozen with no way back — nobody to act, no
   * timer left to fire. So a failing step is logged and the table still
   * publishes where it got to, which is recoverable; an unhandled one is not.
   */
  later(ms: number, fn: () => void) {
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      try {
        fn();
      } catch (error) {
        console.error("step failed", { table: this.name, hand: this.state.hand, street: this.state.street }, error);
      }
      this.broadcastState();
    }, ms);
    this.pending.add(timer);
  }

  clearTimers() {
    this.clearClock();
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
  }

  broadcastState() {
    for (const conn of this.getConnections<Identity>()) {
      const identity = conn.state;
      if (!identity) continue;
      conn.send(JSON.stringify(this.viewFor(identity)));
    }
  }

  /**
   * The table as one connection may see it.
   *
   * This is the only place a hole card can reach a client, and it hands over
   * exactly two kinds: the ones the table has turned face up for everybody,
   * and the connection's own.
   */
  viewFor(identity: Identity): ServerMessage {
    const seat = this.seatOf(identity.playerId);
    const hole = seat === null ? null : this.hole.get(seat) ?? null;
    const handName = hole && hole.length === 2 ? nameHand(hole, this.state.board) : null;

    const state: TableState = {
      ...this.state,
      seats: this.state.seats.map((s, i) => {
        if (!s) return null;
        const mine = i === seat;
        const faceUp = s.show || mine;
        return { ...s, hole: faceUp ? this.hole.get(i) ?? null : null };
      }),
    };

    const you: You = {
      playerId: identity.playerId,
      seat,
      verified: identity.verified,
      hole,
      equity: this.equities.get(identity.playerId) ?? null,
      handName,
      seed: this.offeredSeeds.get(identity.playerId) ?? null,
      balance: this.balances.get(identity.playerId) ?? null,
    };
    return { type: "state", state, you, now: Date.now() };
  }

  notifyLobby() {
    if (this.state.isPrivate) return;
    const seated = this.state.seats.filter(Boolean) as Seat[];
    void getServerByName(this.env.Lobby, "main")
      .then((lobby) =>
        lobby.report({
          id: this.name,
          seated: seated.length,
          bots: seated.filter((s) => s.isBot).length,
          phase: this.state.phase,
          stakes: this.state.stakes,
        }),
      )
      .catch(() => {});
  }
}
