"use client";

import { useState, useSyncExternalStore } from "react";
import { ChevronDown } from "lucide-react";
import { HAND_RANKINGS } from "../../shared/holdem";
import type { LogEntry, TableState, You } from "../../shared/protocol";
import { rankingsOpen, setRankingsOpen, subscribeRankings } from "@/lib/prefs";
import { Chat } from "./Chat";
import type { ChatMessage } from "../../shared/protocol";

/** How many log lines fit, which depends on whether the rankings are open. */
function logLines(rankingsOpen: boolean) {
  return rankingsOpen ? 8 : 18;
}

export function SidePanel({
  state,
  you,
  chat,
  onChat,
}: {
  state: TableState;
  you: You;
  chat: ChatMessage[];
  onChat: (text: string) => void;
}) {
  // Remembered across visits, as the handoff specifies, and open by default.
  const open = useSyncExternalStore(subscribeRankings, rankingsOpen, () => true);
  const [tab, setTab] = useState<"log" | "chat">("log");

  const hand = you.handName;
  const opponents = state.seats.filter((s, i) => s && s.inHand && !s.folded && i !== you.seat).length;
  const lines: LogEntry[] = state.log.slice(0, logLines(open));

  return (
    <aside className="side" aria-label="Hand information">
      <div className="box">
        <span className="box-label">Your hand</span>
        <span className="hand-title">{hand ? hand.title : "—"}</span>
        <span className="hand-detail">{hand ? hand.detail : "Waiting for the next deal"}</span>
        {you.equity !== null && opponents > 0 ? (
          <>
            <div className="equity-row">
              <span>Win chance vs {opponents === 1 ? "1 player" : `${opponents} players`}</span>
              <span className="equity-value">{Math.round(you.equity * 100)}%</span>
            </div>
            <div className="equity-bar" role="img" aria-label={`Win chance ${Math.round(you.equity * 100)} percent`}>
              <i style={{ width: `${Math.max(2, Math.round(you.equity * 100))}%` }} />
            </div>
          </>
        ) : null}
      </div>

      <div className="box" style={{ gap: 4 }}>
        <button className="rank-head" onClick={() => setRankingsOpen(!open)} aria-expanded={open}>
          <span>Hand rankings</span>
          <span className="rank-head-right">
            {open ? "Hide" : "Show"}
            <ChevronDown size={16} strokeWidth={2.5} className={`rank-chevron${open ? " is-open" : ""}`} aria-hidden="true" />
          </span>
        </button>
        <div className={`rank-body${open ? "" : " is-closed"}`}>
          {HAND_RANKINGS.map((rank) => (
            <div key={rank.name} className={`rank-row${hand && hand.category === rank.category ? " is-yours" : ""}`}>
              <span>{rank.name}</span>
              <span className="rank-example">{rank.example}</span>
            </div>
          ))}
        </div>
      </div>

      {/*
        The handoff's side panel ends with the hand log. A multiplayer table
        also needs somewhere to talk, and a fourth box would push the panel
        past the bottom of the screen — so the two share one, which keeps the
        column at the three boxes the design has.
      */}
      <div className="box" style={{ flex: 1, minHeight: 0 }}>
        <div className="tabs">
          <button className={`tab${tab === "log" ? " is-on" : ""}`} onClick={() => setTab("log")} aria-pressed={tab === "log"}>
            Hand log
          </button>
          <button className={`tab${tab === "chat" ? " is-on" : ""}`} onClick={() => setTab("chat")} aria-pressed={tab === "chat"}>
            Table talk
          </button>
        </div>
        {tab === "log" ? (
          <div className="log">
            {lines.length === 0 ? <span className="log-line">The table is waiting for a hand.</span> : null}
            {lines.map((entry) => (
              <span key={entry.id} className="log-line">
                {entry.text}
              </span>
            ))}
          </div>
        ) : (
          <Chat messages={chat} myId={you.playerId} onSend={onChat} />
        )}
      </div>
    </aside>
  );
}
