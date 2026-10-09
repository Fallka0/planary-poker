/**
 * Recomputes what every machine returns, and refuses to agree with it.
 *
 * Run from any project carrying a copy of shared/slots.ts:
 *   node scripts/rtp.mjs
 *
 * Two independent calculations, which have to agree:
 *
 *   1. The closed form in `oddsOf()` — products of per-reel symbol
 *      frequencies, which is what the paytable UI calls at runtime.
 *   2. Brute force here — every stop combination the machine has, each one
 *      paid by the same `payOut()` the machine itself runs. For Night Press
 *      that is 24.3 million windows; it takes a few seconds and it is exact.
 *
 * If those two disagree, the closed form is wrong. If either disagrees with
 * the figure printed on the cabinet (`machine.rtp`), the cabinet is lying, and
 * this exits non-zero. A slot machine whose stated return is unchecked is
 * exactly the thing players are right not to trust.
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

const pct = (value) => `${(value * 100).toFixed(3)}%`;
const pad = (text, width) => String(text).padEnd(width);

/**
 * Every window this machine can show, paid by the machine's own rules.
 *
 * Returns the mean return per unit of total stake, the share of spins that pay
 * anything, and the expected free spins — all as exact rationals over the
 * number of combinations, because that is simply what the average is.
 */
function bruteForce(machine) {
  const lengths = machine.reels.map((reel) => reel.length);
  const combos = lengths.reduce((a, b) => a * b, 1);
  // One line's stake, so returns come out as a multiple of total stake.
  const lineBet = 1;
  const totalBet = machine.lines.length;

  const stops = new Array(lengths.length).fill(0);
  let paid = 0;
  let hits = 0;
  let freeSpins = 0;

  for (let n = 0; n < combos; n++) {
    const window = slots.windowAt(machine, stops);
    const result = slots.payOut(machine, window, lineBet);
    if (result.returned > 0 || result.freeSpins > 0) hits += 1;
    paid += result.returned;
    freeSpins += result.freeSpins;

    // Odometer over the reels.
    for (let reel = 0; reel < stops.length; reel++) {
      if (++stops[reel] < lengths[reel]) break;
      stops[reel] = 0;
    }
  }

  return { combos, perSpin: paid / combos / totalBet, hitRate: hits / combos, freeSpins: freeSpins / combos };
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

for (const machine of slots.MACHINES) {
  const odds = slots.oddsOf(machine);
  const started = Date.now();
  const force = bruteForce(machine);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  // A free spin stakes nothing and pays like a paid one, so the expected free
  // spins per spin simply multiply a single spin's return.
  const forced = force.perSpin * (1 + force.freeSpins);

  console.log(`\n${machine.name} — ${machine.reels.length} reels, ${machine.lines.length} line${machine.lines.length > 1 ? "s" : ""}`);
  console.log(`  ${force.combos.toLocaleString("en-GB")} windows walked in ${seconds}s`);
  console.log(`  closed form ${pct(odds.rtp)}   brute force ${pct(forced)}   printed ${pct(machine.rtp)}`);
  console.log(`  pays on ${pct(force.hitRate)} of spins (printed ${pct(machine.hitRate)})${machine.scatter ? `, ${force.freeSpins.toFixed(4)} free spins a spin` : ""}`);

  check("the closed form matches brute force", Math.abs(odds.rtp - forced) < 1e-9, `${odds.rtp} vs ${forced}`);
  check(`the printed return is the real one (${pct(machine.rtp)})`, Math.abs(machine.rtp - forced) < TOLERANCE, `printed ${pct(machine.rtp)}, really ${pct(forced)}`);
  check(`the printed hit rate is the real one (${pct(machine.hitRate)})`, Math.abs(machine.hitRate - force.hitRate) < TOLERANCE, `printed ${pct(machine.hitRate)}, really ${pct(force.hitRate)}`);
  check(`it is built to ${pct(slots.TARGET_RTP)}`, Math.abs(forced - slots.TARGET_RTP) < 0.0015, `off target by ${pct(Math.abs(forced - slots.TARGET_RTP))}`);
  check("no stake can pay a fraction of a chip", machine.lineBets.every((bet) => Number.isInteger(bet) && bet >= 1));

  console.log("\n  Where the return comes from");
  for (const row of odds.bySymbol) {
    const share = row.share * (1 + odds.freeSpins);
    console.log(
      `    ${pad(`${row.run} × ${row.symbol}`, 14)} pays ${pad(row.pays, 6)} once in ${pad(Math.round(1 / row.chance).toLocaleString("en-GB"), 12)} lines → ${pct(share)}`,
    );
  }
  if (machine.scatter) console.log(`    ${pad("scatter", 14)} ${pct(odds.scatterRtp)}, and ${odds.freeSpins.toFixed(4)} free spins a spin`);
}

console.log(failures ? `\n${failures} check${failures > 1 ? "s" : ""} failed\n` : "\nEvery machine returns what it says it returns.\n");
process.exit(failures ? 1 : 0);
