/**
 * Checks the game's arithmetic — the evaluator, the deal and the pots.
 *
 * Run it with:
 *   npm run odds
 *
 * Planary publishes each game's odds and then checks them, rather than
 * asking anyone to take them on faith. For a slot machine that means
 * computing the return twice (scripts/rtp.mjs). For Hold'em it means this:
 *
 *   1. Every one of the 2'598'960 distinct five-card hands is scored, and the
 *      counts per category are compared with the known combinatorics. If the
 *      evaluator called one flush a straight, one of these ten numbers would
 *      be wrong — there is nowhere for a mistake to hide.
 *   2. The ordering is checked on the cases that decide real pots: the wheel
 *      is the lowest straight, a kicker breaks a tied pair, the best five of
 *      seven is found.
 *   3. The committed deal is reproducible from its seed, is a real
 *      permutation, and is tamper-evident.
 *   4. Every pot split conserves the pot to the last chip, over a few
 *      hundred thousand random all-in tangles.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The shared modules import each other the way a bundler expects, without
 * file extensions, which plain node cannot resolve. Rather than bend the
 * source to suit the test — the source is what ships — the test takes a copy
 * with the extensions written in and runs against that.
 */
const staging = mkdtempSync(join(tmpdir(), "planary-odds-"));
mkdirSync(staging, { recursive: true });
for (const name of ["fair.ts", "cards.ts", "holdem.ts", "equity.ts", "pots.ts"]) {
  const source = readFileSync(join(here, "..", "shared", name), "utf8");
  writeFileSync(join(staging, name), source.replace(/(from "\.\/[A-Za-z]+)"/g, '$1.ts"'));
}
const cards = await import(`file://${join(staging, "cards.ts")}`);
const holdem = await import(`file://${join(staging, "holdem.ts")}`);
const equity = await import(`file://${join(staging, "equity.ts")}`);
const pots = await import(`file://${join(staging, "pots.ts")}`);

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}

const hand = (text) => text.split(" ").map((c) => cards.parseCode(c));

// ── 1. Every five-card hand ──────────────────────────

section("Every five-card hand");

/**
 * The exact number of distinct five-card hands in each category. These are
 * arithmetic, not measurements: if a number here disagrees with the
 * evaluator, the evaluator is wrong.
 */
const EXPECTED = {
  9: 4, // royal flush
  8: 36, // straight flush, not to the ace
  7: 624, // four of a kind
  6: 3744, // full house
  5: 5108, // flush
  4: 10200, // straight
  3: 54912, // three of a kind
  2: 123552, // two pair
  1: 1098240, // one pair
  0: 1302540, // high card
};

const deck = cards.orderedDeck();
const counts = Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, 0]));
let dealt = 0;
const five = new Array(5);
for (let a = 0; a < 48; a++) {
  five[0] = deck[a];
  for (let b = a + 1; b < 49; b++) {
    five[1] = deck[b];
    for (let c = b + 1; c < 50; c++) {
      five[2] = deck[c];
      for (let d = c + 1; d < 51; d++) {
        five[3] = deck[d];
        for (let e = d + 1; e < 52; e++) {
          five[4] = deck[e];
          // describe() splits the royal flush out of category 8, which is how
          // a player ranks it, so the counts are compared the same way.
          counts[holdem.describe(holdem.score5(five)).category]++;
          dealt++;
        }
      }
    }
  }
}

check("all 2'598'960 hands were dealt", dealt === 2_598_960, String(dealt));
for (const [category, expected] of Object.entries(EXPECTED).sort((x, y) => Number(y[0]) - Number(x[0]))) {
  const name = holdem.HAND_RANKINGS.find((r) => r.category === Number(category))?.name ?? category;
  check(`${name}: ${expected.toLocaleString("en")}`, counts[category] === expected, `got ${counts[category]}`);
}

// ── 2. The order they beat each other in ────────────

section("Which hand wins");

const beats = (better, worse) => holdem.score5(hand(better)) > holdem.score5(hand(worse));
const ties = (one, other) => holdem.score5(hand(one)) === holdem.score5(hand(other));

