"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ArrowLeft } from "lucide-react";
import { formatChips } from "../../shared/protocol";
import { CASINO_URL } from "@/lib/auth";
import { audio, unlockAudio } from "@/lib/audio";
import { ChipIcon } from "./ChipIcon";
import { ChipMark } from "./PlanaryCard";

/**
 * The bar across the top: where you are, what it costs, what you have, and
 * the sound toggle — which is shared with every other Planary game.
 */
export function TopBar({ pills, balance, children }: { pills?: React.ReactNode; balance: number | null; children?: React.ReactNode }) {
  // The mute setting is an external store shared with every Planary game, so
  // it is read as one rather than copied into component state.
  const muted = useSyncExternalStore(
    (onChange) => audio()?.subscribe(onChange) ?? (() => {}),
    () => audio()?.isMuted() ?? false,
    () => false,
  );

  return (
    <header className="topbar">
      <Link className="topbar-back" href={CASINO_URL} aria-label="Back to Planary Casino">
        <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
      </Link>
      <span style={{ width: 40, height: 40, display: "block" }} aria-hidden="true">
        <ChipMark letter="H" fill="#ff2e55" ink="#f6eee4" />
      </span>
      <div className="topbar-title">
        <strong>Hold&rsquo;em</strong>
        <span>Planary Casino</span>
      </div>
      {pills ? <div className="pills">{pills}</div> : null}
      <div className="topbar-right">
        {children}
        <div className="balance" title="Your Planary Chips">
          <ChipIcon size={22} />
          <strong>{balance === null ? "—" : formatChips(balance)}</strong>
          <span>chips</span>
        </div>
        <button
          className="sound-toggle"
          onClick={() => {
            const engine = audio();
            if (!engine) return;
            // Turning sound *on* is a gesture the browser accepts, so it is
            // also the moment the audio context can be started.
            unlockAudio();
            engine.setMuted(!engine.isMuted());
          }}
        >
          <span className={`sound-dot${muted ? " is-off" : ""}`} aria-hidden="true" />
          {muted ? "Sound off" : "Sound on"}
        </button>
      </div>
    </header>
  );
}
