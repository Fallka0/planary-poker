/**
 * Recomputes what every machine returns, and refuses to agree with it.
 *
 * Run from any project carrying a copy of shared/slots.ts:
 *   node scripts/rtp.mjs
 *
 * The reels are checked two independent ways, which have to agree exactly:
 *
 *   1. The closed form in `oddsOf()` — products of per-reel chances, which is
 *      what the paytable UI calls at runtime.
 *   2. Brute force here — every stop combination the machine has, each one
 *      paid by the same `payOut()` the machine itself runs. For Supernova that
 *      is about 39 million windows; it takes a while and it is exact.
 *
 * The bonus games are checked the same two ways, the second one statistical:
 * the exact chains in `oddsOf()` against a few hundred thousand bonus games
 * played by the same `play()` the machine room runs, fed from a fast
 * generator instead of the committed stream. Agreement within four standard
 * errors means the code pays what the arithmetic says it pays.
 *
 * If the closed form and brute force disagree, the closed form is wrong. If
 * the simulation and the chain disagree, one of them is. If either disagrees
 * with the figure printed on the cabinet (`machine.rtp`), the cabinet is
 * lying, and this exits non-zero. A slot machine whose stated return is
 * unchecked is exactly the thing players are right not to trust.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Same staging trick as fair-test.mjs: the shared modules import each other
// without file extensions, the way a bundler expects and plain node does not.
const staging = mkdtempSync(join(tmpdir(), "planary-rtp-"));
mkdirSync(staging, { recursive: true });
for (const name of ["fair.ts", "slots.ts"]) {
  const source = readFileSync(join(here, "..", "shared", name), "utf8");
  writeFileSync(join(staging, name), source.replace(/(from "\.\/[A-Za-z]+)"/g, '$1.ts"'));
}
const slots = await import(`file://${join(staging, "slots.ts")}`);

/** How close the printed figure has to be to the real one: a hundredth of a per cent. */
const TOLERANCE = 0.0001;
/** How close a machine, or its bought bonus, has to be to the house's 96%. */
const ON_TARGET = 0.0015;
const BUY_ON_TARGET = 0.0025;
/** Bonus games played per machine for the statistical check. */
const BONUS_GAMES = Number(process.env.BONUS_GAMES ?? 200_000);

const pct = (value) => `${(value * 100).toFixed(3)}%`;
const pad = (text, width) => String(text).padEnd(width);

/**
 * Every window this machine can show, paid by the machine's own rules.
 *
 * Returns the mean return per unit of total stake, the share of spins that pay
 * anything or start the bonus game, the chance of the bonus game, and the
 * expected version-1 free spins — all exact averages over every combination.
 */
function bruteForce(machine) {
  const lengths = machine.reels.map((reel) => reel.length);
  const combos = lengths.reduce((a, b) => a * b, 1);
  // One line's stake, so returns come out as a multiple of total stake.
  const lineBet = 1;
  const totalBet = machine.lines.length;
  // Each reel's window at each stop, worked out once rather than per combination.
  const windows = machine.reels.map((reel, r) => reel.map((_, stop) => slots.windowAt(machine, machine.reels.map((_, i) => (i === r ? stop : 0)))[r]));

  const stops = new Array(lengths.length).fill(0);
  const window = new Array(lengths.length);
  let paid = 0;
  let hits = 0;
  let bonuses = 0;
  let freeSpins = 0;

  for (let n = 0; n < combos; n++) {
    for (let r = 0; r < stops.length; r++) window[r] = windows[r][stops[r]];
    const result = slots.payOut(machine, window, lineBet);
    const bonus = slots.starts(machine, window);
    if (result.returned > 0 || result.freeSpins > 0 || bonus) hits += 1;
    if (bonus) bonuses += 1;
    paid += result.returned;
    freeSpins += result.freeSpins;

    // Odometer over the reels.
    for (let reel = 0; reel < stops.length; reel++) {
      if (++stops[reel] < lengths[reel]) break;
      stops[reel] = 0;
    }
  }

  return { combos, perSpin: paid / combos / totalBet, hitRate: hits / combos, bonusChance: bonuses / combos, freeSpins: freeSpins / combos };
}

/** A fast, seeded generator with the same shape as the committed stream. Not for play: for counting. */
function fastSource(seed) {
  let a = seed >>> 0 || 1;
  let b = 0x9e3779b9;
  let c = 0x243f6a88;
  let d = 0xb7e15162;
  const next = () => {
    // sfc32
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t >>> 0;
  };
  return {
    async below(n) {
      const limit = Math.floor(0x1_0000_0000 / n) * n;
      for (;;) {
        const draw = next();
        if (draw < limit) return draw % n;
      }
    },
  };
}

