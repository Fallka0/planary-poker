# Planary Hold'em

Multiplayer no-limit Texas Hold'em for Planary Casino, live at [poker.planary.ch](https://poker.planary.ch). Six seats to a table, three house tables that fill their spare seats with house players, players' own tables (public or private) with a code and a link, table chat. Play money only.

- `src/`: Next.js app (lobby and table UI), deployed on Vercel
- `party/`: Cloudflare Worker with two Durable Objects via partyserver. `table.ts` runs each table (deck, blinds, betting, side pots, showdown, the house players); `lobby.ts` lists public tables, opens new ones and looks up codes
- `shared/`: the hand evaluator, the Monte Carlo equity, the house players' decisions, the pot arithmetic, the client/server protocol, and `tables.ts`: the stakes and what a buy-in means

## House rules

Standard no-limit Hold'em, nothing tilted:

- Six seats. Blinds post every hand; heads-up the button is the small blind and acts first before the flop, last after it.
- A raise must be at least the size of the last one, and at least a big blind. Going all-in for less is allowed and does not reopen the betting.
- Side pots are built from each player's own total contribution, level by level. A player can only win what they matched.
- An uncalled bet comes straight back: if the only call was a shorter all-in, the excess is returned when the street closes.
- The odd chip in a split pot goes to the first winner to the dealer's left.
- Best five of seven at showdown. The winning five are ringed; everything else dims.
- Run out the board with no more betting once at most one player can still act, with every hand face up.

## Your chips, and the table's

Sitting down moves chips out of your Planary wallet and onto the table; standing up moves what is left back. Between those two moments the wallet is not part of the hand, because the size of the stack in front of you *is* the game — it decides what you can be raised off and what an all-in costs.

That makes the table the only record of those chips, so it is written to durable storage on every move. If the table is restarted mid-hand it cannot fairly resume one, so the hand is voided and every chip goes back to the stack it came from. A seat whose player does not come back is cashed out to their wallet, on a timer that survives the worker being evicted.

## Fair deal

Every hand's deck is committed to before a card is dealt — the table publishes the SHA-256 of a seed it has drawn, players contribute their own seeds, and the shuffle comes from both. When the hand ends the seed is published, so anyone can rebuild the deck and check every card that came out of it, in order.

Blackjack commits per shoe; Hold'em can commit per hand, because the deck is fresh every hand. The price is that revealing a hand's deck reveals the hole cards that were mucked in it. That is a real cost, and the reason the reveal waits until the hand is over: nobody ever learns a card they could still act on.

`npm run odds` is the check. It scores all 2'598'960 distinct five-card hands and compares the ten category counts with the known combinatorics, replays the orderings that decide real pots, proves the deal is reproducible and tamper-evident, and asserts over a few hundred thousand random all-in tangles that pots and refunds account for every chip. `npm run fair` runs the shared commitment vectors every Planary game is held to.

## House players

The three house tables keep a few regulars at them so a player who arrives alone still gets a hand. They see their own two cards, the board and the betting, and nothing else — `decide` in `shared/bots.ts` is given no access to anyone else's cards, so a cheat is not something the code makes easy to write. Each estimates its equity by simulation, compares it with the pot odds, and has its own appetite for a hand. They give their seats up as players arrive, and a table you open yourself has none unless you ask for them.

## Local development

```bash
npm install
npm run party   # table server (wrangler dev) on localhost:2003
npm run dev     # Next.js on localhost:3008
```

Copy `.env.example` to `.env.local`. Sign-in goes through planary-auth: the app keeps the token it hands back and verifies it via `auth.planary.ch/api/auth/me` (no Supabase keys needed). Only signed-in players can sit; others can watch.

## Deploy

- Tables: `npm run party:deploy` (Cloudflare)
- Web: push to `main`; Vercel builds it. Set `NEXT_PUBLIC_PARTYKIT_HOST` to the worker host (`planary-poker.<account>.workers.dev`).

Chips live in the Planary casino wallet (`planary-casino-api`); the table debits buy-ins and credits cash-outs through a service binding.

Part of [Planary](https://github.com/Fallka0?tab=repositories&q=planary).
