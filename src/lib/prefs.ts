/**
 * Small preferences that live in this browser only.
 *
 * A module-level store rather than component state, so the panel can read it
 * during its first render instead of flipping open after an effect runs —
 * and so `useSyncExternalStore` can give the server a sensible answer
 * (`true`) without touching localStorage, which does not exist there.
 */

const RANKINGS_KEY = "holdem-rankings-open";

let cached: boolean | null = null;
const subscribers = new Set<() => void>();

export function rankingsOpen(): boolean {
  if (cached === null) {
    try {
      cached = window.localStorage.getItem(RANKINGS_KEY) !== "0";
    } catch {
      cached = true;
    }
  }
  return cached;
}

export function setRankingsOpen(open: boolean) {
  cached = open;
  try {
    window.localStorage.setItem(RANKINGS_KEY, open ? "1" : "0");
  } catch {
    // Storage blocked: the choice lasts this page view.
  }
  subscribers.forEach((fn) => fn());
}

export function subscribeRankings(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