check("a royal flush beats a king-high straight flush", beats("As Ks Qs Js 10s", "Ks Qs Js 10s 9s"));
check("four of a kind beats a full house", beats("2s 2h 2d 2c 3s", "As Ah Ad Ks Kh"));
check("a flush beats a straight", beats("2s 5s 7s 9s Js", "9h 8s 7d 6c 5h"));
check("the wheel is the lowest straight", beats("6h 5s 4d 3c 2h", "As 5h 4d 3c 2s"));
check("the wheel still beats three of a kind", beats("As 5h 4d 3c 2s", "Ks Kh Kd 4c 2s"));
check("an ace-high flush beats a king-high flush", beats("As Js 8s 5s 3s", "Ks Qs 8s 5s 3s"));
check("a kicker breaks a tied pair", beats("As Ah Ks 7d 4c", "As Ah Qs 7d 4c"));
check("the same hand in different suits ties", ties("As Ah Ks 7d 4c", "Ad Ac Kh 7s 4d"));
check("two pair is read high pair first", beats("As Ah 2s 2h 3c", "Ks Kh Qs Qh 3c"));
check("a full house compares the trips first", beats("3s 3h 3d 2s 2h", "2s 2h 2d As Ah"));

section("Best five of seven");

check(
  "finds the flush hidden in seven cards",
  holdem.describe(holdem.bestScore(hand("As 2h 7s 9s Js Ks 4d"))).title === "Flush",
);
check(
  "finds the straight across hole and board",
  holdem.describe(holdem.bestScore(hand("9h 8s 7d 6c 5h Ks Qd"))).title === "Straight",
);
check(
  "prefers the full house over the flush it also holds",
  holdem.describe(holdem.bestScore(hand("As Ah Ad Ks Kh 2s 3s"))).title === "Full house",
);
check(
  "names the exact two pair",
  holdem.describe(holdem.bestScore(hand("Ks Kh 5s 5h 9d 2c 3c"))).detail === "Kings and fives",
);
check("the best five really are five", holdem.bestHand(hand("As Ah Ad Ks Kh 2s 3s")).cards.length === 5);
check(
  "pocket pairs are named before the flop",
  holdem.describeHole(hand("6s 6h")).detail === "Pocket sixes",
);
check("suited hole cards say so", holdem.describeHole(hand("As Ks")).detail === "Ace-king suited");

// ── 3. The committed deal ────────────────────────────

section("The deal");

const SEED = "a".repeat(64);
const first = await cards.shuffledDeck(SEED, "player-one|player-two", 7);
const again = await cards.shuffledDeck(SEED, "player-one|player-two", 7);
const other = await cards.shuffledDeck(SEED, "player-one|player-two", 8);

check("the same seed deals the same deck", first.map(cards.code).join() === again.map(cards.code).join());
check("the next hand deals a different one", first.map(cards.code).join() !== other.map(cards.code).join());
check("it is 52 cards", first.length === 52);
check("every card appears exactly once", new Set(first.map(cards.code)).size === 52);
check(
  "the cards are the same 52 the deck is built from",
  new Set(first.map(cards.code)).size === new Set(cards.orderedDeck().map(cards.code)).size &&
    first.every((card) => cards.orderedDeck().some((c) => c.r === card.r && c.s === card.s)),
);

const drawn = first.slice(0, 17).map(cards.code);
check("a true deal checks out", cards.checkDeal(first, drawn).ok);
const tampered = [...drawn];
tampered[4] = tampered[4] === "As" ? "Ks" : "As";
const caught = cards.checkDeal(first, tampered);
check("a swapped card is caught", !caught.ok && caught.at === 4);
check("a card code survives the round trip", cards.code(cards.parseCode("10h")) === "10h");

// ── 4. The pot always adds up ────────────────────────

section("Side pots");

check(
  "one all-in makes two pots",
  (() => {
    const built = pots.buildPots([
      { seat: 0, total: 200, live: true },
      { seat: 1, total: 1000, live: true },
      { seat: 2, total: 1000, live: true },
    ]);
    return built.length === 2 && built[0].amount === 600 && built[1].amount === 1600 && built[0].seats.length === 3 && built[1].seats.length === 2;
  })(),
);

check(
  "a folded player's chips stay in the pot but cannot be won by them",
  (() => {
    const built = pots.buildPots([
      { seat: 0, total: 100, live: false },
      { seat: 1, total: 100, live: true },
      { seat: 2, total: 100, live: true },
    ]);
    return built.length === 1 && built[0].amount === 300 && !built[0].seats.includes(0);
  })(),
);

check(
  "the odd chip goes to the first winner left of the button",
  (() => {
    const shares = pots.sharePot(101, [3, 5]);
    return shares[0] === 51 && shares[1] === 50 && shares[0] + shares[1] === 101;
  })(),
);

