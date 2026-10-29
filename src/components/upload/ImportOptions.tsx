import type { ReactNode } from "react";

type TrackKind = "vocal" | "instrument";

interface ImportOptionsProps {
  trackKind: TrackKind;
  onTrackKindChange: (kind: TrackKind) => void;
  highQuality: boolean;
  onHighQualityChange: (hq: boolean) => void;
  disabled?: boolean;
}

const KINDS: { kind: TrackKind; title: string; hint: string; icon: ReactNode }[] = [
  {
    kind: "vocal",
    title: "Song",
    hint: "Splits the voice from the backing track",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
      </svg>
    ),
  },
  {
    kind: "instrument",
    title: "Instrument",
    hint: "One practice track, kept whole",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M8 5v14M12 5v14M16 5v14" />
        <path d="M7 5v8M11 5v8M15 5v8" className="import-options__keys" />
      </svg>
    ),
  },
];

export default function ImportOptions({
  trackKind, onTrackKindChange,
  highQuality, onHighQualityChange,
  disabled,
}: ImportOptionsProps) {
  const instrument = trackKind === "instrument";
  return (
    <div className="import-options">
      <span className="import-options__label" id="import-options-label">Import as</span>
      <div className="import-options__kinds" role="radiogroup" aria-labelledby="import-options-label">
        {KINDS.map(({ kind, title, hint, icon }) => {
          const on = trackKind === kind;
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={on}
              className={`import-options__kind${on ? " import-options__kind--on" : ""}`}
              onClick={() => onTrackKindChange(kind)}
              disabled={disabled}
            >
              <span className="import-options__icon">{icon}</span>
              <span className="import-options__text">
                <span className="import-options__title">{title}</span>
                <span className="import-options__hint">{hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      <label
        className={`import-options__hq${instrument ? " import-options__hq--disabled" : ""}`}
        title={instrument ? "Not applicable — instrument practice tracks skip stem separation" : undefined}
      >
        <input
          type="checkbox"
          role="switch"
          checked={highQuality && !instrument}
          disabled={disabled || instrument}
          onChange={(e) => onHighQualityChange(e.target.checked)}
        />
        <span className="import-options__hq-text">
          <span className="import-options__hq-label">High quality</span>
          <span className="import-options__hint">
            {instrument
              ? "Not needed: nothing is separated"
              : highQuality
                ? "htdemucs_ft: cleaner separation, about 2–3× slower"
                : "htdemucs: fast, standard quality"}
          </span>
        </span>
      </label>
    </div>
  );
}
