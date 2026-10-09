import { type Card, isRed, rankLabel, SUIT_NAMES, type Suit } from "../../shared/cards";

/*
  A card, screen-printed — the same card Grimoire deals.

  120 × 168 on cream paper, with a halftone that fades in toward the foot and
  the suit printed twice: once in a pale plate, once in ink, about six pixels
  off register. That misprint is the whole trick: it is what stops a flat SVG
  from reading as a flat SVG. Nothing here is glossy, bevelled or lit, because
  nothing anywhere in this casino is.

  ── Why everything is in cqw ──────────────────────────────────────────
  The drawing is designed at 120 × 168 and dealt at three sizes: 60 × 84 in
  another player's hand, 86 × 121 on the board, 94 × 131 in your own. Rather
  than three drawings, the card's holder is the container and every number
  below is that one drawing divided by 120 — so `10px` of corner becomes
  8.33cqw and stays 10px-worth at every size.

  The container has to be the holder and not the card: an element cannot
  query itself, so a radius set in cqw on the card would silently resolve
  against the table panel instead and round the corners off completely.
*/

const SUIT_PATHS: Record<Suit, string> = {
  h: "M50 90C22 68 6 50 6 31 6 16 17 6 31 6c9 0 16 5 19 12 3-7 10-12 19-12 14 0 25 10 25 25 0 19-16 37-44 59z",
  d: "M50 3 88 50 50 97 12 50z",
  s: "M50 4C36 24 8 39 8 60c0 13 10 22 22 22 7 0 13-3 16-8l-5 22h18l-5-22c3 5 9 8 16 8 12 0 22-9 22-22C92 39 64 24 50 4z",
  c: "M50 8a19 19 0 0 1 17 28 19 19 0 1 1-8 36l5 24H36l5-24a19 19 0 1 1-8-36A19 19 0 0 1 50 8z",
};

const RANK_NAMES: Record<string, string> = { A: "Ace", J: "Jack", Q: "Queen", K: "King" };

export function SuitMark({ suit, className }: { suit: Suit; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <path d={SUIT_PATHS[suit]} fill="currentColor" />
    </svg>
  );
}

/** The chip that sits on the back of every card, and in the top bar. */
export function ChipMark({ letter, fill = "#f6eee4", ink = "#5e1a34" }: { letter?: string; fill?: string; ink?: string }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="19" fill={fill} />
      <circle cx="20" cy="20" r="15.5" fill="none" stroke={ink} strokeWidth="4" strokeDasharray="6.1 6.1" />
      <circle cx="20" cy="20" r="10.5" fill={ink} />
      {letter ? (
        <text x="20" y="26.2" textAnchor="middle" fontSize="17" fontWeight="900" fontFamily="var(--font-poster), sans-serif" fill={fill}>
          {letter}
        </text>
      ) : (
        <circle cx="20" cy="20" r="6.5" fill={fill} />
      )}
    </svg>
  );
}

export function CardFace({ card }: { card: Card }) {
  const red = isRed(card);
  const ink = red ? "#b3122e" : "#22060e";
  const plate = red ? "#ff5a78" : "rgba(34,6,14,0.16)";
  const rank = rankLabel(card.r);

  return (
    <span className="card card-play" role="img" aria-label={`${RANK_NAMES[rank] ?? rank} of ${SUIT_NAMES[card.s]}`}>
      <span className="card-halftone" aria-hidden="true" />
      {/* The pale plate goes down first, six pixels out of line. */}
      <svg className="card-pip card-pip-plate" viewBox="0 0 100 100" aria-hidden="true">
        <path d={SUIT_PATHS[card.s]} fill={plate} />
      </svg>
      <svg className="card-pip card-pip-ink" viewBox="0 0 100 100" aria-hidden="true">
        <path d={SUIT_PATHS[card.s]} fill={ink} />
      </svg>
      <span className="card-corner" style={{ color: ink }} aria-hidden="true">
        <span className="card-rank">{rank}</span>
        <SuitMark suit={card.s} />
      </span>
    </span>
  );
}

/** The back of a card: the house chip on the table's own field. */
export function CardBack() {
  return (
    <span className="card card-back" role="img" aria-label="Face-down card">
      <span className="card-back-rule" aria-hidden="true" />
      <ChipMark letter="H" fill="#f6eee4" ink="#5e1a34" />
    </span>
  );
}

/** A card, or its back when there is nothing to show. */
export function PlanaryCard({ card }: { card: Card | null }) {
  return card ? <CardFace card={card} /> : <CardBack />;
}
