import { type Card, isRed, rankLabel, SUIT_NAMES, type Suit } from "../../shared/cards";

/**
 * A Planary playing card, in the Shell look: cream stock, one ink, and the
 * suit printed large and off-centre so a fanned hand still reads.
 *
 * The card sizes itself to its container rather than taking a width, because
 * the same card appears at three sizes on the table — 60×84 in a bot's hand,
 * 86×121 on the board, 94×131 in your own — and the handoff scales one
 * drawing rather than drawing three. Everything inside is therefore a
 * percentage of the card's own width (`cqw`), which is what the stylesheet's
 * card rules are written in.
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
  const ink = isRed(card) ? "#b3122e" : "#22060e";
  return (
    <span className="card" style={{ color: ink }} role="img" aria-label={`${RANK_NAMES[rankLabel(card.r)] ?? rankLabel(card.r)} of ${SUIT_NAMES[card.s]}`}>
      <SuitMark suit={card.s} className="card-pip" />
      <span className="card-rank" aria-hidden="true">
        <span>{rankLabel(card.r)}</span>
        <SuitMark suit={card.s} />
      </span>
    </span>
  );
}

export function CardBack() {
  return (
    <span className="card-back" role="img" aria-label="Face-down card">
      <span className="card-back-dots" aria-hidden="true" />
      <span className="card-back-frame" aria-hidden="true" />
      <span className="card-back-mark" aria-hidden="true">
        <ChipMark letter="H" />
      </span>
    </span>
  );
}

/** A card, or its back when there is nothing to show. */
export function PlanaryCard({ card }: { card: Card | null }) {
  return card ? <CardFace card={card} /> : <CardBack />;
}
