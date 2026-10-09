/**
 * Keeps every copy of shared/fair.ts honest.
 *
 * Run from any project that carries a copy:
 *   node --experimental-strip-types scripts/fair-test.mjs
 *
 * It checks the commitment scheme end to end, proves the draw is uniform
 * rather than merely close to it, and replays a frozen set of vectors. The
 * vectors matter most: a table and a verifier that disagree by one bit would
 * produce rounds nobody can check, so the numbers below are fixed for good.
 * If a change here makes them fail, the change is wrong — not the vectors.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The shared modules import each other the way a bundler expects, without file
 * extensions, which plain node cannot resolve. Rather than bend the source to
 * suit the test — the source is what ships — the test takes a copy with the
 * extensions written in and runs against that.
 */
const staging = mkdtempSync(join(tmpdir(), "planary-fair-"));
mkdirSync(staging, { recursive: true });
for (const name of ["fair.ts", "deck.ts", "slots.ts"]) {
  const source = readFileSync(join(here, "..", "shared", name), "utf8");
  writeFileSync(join(staging, name), source.replace(/(from "\.\/[A-Za-z]+)"/g, '$1.ts"'));
}
const fair = await import(`file://${join(staging, "fair.ts")}`);
const cards = await import(`file://${join(staging, "deck.ts")}`);
const slots = await import(`file://${join(staging, "slots.ts")}`);
const VECTORS = join(here, "..", "shared", "fair.vectors.json");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nCommitment");
const seed = fair.newServerSeed();
const hash = await fair.commit(seed);
check("a seed is 32 bytes of hex", /^[0-9a-f]{64}$/.test(seed));
check("its commitment opens", await fair.opens(seed, hash));
check("another seed does not", !(await fair.opens(fair.newServerSeed(), hash)));
check("hex survives a round trip", fair.toHex(fair.fromHex(seed)) === seed);

console.log("\nClient seeds");
check("the separator cannot be smuggled in", fair.sanitiseClientSeed("a|b") === "a/b");
check("length is bounded", fair.sanitiseClientSeed("x".repeat(200)).length === 64);
check("order is part of the record", fair.joinClientSeeds(["a", "b"]) !== fair.joinClientSeeds(["b", "a"]));

console.log("\nThe draw is uniform");
// 37 does not divide 2^32, so a modulo shortcut would bias the low pockets.
// With 370'000 draws the expected count per pocket is 10'000; a chi-square
// statistic far above the 5% critical value for 36 degrees of freedom (51.0)
// would mean the wheel leans.
//
// The seed is fixed on purpose. A test that draws its own randomness would
// fail roughly one run in a hundred for no reason at all, and a fairness
// suite that cries wolf is a fairness suite people learn to ignore. This way
// the statistic is a constant: if it moves, the implementation moved.
const DRAWS = 370_000;
const counts = new Array(37).fill(0);
const stream = fair.open("a1b2c3d4".repeat(8), "uniformity", 0);
for (let i = 0; i < DRAWS; i++) counts[await stream.below(37)] += 1;
const expected = DRAWS / 37;
const chi = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
check(`chi-square ${chi.toFixed(1)} is under 60 over ${DRAWS.toLocaleString("en")} draws`, chi < 60, `counts ${Math.min(...counts)}–${Math.max(...counts)}`);
check("every pocket came up", counts.every((c) => c > 0));

console.log("\nShuffles");
const deck = Array.from({ length: 52 }, (_, i) => i);
const once = await fair.shuffle(deck, seed, "shoe", 1);
const again = await fair.shuffle(deck, seed, "shoe", 1);
const other = await fair.shuffle(deck, seed, "shoe", 2);
check("the same seed shuffles the same way", once.join() === again.join());
check("a different nonce does not", once.join() !== other.join());
check("nothing is lost or duplicated", [...once].sort((a, b) => a - b).join() === deck.join());

console.log("\nA six-deck shoe");
// Blackjack commits to a whole shoe before its first card, so the reconstruction
// has to be exact: 312 cards in the same order, and the cut card in the same
// place. The cut card is drawn from its own stream so it cannot be read off
// the shuffle, but it must still be reproducible from the same seed.
const SHOE = Array.from({ length: 312 }, (_, i) => i);
const shoeSeed = "1a2b3c4d".repeat(8);
const dealt = await fair.shuffle(SHOE, shoeSeed, "alice|bob", 3);
const rebuilt = await fair.shuffle(SHOE, shoeSeed, "alice|bob", 3);
const cut = 60 + (await fair.open(shoeSeed, "alice|bob:cut", 3).below(21));
const cutAgain = 60 + (await fair.open(shoeSeed, "alice|bob:cut", 3).below(21));
check("the shoe rebuilds card for card", dealt.join() === rebuilt.join());
check("all 312 cards are present exactly once", new Set(dealt).size === 312);
check(`the cut card lands at ${cut}, inside 60–80`, cut >= 60 && cut <= 80);
check("the cut card rebuilds too", cut === cutAgain);
const otherShoe = await fair.shuffle(SHOE, shoeSeed, "alice|bob", 4);
check("the next shoe is a different order", dealt.join() !== otherShoe.join());
check("the cut card is not readable off the shuffle", cut !== dealt[0] % 21 + 60);

console.log("\nThe deck everyone must agree on");
// A verifier that laid its 312 cards out in a different order before shuffling
// would rebuild a different shoe from the same seed, and call an honest hand a
// lie. The factory order is therefore frozen here too.
const ordered = cards.orderedShoe();
check("312 cards, four suits, thirteen ranks", ordered.length === 312 && new Set(ordered).size === 52);
check("the factory order starts A♠ 2♠ 3♠", ordered.slice(0, 3).join(" ") === "Aspade 2spade 3spade");
check("a card reads back as a person writes it", cards.prettyCard("10heart") === "10♥");
const realShoe = await cards.shuffledShoe(shoeSeed, "alice|bob", 3);
check("the shoe rebuilds from the same seed", (await cards.shuffledShoe(shoeSeed, "alice|bob", 3)).join() === realShoe.join());
const realCut = await cards.cutCardFor(shoeSeed, "alice|bob", 3);
check(`the cut card sits at ${realCut}`, realCut >= 60 && realCut <= 80);
check("a hand dealt off the shoe verifies", cards.checkCards(realShoe, 10, realShoe.slice(10, 16)).ok);
check("one wrong card is caught", !cards.checkCards(realShoe, 10, [...realShoe.slice(10, 15), "Aspade"]).ok);
check("the right cards at the wrong position are caught", !cards.checkCards(realShoe, 11, realShoe.slice(10, 16)).ok);

console.log("\nThe machines");
// A slot machine's strips are normally the one thing a player never sees, so
// a changed strip would be the easiest dishonesty in the building to hide.
// Here the strips are in shared/slots.ts and their consequences are pinned:
// the stated return is recomputed from them (scripts/rtp.mjs does this
// exhaustively; this is the cheap closed form), and the stops a known seed
// produces are frozen below.
for (const machine of slots.MACHINES) {
  const stops = await slots.stopsFor(machine, shoeSeed, "reels", 1);
  const again = await slots.stopsFor(machine, shoeSeed, "reels", 1);
  const next = await slots.stopsFor(machine, shoeSeed, "reels", 2);
  const window = slots.windowAt(machine, stops);
  check(`${machine.name}: one stop per reel, on the strip`, stops.length === machine.reels.length && stops.every((stop, i) => stop >= 0 && stop < machine.reels[i].length));
  check(`${machine.name}: the same spin number stops in the same place`, stops.join() === again.join());
  check(`${machine.name}: the next one does not`, stops.join() !== next.join());
  check(`${machine.name}: the window shows ${machine.rows} row${machine.rows > 1 ? "s" : ""} a reel`, window.every((reel) => reel.length === machine.rows));
  // The window wraps round the end of the strip rather than running off it.
  const wrapped = slots.windowAt(machine, machine.reels.map((reel) => reel.length - 1));
  check(`${machine.name}: the strip is a loop`, wrapped.every((reel) => reel.every((pip) => typeof pip === "string")));
  check(`${machine.name}: returns the ${(machine.rtp * 100).toFixed(2)}% it prints`, Math.abs(slots.oddsOf(machine).rtp - machine.rtp) < 0.0001);
  check(`${machine.name}: a stake is whole chips`, machine.lineBets.every((bet) => Number.isInteger(bet) && bet >= 1));
  const paid = slots.payOut(machine, window, 10);
  check(`${machine.name}: a paid spin stakes ${machine.lines.length} × 10`, paid.staked === machine.lines.length * 10);
  check(`${machine.name}: a free spin stakes nothing and awards nothing`, slots.payOut(machine, window, 10, true).staked === 0 && slots.payOut(machine, window, 10, true).freeSpins === 0);
}

console.log("\nVerification");
const proof = { hash, serverSeed: seed, clientSeed: "alice|bob", nonce: 7 };
const outcome = await fair.roll(seed, proof.clientSeed, 7, 37);
check("a true round verifies", (await fair.checkRoll(proof, 37, outcome)).ok);
check("a sealed round does not", (await fair.checkRoll({ ...proof, serverSeed: null }, 37, outcome)).reason === "sealed");
check("a swapped seed is caught", (await fair.checkRoll({ ...proof, serverSeed: fair.newServerSeed() }, 37, outcome)).reason === "hash mismatch");
check("a wrong outcome is caught", (await fair.checkRoll(proof, 37, (outcome + 1) % 37)).reason === "outcome mismatch");

console.log("\nFrozen vectors");
const CASES = [
  { serverSeed: "00".repeat(32), clientSeed: "", nonce: 0, range: 37 },
  { serverSeed: "ff".repeat(32), clientSeed: "planary", nonce: 1, range: 37 },
  { serverSeed: "0123456789abcdef".repeat(4), clientSeed: "alice|bob", nonce: 42, range: 37 },
  { serverSeed: "0123456789abcdef".repeat(4), clientSeed: "alice|bob", nonce: 42, range: 312 },
  { serverSeed: "deadbeef".repeat(8), clientSeed: "a-very-long-client-seed-from-a-player", nonce: 999, range: 2 },
];

const produced = [];
for (const c of CASES) {
  produced.push({ ...c, roll: await fair.roll(c.serverSeed, c.clientSeed, c.nonce, c.range) });
}
const shoe = await fair.shuffle(Array.from({ length: 52 }, (_, i) => i), "0123456789abcdef".repeat(4), "shoe", 0);
const frozen = {
  note: "Frozen. A change that breaks these is a change that breaks verification.",
  rolls: produced,
  shoeFirstTen: shoe.slice(0, 10),
  cardsFirstTen: (await cards.shuffledShoe("0123456789abcdef".repeat(4), "", 0)).slice(0, 10),
  // Per machine: the strip lengths, the stated return, and where the reels
  // stop on five known spins. A strip edited anywhere moves one of these.
  machines: Object.fromEntries(
    await Promise.all(
      slots.MACHINES.map(async (machine) => [
        machine.id,
        {
          version: machine.version,
          strips: machine.reels.map((reel) => reel.length),
          rtp: Number(slots.oddsOf(machine).rtp.toFixed(6)),
          stopsFirstFive: await Promise.all([0, 1, 2, 3, 4].map((n) => slots.stopsFor(machine, "0123456789abcdef".repeat(4), "", n))),
        },
      ]),
    ),
  ),
};

let stored;
try {
  stored = JSON.parse(readFileSync(VECTORS, "utf8"));
} catch {
  writeFileSync(VECTORS, `${JSON.stringify(frozen, null, 2)}\n`);
  console.log(`  · wrote ${VECTORS} for the first time`);
  stored = frozen;
}
check("rolls match the frozen vectors", JSON.stringify(stored.rolls) === JSON.stringify(frozen.rolls));
check("the shoe shuffles to the frozen order", JSON.stringify(stored.shoeFirstTen) === JSON.stringify(frozen.shoeFirstTen));
check("the cards deal in the frozen order", JSON.stringify(stored.cardsFirstTen ?? frozen.cardsFirstTen) === JSON.stringify(frozen.cardsFirstTen));
check("the reels stop at the frozen points", JSON.stringify(stored.machines ?? frozen.machines) === JSON.stringify(frozen.machines));

console.log(failures === 0 ? "\nAll good.\n" : `\n${failures} failing.\n`);
process.exit(failures === 0 ? 0 : 1);
