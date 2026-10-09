"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PartySocket from "partysocket";
import { ArrowRight, Users } from "lucide-react";
import { formatChips, type LobbyMessage, type LobbyTable, SEATS } from "../../shared/protocol";
import { describeStakes, STAKE_LEVELS, shortStakes, type Stakes } from "../../shared/tables";
import { useWallet } from "@/components/WalletProvider";
import { TopBar } from "@/components/TopBar";
import { createTable, LobbyError, PARTY_HOST, parseTableInput, resolveCode } from "@/lib/party";
import { play, unlockAudio } from "@/lib/audio";

/** The lobby's live table list, straight from the lobby room. */
function useLobby() {
  const [tables, setTables] = useState<{ house: LobbyTable[]; tables: LobbyTable[] }>({ house: [], tables: [] });
  const socketRef = useRef<PartySocket | null>(null);

  useEffect(() => {
    const socket = new PartySocket({ host: PARTY_HOST, party: "lobby", room: "main" });
    socketRef.current = socket;
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as LobbyMessage;
      if (msg.type === "tables") setTables({ house: msg.house, tables: msg.tables });
    });
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, []);

  return tables;
}

function SeatDots({ table }: { table: LobbyTable }) {
  return (
    <span className="seat-dots" aria-label={`${table.seated} of ${SEATS} seats taken`}>
      {Array.from({ length: SEATS }, (_, i) => (
        <span
          key={i}
          className={`seat-dot${i < table.seated - table.bots ? " is-taken" : i < table.seated ? " is-bot" : ""}`}
        />
      ))}
    </span>
  );
}

function TableRow({ table, onJoin }: { table: LobbyTable; onJoin: (id: string) => void }) {
  const humans = table.seated - table.bots;
  const full = table.seated >= SEATS && table.bots === 0;
  return (
    <button className="table-row" onClick={() => onJoin(table.id)} disabled={full}>
      <span className="table-row-name">{table.name ?? table.id.slice(2).toUpperCase()}</span>
      <span className="table-row-stakes">{shortStakes(table.stakes)}</span>
      <span className="table-row-right">
        <SeatDots table={table} />
        <span>
          {humans === 0 ? "Open" : humans === 1 ? "1 player" : `${humans} players`}
          {table.bots > 0 ? ` · ${table.bots} house` : ""}
        </span>
        <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
      </span>
    </button>
  );
}

export default function Lobby() {
  const router = useRouter();
  const { balance } = useWallet();
  const { house, tables } = useLobby();
  const [codeInput, setCodeInput] = useState("");
  const [stakes, setStakes] = useState<Stakes>(STAKE_LEVELS[1]);
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [bots, setBots] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function join(id: string) {
    unlockAudio();
    play("click");
    router.push(`/t/${id}?sit`);
  }

  async function openCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = parseTableInput(codeInput);
    if (!parsed) {
      setError("Codes are six letters and numbers, like k7m2qx.");
      return;
    }
    if ("id" in parsed) return join(parsed.id);
    setBusy(true);
    try {
      join(await resolveCode(parsed.code));
    } catch (problem) {
      setError(problem instanceof LobbyError ? problem.message : "Couldn't find that table.");
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    setError(null);
    setBusy(true);
    try {
      const id = await createTable({ stakes, visibility, bots });
      unlockAudio();
      play("click");
      router.push(`/t/${id}?new`);
    } catch (problem) {
      setError(problem instanceof LobbyError ? problem.message : "Couldn't open a table.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar balance={balance} pills={<span className="pill pill-strong">No-limit · 6-max</span>} />

      <div className="lobby">
        <section className="lobby-hero">
          <span className="lobby-kicker">Planary Originals</span>
          <h1>
            <span className="off" aria-hidden="true">
              Hold&rsquo;em
            </span>
            <span style={{ position: "relative" }}>Hold&rsquo;em</span>
          </h1>
          <p>
            No-limit Texas Hold&rsquo;em, six seats to a table. Sit at a house table and play straight away, or open your own and
            send the code to whoever you want at it. Every deck is committed to before it is dealt and published when the hand
            ends, so you can check any hand you played.
          </p>
        </section>

        <section className="panel">
          <h2>House tables</h2>
          <div className="table-list">
            {house.length === 0 ? <span className="note">Reaching the tables…</span> : null}
            {house.map((table) => (
              <TableRow key={table.id} table={table} onJoin={join} />
            ))}
          </div>
          <span className="note">
            The house keeps a few regulars at these so there is always a hand going. They give their seats up as players arrive.
          </span>
        </section>

        {tables.length > 0 ? (
          <section className="panel">
            <h2>Open tables</h2>
            <div className="table-list">
              {tables.map((table) => (
                <TableRow key={table.id} table={table} onJoin={join} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="panel">
          <h2>Join by code</h2>
          <form className="row" onSubmit={openCode}>
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <label htmlFor="code">Table code or link</label>
              <input
                id="code"
                value={codeInput}
                onChange={(event) => setCodeInput(event.target.value)}
                placeholder="k7m2qx"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <button className="btn btn-ghost" type="submit" disabled={busy || !codeInput.trim()}>
              Open table
            </button>
          </form>
        </section>

        <section className="panel">
          <h2>Open your own</h2>
          <div className="row">
            <div className="field">
              <label htmlFor="stakes">Blinds</label>
              <select
                id="stakes"
                value={`${stakes.sb}/${stakes.bb}`}
                onChange={(event) => {
                  const [sb] = event.target.value.split("/").map(Number);
                  setStakes(STAKE_LEVELS.find((level) => level.sb === sb) ?? STAKE_LEVELS[1]);
                }}
              >
                {STAKE_LEVELS.map((level) => (
                  <option key={level.sb} value={`${level.sb}/${level.bb}`}>
                    {shortStakes(level)} · buy in {formatChips(level.buyIn)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Who can join</label>
              <div className="choice">
                <button className={visibility === "private" ? "is-on" : ""} onClick={() => setVisibility("private")}>
                  By code only
                </button>
                <button className={visibility === "public" ? "is-on" : ""} onClick={() => setVisibility("public")}>
                  Listed here
                </button>
              </div>
            </div>
            <div className="field">
              <label>House players</label>
              <div className="choice">
                <button className={bots ? "" : "is-on"} onClick={() => setBots(false)}>
                  Off
                </button>
                <button className={bots ? "is-on" : ""} onClick={() => setBots(true)}>
                  Fill empty seats
                </button>
              </div>
            </div>
            <button className="btn btn-cta" onClick={open} disabled={busy}>
              <Users size={16} strokeWidth={2} aria-hidden="true" />
              Open table
            </button>
          </div>
          <span className="note">
            {describeStakes(stakes)} · everyone buys in for {formatChips(stakes.buyIn)}. Your stack goes back to your Planary
            balance when you stand up.
          </span>
          {error ? <span className="error">{error}</span> : null}
        </section>

        <p className="note" style={{ textAlign: "center" }}>
          Play money only. Planary Chips have no cash value and cannot be bought, sold or exchanged.
        </p>
      </div>
    </>
  );
}
