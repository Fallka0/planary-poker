"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, LogOut, WifiOff } from "lucide-react";
import type { Card } from "../../../../shared/cards";
import { code as cardCode } from "../../../../shared/cards";
import {
  formatChips,
  type Seat,
  SEATS,
  STREET_LABELS,
  type TableState,
  type You,
} from "../../../../shared/protocol";
import { describeStakes, minRaiseTo } from "../../../../shared/tables";
import { ChipIcon } from "@/components/ChipIcon";
import { PlanaryCard } from "@/components/PlanaryCard";
import { SidePanel } from "@/components/SidePanel";
import { TopBar } from "@/components/TopBar";
import { useWallet } from "@/components/WalletProvider";
import { play, unlockAudio } from "@/lib/audio";
import { tableCode } from "@/lib/party";
import { useTable } from "@/lib/useTable";

/**
 * The table.
 *
 * ── Why the seats are rotated ───────────────────────────────────────
 * The handoff lays the six seats out in absolute pixels with "you" at the
 * bottom. At a multiplayer table the viewer can be in any of the six, so the
 * layout below is keyed by *view* position rather than seat number: your own
 * seat is always view 0 and always at the bottom, and everyone else fills the
 * ring clockwise from there. The design's coordinates are unchanged; which
 * player lands on which coordinate is what moves.
 */

/** Where the pot sits, and where chips fly to. */
const POT: [number, number] = [530, 222];

interface Slot {
  /** The seat block's top-left. Absent for view 0, which has its own layout. */
  block?: [number, number];
  /** Where this seat's bet is stacked. */
  bet: [number, number];
  /** Where the dealer button sits when this seat has it. */
  button: [number, number];
  /** The pod's centre, which is what pot winnings fly to. */
  podCenter: [number, number];
}

/** The handoff's coordinates, in design pixels inside the 1060 × 784 panel. */
const SLOTS: readonly Slot[] = [
  { bet: [530, 414], button: [404, 500], podCenter: [746, 506] },
  { block: [20, 300], bet: [250, 404], button: [216, 318], podCenter: [108, 420] },
  { block: [140, 40], bet: [318, 232], button: [330, 150], podCenter: [228, 160] },
  { block: [442, 4], bet: [530, 180], button: [634, 118], podCenter: [530, 124] },
  { block: [744, 40], bet: [742, 232], button: [730, 150], podCenter: [832, 160] },
  { block: [864, 300], bet: [810, 404], button: [844, 318], podCenter: [952, 420] },
];

/** One design pixel, as the stylesheet's container unit. */
const u = (n: number) => `calc(${n} * var(--px))`;

