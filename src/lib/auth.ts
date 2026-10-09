export const AUTH_BASE_URL = process.env.NEXT_PUBLIC_AUTH_BASE_URL || "https://auth.planary.ch";
export const CASINO_URL = process.env.NEXT_PUBLIC_CASINO_URL || "https://casino.planary.ch";

/** `auto` = single sign-on: an existing Planary session comes straight back without a click. */
export function buildAuthUrl(mode: "login" | "signup", returnTo: string, auto = false) {
  const target = new URL(mode === "signup" ? "/signup" : "/", AUTH_BASE_URL);
  target.searchParams.set("returnTo", returnTo);
  if (auto) target.searchParams.set("auto", "1");
  return target.toString();
}

export function signOutUrl() {
  const target = new URL("/logout", AUTH_BASE_URL);
  target.searchParams.set("returnTo", CASINO_URL);
  return target.toString();
}