/** Plays the bonus game `games` times through `play()`, bought, and returns the mean and standard error of what it paid. */
async function simulateBonus(machine, games) {
  const source = fastSource(0x5107 + machine.id.length);
  let sum = 0;
  let sumSq = 0;
  let biggest = 0;
  // One line's stake, so pays come out as a multiple of total stake.
  const totalBet = machine.lines.length;
  for (let i = 0; i < games; i++) {
    const round = await slots.play(machine, source, 1, true);
    const multiple = round.returned / totalBet;
    sum += multiple;
    sumSq += multiple * multiple;
    if (multiple > biggest) biggest = multiple;
  }
  const mean = sum / games;
  const variance = sumSq / games - mean * mean;
  return { mean, se: Math.sqrt(variance / games), biggest };
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The machines that have left the floor: their strips must still say what they said.
console.log("Retired machines");
for (const machine of slots.ALL_VERSIONS.filter((m) => !slots.MACHINES.includes(m))) {
  const odds = slots.oddsOf(machine);
  check(`${machine.name} (version ${machine.version}) still returns its printed ${pct(machine.rtp)}`, Math.abs(odds.rtp - machine.rtp) < TOLERANCE, pct(odds.rtp));
}

for (const machine of slots.MACHINES) {
  const odds = slots.oddsOf(machine);
  const started = Date.now();
  const force = bruteForce(machine);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  // Version 1 free spins pay like a paid spin, so they multiply a spin's return.
  const forcedBase = force.perSpin * (1 + force.freeSpins);
  const closedBase = odds.lineRtp + odds.scatterRtp;
  const forced = forcedBase + force.bonusChance * odds.bonusValue;

  console.log(`\n${machine.name} — ${machine.reels.length} reels, ${machine.lines.length} line${machine.lines.length > 1 ? "s" : ""}, ${machine.volatility ?? "classic"}`);
  console.log(`  ${force.combos.toLocaleString("en-GB")} windows walked in ${seconds}s`);
  console.log(`  closed form ${pct(odds.rtp)}   brute force ${pct(forced)}   printed ${pct(machine.rtp)}`);
  console.log(`  pays or starts the bonus on ${pct(force.hitRate)} of spins (printed ${pct(machine.hitRate)})`);

  check("the reels: closed form matches brute force", Math.abs(closedBase - forcedBase) < 1e-9, `${closedBase} vs ${forcedBase}`);
  if (machine.feature) {
    check("the bonus starts as often as the closed form says", Math.abs(odds.bonusChance - force.bonusChance) < 1e-12, `${odds.bonusChance} vs ${force.bonusChance}`);
  }
  check(`the printed return is the real one (${pct(machine.rtp)})`, Math.abs(machine.rtp - forced) < TOLERANCE, `printed ${pct(machine.rtp)}, really ${pct(forced)}`);
  check(`the printed hit rate is the real one (${pct(machine.hitRate)})`, Math.abs(machine.hitRate - force.hitRate) < TOLERANCE, `printed ${pct(machine.hitRate)}, really ${pct(force.hitRate)}`);
  check(`it is built to ${pct(slots.TARGET_RTP)}`, Math.abs(forced - slots.TARGET_RTP) < ON_TARGET, `off target by ${pct(Math.abs(forced - slots.TARGET_RTP))}`);
  check("no stake can pay a fraction of a chip", machine.lineBets.every((bet) => Number.isInteger(bet) && bet >= 1));

  if (machine.feature) {
    const sim = await simulateBonus(machine, BONUS_GAMES);
    const exact = odds.buyRtp !== null ? odds.buyRtp * machine.buy : odds.bonusValue;
    const off = Math.abs(sim.mean - exact);
    console.log(`  bonus once in ${Math.round(1 / odds.bonusChance).toLocaleString("en-GB")} spins, worth ${exact.toFixed(3)}× stake bought;`);
    console.log(`  ${BONUS_GAMES.toLocaleString("en-GB")} played: ${sim.mean.toFixed(3)}× ± ${sim.se.toFixed(3)}, the biggest ${Math.round(sim.biggest).toLocaleString("en-GB")}×`);
    check("the bonus game pays what its chain says (within 4 standard errors)", off < 4 * sim.se, `${sim.mean} vs ${exact}, ${(off / sim.se).toFixed(1)} SE apart`);
    if (machine.buy) {
      check(`buying it returns ${pct(odds.buyRtp)}, near the house's ${pct(slots.TARGET_RTP)}`, Math.abs(odds.buyRtp - slots.TARGET_RTP) < BUY_ON_TARGET);
      const perLine = machine.buy * machine.lines.length;
      check("the bonus price comes out in whole chips at every stake", Math.abs(perLine - Math.round(perLine)) < 1e-9, `${machine.buy}× on ${machine.lines.length} lines`);
    }
  }

  console.log("\n  Where the return comes from");
  for (const row of odds.bySymbol) {
    console.log(
      `    ${pad(`${row.run} × ${row.symbol}`, 14)} pays ${pad(row.pays, 6)} once in ${pad(Math.round(1 / row.chance).toLocaleString("en-GB"), 12)} lines → ${pct(row.share)}`,
    );
  }
  if (odds.scatterRtp) console.log(`    ${pad("scatter", 14)} ${pct(odds.scatterRtp)}`);
  if (odds.bonusRtp) console.log(`    ${pad("bonus game", 14)} ${pct(odds.bonusRtp)}`);
}

console.log(failures ? `\n${failures} check${failures > 1 ? "s" : ""} failed\n` : "\nEvery machine returns what it says it returns.\n");
process.exit(failures ? 1 : 0);