/** A ticking clock, only while something is actually counting down. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

interface Flight {
  id: number;
  from: [number, number];
  to: [number, number];
  amount: number;
}

export function Table({ id, sitOnArrival, justCreated }: { id: string; sitOnArrival: boolean; justCreated: boolean }) {
  const { state, you, status, error, chat, send } = useTable(id);
  const { balance } = useWallet();
  const [watching, setWatching] = useState(false);
  const [copied, setCopied] = useState(false);
  const [raise, setRaise] = useState<{ context: string; to: number } | null>(null);
  const satRef = useRef(false);

  // The first click or key press is what lets the browser make sound.
  useEffect(() => {
    const wake = () => unlockAudio();
    window.addEventListener("pointerdown", wake, { once: true });
    window.addEventListener("keydown", wake, { once: true });
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  // Arriving from a Join button takes the seat without a second click.
  useEffect(() => {
    if (!sitOnArrival || satRef.current || !state || !you) return;
    if (you.seat !== null || !you.verified) return;
    satRef.current = true;
    send({ type: "sit" });
  }, [sitOnArrival, state, you, send]);

  const mySeat = you?.seat ?? null;
  const me = state && mySeat !== null ? state.seats[mySeat] : null;
  const myTurn = Boolean(state && mySeat !== null && state.toAct === mySeat);

  const view = useCallback((seatIndex: number) => (seatIndex - (mySeat ?? 0) + SEATS) % SEATS, [mySeat]);

  const flights = useFlights(state, view);
  const counting = Boolean(state?.deadline && (state.phase === "done" || state.phase === "starting" || state.toAct !== null));
  const now = useNow(counting);
  useSounds(state, you);

  if (!state || !you) {
    return (
      <>
        <TopBar balance={balance} />
        <div className="signing-in" role="status">
          <ChipIcon size={48} letter="H" />
          <p>{status === "closed" ? "Reconnecting to the table…" : "Joining the table…"}</p>
        </div>
      </>
    );
  }

  /**
   * The slider's value is tied to the betting it was chosen for: a new hand,
   * a new street or a raise in front of you all make the old number
   * meaningless, so it falls back to the minimum rather than being reset by
   * an effect a render later.
   */
  const context = `${state.hand}:${state.street}:${state.curBet}:${state.toAct}`;
  const raiseTo = raise && raise.context === context ? raise.to : null;
  const setRaiseTo = (to: number) => setRaise({ context, to });

  const stakes = state.stakes;
  const bb = stakes.bb;
  const streetBets = state.seats.reduce((sum, seat) => sum + (seat?.bet ?? 0), 0);
  const potTotal = state.pot + streetBets;
  const toCall = me ? Math.max(0, state.curBet - me.bet) : 0;
  const maxTo = me ? me.bet + me.stack : 0;
  const minTo = Math.min(maxTo, minRaiseTo(state.curBet, state.lastRaise, bb));
  const canRaise = Boolean(me && myTurn && maxTo > state.curBet);
  const amount = Math.min(maxTo, Math.max(minTo, raiseTo ?? minTo));

  /** A bet or raise sized off the pot, exactly as the bots size theirs. */
  const sizeTo = (fraction: number) =>
    Math.min(
      maxTo,
      state.curBet === 0
        ? Math.max(bb, Math.round((potTotal * fraction) / 10) * 10)
        : state.curBet + Math.max(state.lastRaise || bb, Math.round(((potTotal + toCall) * fraction) / 10) * 10),
    );

  const seated = state.seats.filter(Boolean) as Seat[];
  const inHand = state.seats.filter((s) => s?.inHand).length;
  const remaining = state.deadline ? Math.max(0, state.deadline - now) : 0;

  const statusText = (() => {
    if (status === "closed") return "Reconnecting…";
    if (state.phase === "waiting") return seated.length < 2 ? "Waiting for one more player" : "Waiting for the next hand";
    if (state.phase === "starting") return `Dealing in ${Math.ceil(remaining / 1000)}s`;
    if (state.phase === "done") return state.result?.sub || "Hand over";
    if (me?.folded) return "You folded · watching the hand";
    if (state.toAct === null) return "Dealing…";
    if (myTurn) return toCall > 0 ? `Your turn · ${formatChips(toCall)} to call` : "Your turn · check or bet";
    const who = state.seats[state.toAct];
    return who ? `${who.name} is thinking…` : "Dealing…";
  })();

  const net = me ? me.won - me.total : 0;

  function act(message: Parameters<typeof send>[0], cue?: string) {
    unlockAudio();
    if (cue) play(cue);
    send(message);
  }

  return (
    <>
      <TopBar
        balance={balance}
        pills={
          <>
            <span className="pill pill-strong">No-limit · 6-max</span>
            <span className="pill nums">{describeStakes(stakes)}</span>
            <span className="pill nums">Hand #{state.hand}</span>
          </>
        }
      >
        {state.name === null ? (
          <button
            className="sound-toggle"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(`${window.location.origin}/t/${id}?sit`)
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                })
                .catch(() => {});
            }}
            title="Copy an invite link to this table"
          >
            {copied ? <Check size={15} strokeWidth={2.5} aria-hidden="true" /> : <Copy size={15} strokeWidth={2} aria-hidden="true" />}
            {copied ? "Link copied" : tableCode(id).toUpperCase()}
          </button>
        ) : null}
        {mySeat !== null ? (
          <button className="sound-toggle" onClick={() => act({ type: "leave" }, "click")} title="Stand up and take your chips">
            <LogOut size={15} strokeWidth={2} aria-hidden="true" />
            Leave
          </button>
        ) : null}
      </TopBar>

      <div className="stage">
        <section className="table-panel" aria-label="Hold'em table">
          <div className="felt">
            <span className="felt-stitch" aria-hidden="true" />
            <span className="felt-mark" aria-hidden="true">
              Planary
            </span>
          </div>

          {/* The board: five slots, filled as the streets come out. */}
          <div className="board">
            <div className="board-slots" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="board-slot" />
              ))}
            </div>
            {state.board.map((card, i) => (
              <div
                key={`${cardCode(card)}-${i}`}
                className="board-card"
                style={{ left: u(i * 96), animationDelay: `${i < 3 ? i * 110 : 0}ms` }}
              >
                <CardHolder card={card} ringed={state.winning.includes(cardCode(card))} dimmed={state.winning.length > 0 && !state.winning.includes(cardCode(card))} radius={7} />
              </div>
            ))}
          </div>

          {potTotal > 0 && !state.result ? (
            <div className="pot">
              <div className="pot-inner">
                <span className="pot-label">Pot</span>
                <span className="pot-amount is-bumped nums" key={state.pot}>
                  {formatChips(potTotal)}
                </span>
              </div>
            </div>
          ) : null}

          {state.result ? (
            <div className="result">
              <div className="result-card">
                <span className="result-title">{state.result.title}</span>
                <span className="result-sub">{state.result.sub}</span>
              </div>
            </div>
          ) : null}

          {/* Every seat but the viewer's own. */}
          {state.seats.map((seat, index) => {
            const v = view(index);
            if (v === 0) return null;
            const slot = SLOTS[v];
            return (
              <SeatView
                key={index}
                seat={seat}
                slot={slot}
                isTurn={state.toAct === index}
                winning={state.winning}
                showRing={state.winning.length > 0}
                clock={state.toAct === index && state.deadline ? remaining : null}
              />
            );
          })}

          {/* The viewer's own seat, in the design's bottom-centre layout. */}
          <MeSeat
            seat={mySeat === null ? null : state.seats[mySeat]}
            hole={you.hole}
            winning={state.winning}
            isTurn={myTurn}
            clock={myTurn && state.deadline ? remaining : null}
            dealOrder={0}
          />

          {/* Chips in front of each seat on this street. */}
          {state.seats.map((seat, index) =>
            seat && seat.bet > 0 ? (
              <span
                key={`bet-${index}`}
                className="bet-chip nums"
                style={{ left: u(SLOTS[view(index)].bet[0]), top: u(SLOTS[view(index)].bet[1]) }}
              >
                <span style={{ width: u(22), height: u(22), display: "block" }} aria-hidden="true">
                  <ChipIcon size={22} />
                </span>
                {formatChips(seat.bet)}
              </span>
            ) : null,
          )}

          {/* Chips on their way to the pot, or from it to a winner. */}
          {flights.map((flight) => (
            <span
              key={flight.id}
              className="bet-chip is-flying nums"
              style={{ left: u(flight.at[0]), top: u(flight.at[1]) }}
              aria-hidden="true"
            >
              <span style={{ width: u(22), height: u(22), display: "block" }}>
                <ChipIcon size={22} />
              </span>
              {formatChips(flight.amount)}
            </span>
          ))}

          {inHand > 0 || state.phase === "done" ? (
            <span
              className="dealer-button"
              style={{ left: u(SLOTS[view(state.button)].button[0]), top: u(SLOTS[view(state.button)].button[1]) }}
              title="Dealer button"
            >
              D
            </span>
          ) : null}

          <div className="status">
            {state.phase === "playing" || state.phase === "done" ? (
              <span className="status-street">{state.phase === "done" ? "Hand over" : STREET_LABELS[state.street]}</span>
            ) : null}
            <span className="status-text">{statusText}</span>
            <div className="status-right">
              {status === "closed" ? (
                <span className="status-chip" style={{ cursor: "default" }}>
                  <WifiOff size={13} strokeWidth={2} aria-hidden="true" /> Offline
                </span>
              ) : null}
              {mySeat !== null && me ? (
                <button className="status-chip" onClick={() => act({ type: "sitOut", out: !me.sittingOut }, "click")}>
                  {me.sittingOut ? "Deal me in" : "Sit out"}
                </button>
              ) : null}
            </div>
          </div>

          <div className="actionbar">
            {state.phase === "done" && me && me.inHand ? (
              <>
                <div className="net-side">
                  <span className="net-label">Hand #{state.hand} · your result</span>
                  <span className={`net-amount ${net > 0 ? "net-up" : net < 0 ? "net-down" : ""}`}>
                    {net === 0 ? "Even" : net > 0 ? `+${formatChips(net)}` : `−${formatChips(Math.abs(net))}`}
                  </span>
                </div>
                <button className="act act-next" onClick={() => act({ type: "ready" }, "click")}>
                  <span className="act-top">Next hand</span>
                  <span className="act-sub">{remaining > 0 ? `${Math.ceil(remaining / 1000)}s` : ""}</span>
                </button>
              </>
            ) : (
              <>
                <div className={`raise-side${canRaise ? "" : " is-off"}`}>
                  <div className="presets">
                    {(
                      [
                        ["Min", () => minTo],
                        ["½ pot", () => sizeTo(0.5)],
                        ["Pot", () => sizeTo(1)],
                        ["All-in", () => maxTo],
                      ] as const
                    ).map(([label, value]) => {
                      const target = Math.min(maxTo, Math.max(minTo, value()));
                      return (
                        <button
                          key={label}
                          className={`preset${amount === target ? " is-on" : ""}`}
                          disabled={!canRaise}
                          onClick={() => {
                            play("click");
                            setRaiseTo(target);
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="raise-row">
                    <input
                      type="range"
                      min={minTo}
                      max={maxTo}
                      step={10}
                      value={amount}
                      disabled={!canRaise}
                      onChange={(event) => setRaiseTo(Number(event.target.value))}
                      aria-label="Amount to raise to"
                    />
                    <span className="raise-amount">{formatChips(amount)}</span>
                  </div>
                </div>
                <button className="act act-fold" disabled={!myTurn} onClick={() => act({ type: "fold" }, "fold")}>
                  <span className="act-top">Fold</span>
                </button>
                <button
                  className="act act-call"
                  disabled={!myTurn}
                  onClick={() => act(toCall > 0 ? { type: "call" } : { type: "check" }, toCall > 0 ? (toCall >= (me?.stack ?? 0) ? "allin" : "chip") : "check")}
                >
                  <span className="act-top">{toCall === 0 ? "Check" : toCall >= (me?.stack ?? 0) ? "All-in" : "Call"}</span>
                  <span className="act-sub">{toCall > 0 ? formatChips(Math.min(toCall, me?.stack ?? 0)) : ""}</span>
                </button>
                <button
                  className="act act-raise"
                  disabled={!canRaise}
                  onClick={() => act({ type: "raise", to: amount }, amount >= maxTo ? "allin" : "chips")}
                >
                  <span className="act-top">{amount >= maxTo ? "All-in" : state.curBet === 0 ? "Bet" : "Raise to"}</span>
                  <span className="act-sub">{formatChips(amount)}</span>
                </button>
              </>
            )}
          </div>

          {/* Take a seat, or buy chips back. */}
          {mySeat === null && !watching ? (
            <div className="overlay">
              <div className="overlay-card">
                <span className="overlay-kicker">
                  {state.name ? `${state.name} · Planary Originals` : `Table ${tableCode(id).toUpperCase()}`}
                </span>
                <div className="overlay-title">
                  <span className="off" aria-hidden="true">
                    Take a seat
                  </span>
                  <span className="on">Take a seat</span>
                </div>
                <span className="overlay-copy">
                  Six seats, {describeStakes(stakes).toLowerCase()}. You buy in for {formatChips(stakes.buyIn)} play chips
                  {state.bots ? ", against whoever is here and the house regulars who keep the table warm" : ", against whoever else sits down"}.
                </span>
                <button className="overlay-cta" onClick={() => act({ type: "sit" }, "click")} disabled={!you.verified}>
                  Sit down · {formatChips(stakes.buyIn)} chips
                </button>
                <button className="rank-head" style={{ width: "auto", alignSelf: "flex-start" }} onClick={() => setWatching(true)}>
                  Watch instead
                </button>
              </div>
            </div>
          ) : null}

          {me && me.stack <= 0 && !me.inHand ? (
            <div className="overlay">
              <div className="overlay-card">
                <span className="overlay-kicker">Out of chips</span>
                <div className="overlay-title">
                  <span className="off" aria-hidden="true">
                    Rebuy
                  </span>
                  <span className="on">Rebuy</span>
                </div>
                <span className="overlay-copy">
                  Your stack is gone. Buy another {formatChips(stakes.buyIn)} from your Planary balance and carry on, or leave the table
                  with nothing lost but play chips.
                </span>
                <button className="overlay-cta" onClick={() => act({ type: "rebuy" }, "chips")}>
                  Rebuy {formatChips(stakes.buyIn)} chips
                </button>
                <Link className="rank-head" style={{ width: "auto", alignSelf: "flex-start", textDecoration: "none" }} href="/">
                  Back to the tables
                </Link>
              </div>
            </div>
          ) : null}
        </section>

        <SidePanel state={state} you={you} chat={chat} onChat={(text) => send({ type: "chat", text })} />
      </div>

      {justCreated && state.name === null ? (
        <p className="note" style={{ textAlign: "center", paddingBottom: 16 }}>
          This table is yours. Send the code <strong>{tableCode(id).toUpperCase()}</strong> to whoever you want at it.
        </p>
      ) : null}

      {error ? (
        <div className="toast" role="status">
          {error}
        </div>
      ) : null}
    </>
  );
}

/** A card in its holder, with the showdown ring and the dimming of losing cards. */
function CardHolder({
  card,
  ringed,
  dimmed,
  radius,
  rotate,
}: {
  card: Card | null;
  ringed?: boolean;
  dimmed?: boolean;
  radius: number;
  rotate?: number;
}) {
  return (
    <div
      className="card-holder"
      style={{
        borderRadius: u(radius),
        opacity: dimmed ? 0.45 : 1,
        boxShadow: ringed
          ? `0 0 0 ${u(3)} #fbf1ea, 0 0 0 ${u(6)} var(--cherry), 0 0 ${u(28)} ${u(6)} rgba(255,46,85,0.5)`
          : undefined,
        transform: rotate ? `rotate(${rotate}deg)` : undefined,
      }}
    >
      <PlanaryCard card={card} />
    </div>
  );
}

function Pod({
  seat,
  isTurn,
  isWinner,
  clock,
  wide,
}: {
  seat: Seat;
  isTurn: boolean;
  isWinner: boolean;
  clock: number | null;
  wide?: boolean;
}) {
  return (
    <div className={`pod${isTurn ? " is-turn" : ""}${isWinner ? " is-winner" : ""}`} style={wide ? undefined : undefined}>
      {isTurn ? <span className="pod-ring" aria-hidden="true" /> : null}
      <span className="pod-avatar" style={{ background: avatarBg(seat), color: avatarInk(seat) }} aria-hidden="true">
        {seat.initial}
      </span>
      <span className="pod-who">
        <span className="pod-name">{seat.name}</span>
        <span className="pod-stack">
          {seat.allIn ? "All-in" : seat.sittingOut && !seat.inHand ? "Sitting out" : formatChips(seat.stack)}
        </span>
      </span>
      {clock !== null ? (
        <span className="pod-clock" aria-hidden="true">
          <i style={{ width: `${Math.max(0, Math.min(100, (clock / 25_000) * 100))}%` }} />
        </span>
      ) : null}
    </div>
  );
}

/** Avatar colours: the house players have their own, everyone else gets the cherry. */
function avatarBg(seat: Seat) {
  const BOT_COLOURS: Record<string, [string, string]> = {
    Mika: ["#ff5b2e", "#2a0710"],
    Juno: ["#23308f", "#fbf1ea"],
    Ravi: ["#e8c7a2", "#2a0710"],
    Lea: ["#b3122e", "#fbf1ea"],
    Otto: ["#1d1846", "#fbf1ea"],
  };
  return seat.isBot ? (BOT_COLOURS[seat.name]?.[0] ?? "#5e1a34") : "#ff2e55";
}

function avatarInk(seat: Seat) {
  const BOT_INK: Record<string, string> = {
    Mika: "#2a0710",
    Juno: "#fbf1ea",
    Ravi: "#2a0710",
    Lea: "#fbf1ea",
    Otto: "#fbf1ea",
  };
  return seat.isBot ? (BOT_INK[seat.name] ?? "#f8ecee") : "#ffffff";
}

function SeatView({
  seat,
  slot,
  isTurn,
  winning,
  showRing,
  clock,
}: {
  seat: Seat | null;
  slot: Slot;
  isTurn: boolean;
  winning: string[];
  showRing: boolean;
  clock: number | null;
}) {
  if (!seat) return null;
  const [x, y] = slot.block ?? [0, 0];
  return (
    <div className={`seat${seat.folded ? " is-folded" : ""}`} style={{ left: u(x), top: u(y) }}>
      {seat.cards > 0 ? (
        <div className="seat-cards">
          {[0, 1].map((i) => {
            const card = seat.hole?.[i] ?? null;
            const ringed = Boolean(card && winning.includes(cardCode(card)));
            return (
              <div key={i} className={`seat-card${seat.folded ? " is-mucked" : ""}`} style={{ left: u(i * 40) }}>
                {card ? (
                  <div className="card-flip">
                    <CardHolder card={card} ringed={ringed} dimmed={showRing && !ringed} radius={5} rotate={i === 0 ? -4 : 4} />
                  </div>
                ) : (
                  <CardHolder card={null} radius={5} rotate={i === 0 ? -4 : 4} />
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      <Pod seat={seat} isTurn={isTurn} isWinner={seat.won > 0} clock={clock} />
      {seat.label ? <span className={`seat-label lab-${seat.labelKind || "check"}`}>{seat.label}</span> : null}
    </div>
  );
}

/** The viewer's own seat: the cards centred at the bottom, the pod beside them. */
function MeSeat({
  seat,
  hole,
  winning,
  isTurn,
  clock,
}: {
  seat: Seat | null;
  hole: Card[] | null;
  winning: string[];
  isTurn: boolean;
  clock: number | null;
  dealOrder: number;
}) {
  if (!seat) return null;
  const cards = hole ?? [];
  const showRing = winning.length > 0;
  return (
    <>
      {seat.cards > 0 ? (
        <div className={`me-cards${seat.folded ? " is-folded" : ""}`}>
          {[0, 1].map((i) => {
            const card = cards[i] ?? null;
            const ringed = Boolean(card && winning.includes(cardCode(card)));
            return (
              <div key={i} className="me-card" style={{ left: u(i * 104) }}>
                <CardHolder card={card} ringed={ringed} dimmed={showRing && !ringed} radius={8} rotate={i === 0 ? -4 : 4} />
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="me-pod">
        <Pod seat={seat} isTurn={isTurn} isWinner={seat.won > 0} clock={clock} wide />
        {seat.label ? <span className={`seat-label lab-${seat.labelKind || "check"}`}>{seat.label}</span> : null}
      </div>
    </>
  );
}

/**
 * The chips that fly: bets to the pot when a street closes, and the pot to
 * the winner when the hand does.
 *
 * Both are read off the change between two states rather than announced by
 * the server, which keeps the protocol about the game rather than about the
 * animation.
 */
function useFlights(state: TableState | null, view: (seat: number) => number) {
  const previous = useRef<TableState | null>(null);
  const [flights, setFlights] = useState<(Flight & { at: [number, number] })[]>([]);
  const nextId = useRef(0);
  const timers = useRef<number[]>([]);

  // The only thing that should stop a chip mid-flight is leaving the table.
  useEffect(() => {
    const pending = timers;
    return () => pending.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    if (!state) return;
    const before = previous.current;
    previous.current = state;
    if (!before) return;

    const made: Flight[] = [];
    const bets = before.seats.map((s) => s?.bet ?? 0);
    const nowBets = state.seats.map((s) => s?.bet ?? 0);

    // A street closed: every bet on the felt slides into the middle.
    if (bets.some((b) => b > 0) && nowBets.every((b) => b === 0) && state.pot > before.pot) {
      bets.forEach((bet, index) => {
        if (bet > 0) made.push({ id: ++nextId.current, from: SLOTS[view(index)].bet, to: POT, amount: bet });
      });
    }

    // The hand ended: the pot goes to whoever won it.
    if (state.result && !before.result) {
      state.seats.forEach((seat, index) => {
        if (!seat || seat.won <= 0) return;
        made.push({ id: ++nextId.current, from: POT, to: SLOTS[view(index)].podCenter, amount: seat.won });
      });
    }

    if (made.length === 0) return;
    setFlights((current) => [...current, ...made.map((f) => ({ ...f, at: f.from }))]);
    // A frame at the start position, then the transition carries them over,
    // and they are cleared once they land.
    //
    // These timers deliberately outlive this effect. It re-runs on every
    // message from the table — several a second — so cancelling them on
    // cleanup would abandon every chip at the spot it started from, which is
    // precisely what a stuck pile of pills on the felt looks like.
    timers.current.push(
      window.setTimeout(() => {
        setFlights((current) => current.map((f) => (made.some((m) => m.id === f.id) ? { ...f, at: f.to } : f)));
      }, 30),
      window.setTimeout(() => {
        setFlights((current) => current.filter((f) => !made.some((m) => m.id === f.id)));
      }, 700),
    );
  }, [state, view]);

  return flights;
}

/**
 * The table's sounds, also read off the change between states: a label that
 * has just appeared on a seat says what that player did, which is exactly
 * what wants a noise.
 */
function useSounds(state: TableState | null, you: You | null) {
  const previous = useRef<TableState | null>(null);

  useEffect(() => {
    if (!state) return;
    const before = previous.current;
    previous.current = state;
    if (!before) return;

    if (state.hand !== before.hand && state.hand > 0) {
      play("shuffle");
      // The cards are dealt one at a time; the sound follows them round.
      const dealt = state.seats.filter((s) => s?.inHand).length * 2;
      for (let i = 0; i < dealt; i++) play("deal", { delay: 0.42 + i * 0.09 });
    }

    if (state.board.length > before.board.length) {
      const added = state.board.length - before.board.length;
      for (let i = 0; i < added; i++) play("deal", { delay: i * 0.11 });
    }

    state.seats.forEach((seat, index) => {
      const was = before.seats[index];
      if (!seat || !was || seat.labelKind === was.labelKind) return;
      if (seat.labelKind === "fold") play("fold");
      else if (seat.labelKind === "check") play("check");
      else if (seat.labelKind === "call") play("chip");
      else if (seat.labelKind === "raise") play("chips");
      else if (seat.labelKind === "allin") play("allin");
    });

    if (you?.seat !== null && you !== null && state.toAct === you.seat && before.toAct !== you.seat) play("turn");

    if (state.result && !before.result) {
      const mine = you?.seat !== null && you?.seat !== undefined ? state.seats[you.seat] : null;
      if (mine && mine.won > 0) {
        const showdown = state.street === "showdown";
        play("win", { step: showdown ? 4 : 2 });
        play("coins", { n: showdown ? 16 : 10, dur: showdown ? 1.2 : 0.8 });
      } else {
        play("chips");
      }
    }
  }, [state, you]);
}