check(
  "a three-way split of 100 pays 34/33/33",
  (() => {
    const shares = pots.sharePot(100, [1, 2, 3]);
    return shares.join() === "34,33,33";
  })(),
);

check(
  "a bet only called by a shorter all-in has its excess returned",
  (() => {
    const { pots: built, refunds } = pots.buildSplit([
      { seat: 0, total: 500, live: true },
      { seat: 1, total: 200, live: true },
    ]);
    return built.length === 2 && built[0].amount === 400 && built[1].amount === 300 && built[1].seats.join() === "0" && refunds.size === 0;
  })(),
);

check(
  "a bet by someone no longer in the hand goes back to them",
  (() => {
    // What happens when a player bets and then drops their connection: the
    // top layer has no live contender, so it cannot be a pot.
    const { pots: built, refunds } = pots.buildSplit([
      { seat: 0, total: 500, live: false },
      { seat: 1, total: 20, live: true },
    ]);
    return built.length === 1 && built[0].amount === 40 && refunds.get(0) === 480;
  })(),
);

// The invariant that matters: chips are never created and never destroyed.
// Every chip contributed is either in a pot that somebody can win, or on its
// way back to whoever put it in.
let worstDrift = 0;
let checked = 0;
let sawRefund = 0;
for (let run = 0; run < 200_000; run++) {
  const players = 2 + Math.floor(Math.random() * 5);
  const contributions = [];
  for (let seat = 0; seat < players; seat++) {
    contributions.push({
      seat,
      total: Math.floor(Math.random() * 2000),
      live: Math.random() > 0.3,
    });
  }
  if (!contributions.some((c) => c.live && c.total > 0)) continue;
  const staked = contributions.reduce((sum, c) => sum + c.total, 0);
  if (staked === 0) continue;

  const { pots: built, refunds } = pots.buildSplit(contributions);
  const inPots = built.reduce((sum, p) => sum + p.amount, 0);
  const returned = [...refunds.values()].reduce((sum, n) => sum + n, 0);
  if (returned > 0) sawRefund++;
  worstDrift = Math.max(worstDrift, Math.abs(inPots + returned - staked));

  const scores = new Map();
  for (const c of contributions) if (c.live) scores.set(c.seat, Math.floor(Math.random() * 3));
  const order = contributions.map((c) => c.seat);
  const won = pots.awardPots(built, scores, order);
  const paid = [...won.values()].reduce((sum, amount) => sum + amount, 0);
  // Every pot has a live contender by construction, so all of it is paid out.
  worstDrift = Math.max(worstDrift, Math.abs(paid + returned - staked));
  checked++;
}
check(
  `${checked.toLocaleString("en")} random all-in tangles account for every chip`,
  worstDrift === 0,
  `worst drift ${worstDrift}`,
);
check("and some of them did need a refund", sawRefund > 0, `${sawRefund} did`);

// ── 5. The odds the side panel prints ────────────────

section("Win chance");

// Not an exact figure — it is a simulation — but a wrong one would be wrong
// by a lot, and these three are known within a point or so.
const aces = equity.equity(hand("As Ah"), [], 1, 20_000);
check("aces are about 85% against one hand", aces > 0.82 && aces < 0.88, aces.toFixed(3));

const dominated = equity.equity(hand("2s 7h"), [], 1, 20_000);
check("seven-deuce is about 35% against one hand", dominated > 0.3 && dominated < 0.4, dominated.toFixed(3));

const made = equity.equity(hand("As Ks"), hand("Ad Kd 2c"), 1, 20_000);
check("two pair on the flop is a big favourite", made > 0.85, made.toFixed(3));

// A straight flush on the board: both hands play it and chop, except when
// the opponent turns up the card that beats it. This is the tie arithmetic —
// a split has to count as half a win, not as nothing.
const chop = equity.equity(hand("As Ah"), hand("2s 3s 4s 5s 6s"), 1, 20_000);
check("aces chop with a straight flush on the board", chop > 0.44 && chop < 0.5, chop.toFixed(3));
const nuts = equity.equity(hand("7s 8h"), hand("2s 3s 4s 5s 6s"), 1, 4_000);
check("holding the seven of spades there wins outright", nuts > 0.99, nuts.toFixed(3));

console.log(failures === 0 ? "\nAll good." : `\n${failures} check${failures === 1 ? "" : "s"} failed.`);
process.exit(failures === 0 ? 0 : 1);
