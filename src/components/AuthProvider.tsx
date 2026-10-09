"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { buildAuthUrl, signOutUrl } from "@/lib/auth";
import { absorbSessionFromHash, clearSession, loadSession, verifySession } from "@/lib/session";
import { ChipIcon } from "./ChipIcon";

export interface PlanaryUser {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: PlanaryUser;
  accessToken: string;
  /** Chips and seats are keyed by the Planary account. */
  playerId: string;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const BOUNCES_KEY = "ppk.signin-bounces";
const MAX_BOUNCES = 3;
const BOUNCE_WINDOW_MS = 60_000;

/** Recent hops to planary-auth, so a token that keeps failing can't trap the player in a redirect loop. */
function recentBounces(): number[] {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(BOUNCES_KEY) ?? "[]") as unknown;
    const now = Date.now();
    return Array.isArray(raw) ? raw.filter((t): t is number => typeof t === "number" && now - t < BOUNCE_WINDOW_MS) : [];
  } catch {
    return [];
  }
}

function recordBounce(bounces: number[]) {
  try {
    window.sessionStorage.setItem(BOUNCES_KEY, JSON.stringify([...bounces, Date.now()]));
  } catch {
    // Storage blocked: no loop guard, same as before.
  }
}

function resetBounces() {
  try {
    window.sessionStorage.removeItem(BOUNCES_KEY);
  } catch {
    // Nothing stored.
  }
}

/** Only signed-in players get in. Without a session we hop to planary-auth, which sends
 *  already-signed-in people straight back (single sign-on), so this is usually invisible.
 *  Returns false instead of redirecting when the last few hops all came back unusable. */
function goSignIn(): boolean {
  const bounces = recentBounces();
  if (bounces.length >= MAX_BOUNCES) return false;
  recordBounce(bounces);
  window.location.replace(buildAuthUrl("login", window.location.href.split("#")[0], true));
  return true;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<{ user: PlanaryUser; accessToken: string } | null>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    let active = true;
    const stored = absorbSessionFromHash() ?? loadSession();
    if (!stored) {
      if (!goSignIn()) queueMicrotask(() => setStuck(true));
      return;
    }
    setSession({ user: { id: stored.userId, email: stored.email, name: stored.name }, accessToken: stored.accessToken });

    void verifySession(stored).then((ok) => {
      if (!active) return;
      if (ok) {
        resetBounces();
        return;
      }
      clearSession();
      if (!goSignIn()) {
        setSession(null);
        setStuck(true);
      }
    });
    // Tokens last an hour; fetch a fresh one the same silent way shortly before that.
    const timer = window.setTimeout(() => {
      clearSession();
      goSignIn();
    }, Math.max(0, stored.expiresAt * 1000 - Date.now() - 60_000));
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    // End the Planary session too, or single sign-on would put the player straight back in.
    window.location.assign(signOutUrl());
  }, []);

  if (stuck) {
    return (
      <div className="signing-in" role="alert">
        <ChipIcon size={56} letter="H" />
        <p>Sign-in keeps failing, so we stopped retrying.</p>
        <button
          className="btn btn-cta"
          onClick={() => {
            resetBounces();
            goSignIn();
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="signing-in" role="status">
        <ChipIcon size={56} letter="H" />
        <p>Signing you in…</p>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ ...session, playerId: `u-${session.user.id}`, signOut }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
