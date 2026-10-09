"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useAuth } from "./AuthProvider";

export const CASINO_API = process.env.NEXT_PUBLIC_CASINO_API || "https://planary-casino-api.planary.workers.dev";

interface WalletState {
  /** Null until the first answer from the casino wallet. */
  balance: number | null;
  /** Your card back from the Planary Casino shop (the dealer's face-down card and the shuffle, on your screen). */
  cardback: string | null;
  refresh: () => void;
  /** The table server reports balances as it moves chips; use them without a round trip. */
  setBalance: (balance: number) => void;
}

const WalletContext = createContext<WalletState | null>(null);

/** Chips live in the Planary Casino wallet. This also tells friends where we are (every 30 s). */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const { accessToken } = useAuth();
  const pathname = usePathname();
  const [balance, setBalance] = useState<number | null>(null);
  const [cardback, setCardback] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetch(`${CASINO_API}/v1/me`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((me: { balance: number; cardback: string | null } | null) => {
        if (!me) return;
        setBalance(me.balance);
        setCardback(me.cardback ?? null);
      })
      .catch(() => {});
  }, [accessToken]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const table = pathname.match(/^\/t\/([tp]-[a-z0-9]{6})/)?.[1] ?? null;
  useEffect(() => {
    const ping = () =>
      fetch(`${CASINO_API}/v1/presence`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ where: "poker", table }),
        keepalive: true,
      }).catch(() => {});
    void ping();
    const timer = window.setInterval(ping, 30_000);
    return () => window.clearInterval(timer);
  }, [accessToken, table]);

  return <WalletContext.Provider value={{ balance, cardback, refresh, setBalance }}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
