import { useState } from "react";
import { usePlayerStore } from "../../stores/player";

function KeyTranspose() {
  const transpose = usePlayerStore((s) => s.transpose);
  const isTransposing = usePlayerStore((s) => s.isTransposing);
  const song = usePlayerStore((s) => s.song);
  const setTranspose = usePlayerStore((s) => s.setTranspose);
  const [pendingTranspose, setPendingTranspose] = useState<number | null>(null);

  const disabled = isTransposing || !song;
  const displayValue = isTransposing && pendingTranspose !== null ? pendingTranspose : transpose;

  const applyTranspose = (next: number) => {
    if (next === transpose) return;
    setPendingTranspose(next);
    setTranspose(next)
      .catch((e: unknown) => console.error("[KeyTranspose] setTranspose failed:", e))
      .finally(() => setPendingTranspose(null));
  };

  const shift = (delta: number) => applyTranspose(Math.max(-6, Math.min(6, transpose + delta)));

  return (
    <div className="key-transpose">
      <span className="key-transpose__label">Transpose</span>
      <div className="key-transpose__controls">
        <button
          className="key-transpose__btn"
          onClick={() => shift(-1)}
          disabled={disabled}
        >
          -
        </button>
        <span className={`key-transpose__value${isTransposing ? " key-transpose__value--pending" : ""}`}>
          {displayValue > 0 ? `+${displayValue}` : displayValue} st
        </span>
        <button
          className="key-transpose__btn"
          onClick={() => shift(1)}
          disabled={disabled}
        >
          +
        </button>
        {transpose !== 0 && !isTransposing && (
          <button
            className="key-transpose__btn key-transpose__reset"
            onClick={() => applyTranspose(0)}
            disabled={disabled}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

export default KeyTranspose;
