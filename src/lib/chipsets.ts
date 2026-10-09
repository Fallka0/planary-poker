// Chip designs from the shop: print colours per denomination. Mirrored in the game tables (same ids).

export type ChipInks = { fill: string; ink: string };

const CLASSIC: Record<number, ChipInks> = {
  10: { fill: "#f6eee4", ink: "#2a0710" },
  50: { fill: "#ff2e55", ink: "#f6eee4" },
  100: { fill: "#1d1846", ink: "#f6eee4" },
  500: { fill: "#e8c7a2", ink: "#5a0f22" },
  1000: { fill: "#1a7a52", ink: "#f6eee4" },
  5000: { fill: "#3b0f5c", ink: "#e8c7a2" },
};

export const CHIPSETS: Record<string, Record<number, ChipInks>> = {
  classic: CLASSIC,
  "chips-mono": {
    10: { fill: "#f6eee4", ink: "#22060e" },
    50: { fill: "#22060e", ink: "#f6eee4" },
    100: { fill: "#8a7f78", ink: "#f6eee4" },
    500: { fill: "#3d3533", ink: "#e8dccf" },
    1000: { fill: "#b9aea6", ink: "#22060e" },
    5000: { fill: "#0c0906", ink: "#b9aea6" },
  },
  "chips-midnight": {
    10: { fill: "#c9d6ff", ink: "#0f1b3d" },
    50: { fill: "#3b5bdb", ink: "#e7ecff" },
    100: { fill: "#0f1b3d", ink: "#9fb4ff" },
    500: { fill: "#6d28d9", ink: "#ede9fe" },
    1000: { fill: "#0ea5a4", ink: "#e7fffd" },
    5000: { fill: "#e7ecff", ink: "#6d28d9" },
  },
  "chips-sunset": {
    10: { fill: "#ffe3d3", ink: "#8a1c0a" },
    50: { fill: "#ff5b2e", ink: "#fff1e6" },
    100: { fill: "#ff2e8a", ink: "#fff0f6" },
    500: { fill: "#ffb199", ink: "#5a0f22" },
    1000: { fill: "#8a1c0a", ink: "#ffe3d3" },
    5000: { fill: "#ffd166", ink: "#8a1c0a" },
  },
  "chips-gold": {
    10: { fill: "#fbe7a6", ink: "#5a3a06" },
    50: { fill: "#e2a93b", ink: "#2a1a02" },
    100: { fill: "#b8761c", ink: "#fff3c4" },
    500: { fill: "#2a1a02", ink: "#f7d77e" },
    1000: { fill: "#f7d77e", ink: "#2a1a02" },
    5000: { fill: "#5a3a06", ink: "#fbe7a6" },
  },
};

export function chipInks(set: string | null | undefined, value: number): ChipInks {
  return (CHIPSETS[set ?? "classic"] ?? CLASSIC)[value] ?? CLASSIC[value] ?? { fill: "var(--cherry)", ink: "var(--paper)" };
}
