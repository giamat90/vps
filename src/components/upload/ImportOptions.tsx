interface ImportOptionsProps {
  trackKind: "vocal" | "instrument";
  onTrackKindChange: (kind: "vocal" | "instrument") => void;
  highQuality: boolean;
  onHighQualityChange: (hq: boolean) => void;
  disabled?: boolean;
}

export default function ImportOptions({
  trackKind, onTrackKindChange,
  highQuality, onHighQualityChange,
  disabled,
}: ImportOptionsProps) {
  return (
    <div className="import-options">
      <div className="import-options__row">
        <span className="import-options__label">Import as</span>
        <div className="import-options__chips">
          <button
            type="button"
            className={`import-options__chip${trackKind === "vocal" ? " import-options__chip--on" : ""}`}
            onClick={() => onTrackKindChange("vocal")}
            disabled={disabled}
          >
            Song
          </button>
          <button
            type="button"
            className={`import-options__chip${trackKind === "instrument" ? " import-options__chip--on" : ""}`}
            onClick={() => onTrackKindChange("instrument")}
            disabled={disabled}
          >
            Instrument
          </button>
        </div>
      </div>
      <span className="import-options__hint">
        {trackKind === "instrument"
          ? "Single practice track — no vocal/instrumental separation"
          : "Separates into vocals & instrumental tracks"}
      </span>
      <label
        className={`import-options__hq${trackKind === "instrument" ? " import-options__hq--disabled" : ""}`}
        title={
          trackKind === "instrument"
            ? "Not applicable — instrument practice tracks skip stem separation"
            : undefined
        }
      >
        <input
          type="checkbox"
          checked={highQuality}
          disabled={disabled || trackKind === "instrument"}
          onChange={(e) => onHighQualityChange(e.target.checked)}
        />
        <span className="import-options__hq-label">High quality</span>
        <span className="import-options__hq-hint">
          {highQuality
            ? "htdemucs_ft — better isolation, ~2–3× slower"
            : "htdemucs — fast standard quality"}
        </span>
      </label>
    </div>
  );
}
