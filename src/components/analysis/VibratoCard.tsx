import { useState } from "react";
import { useAnalysisStore } from "../../stores/analysis";

export default function VibratoCard() {
  const vibrato    = useAnalysisStore((s) => s.takeVibrato);
  const [open, setOpen] = useState(false);

  if (!vibrato) return null;

  const rateOk       = vibrato.rate >= 4 && vibrato.rate <= 7;
  const depthOk      = vibrato.depth >= 20 && vibrato.depth <= 100;
  const regularityOk = vibrato.regularity >= 0.6;

  return (
    <div className="vibrato-card">
      <div className="vibrato-card__header">
        <span className="vibrato-card__title">Vibrato</span>
        <button
          className={`vibrato-card__info-btn${open ? " vibrato-card__info-btn--active" : ""}`}
          onClick={() => setOpen((v) => !v)}
          aria-label="How is vibrato measured?"
        >
          ⓘ
        </button>
      </div>

      <div className="vibrato-card__stats">
        <div className="vibrato-card__stat">
          <span className={`vibrato-card__val ${rateOk ? "vibrato-card__val--ok" : "vibrato-card__val--warn"}`}>
            {vibrato.rate.toFixed(1)}
          </span>
          <span className="vibrato-card__unit">Hz</span>
          <span className="vibrato-card__label">Rate</span>
        </div>
        <div className="vibrato-card__stat">
          <span className={`vibrato-card__val ${depthOk ? "vibrato-card__val--ok" : "vibrato-card__val--warn"}`}>
            {Math.round(vibrato.depth)}
          </span>
          <span className="vibrato-card__unit">ct</span>
          <span className="vibrato-card__label">Depth</span>
        </div>
        <div className="vibrato-card__stat">
          <span className={`vibrato-card__val ${regularityOk ? "vibrato-card__val--ok" : "vibrato-card__val--warn"}`}>
            {Math.round(vibrato.regularity * 100)}
          </span>
          <span className="vibrato-card__unit">%</span>
          <span className="vibrato-card__label">Even</span>
        </div>
      </div>

      {open && (
        <div className="vibrato-card__info-panel">
          <div className="vibrato-card__info-section">
            <span className="vibrato-card__info-term">Rate (Hz)</span>
            <span className="vibrato-card__info-desc">
              How fast the pitch oscillates. Classical vibrato typically sits at 5–6 Hz.
              Below 4 Hz sounds like a slow wobble; above 7 Hz sounds like a nervous flutter.
              Ideal: 4–7 Hz.
            </span>
          </div>
          <div className="vibrato-card__info-section">
            <span className="vibrato-card__info-term">Depth (ct)</span>
            <span className="vibrato-card__info-desc">
              How wide the pitch swings, in cents (100 ct = 1 semitone).
              Shallow vibrato (&lt;20 ct) may be inaudible; too wide (&gt;100 ct) can sound
              uncontrolled. Ideal: 20–100 ct.
            </span>
          </div>
          <div className="vibrato-card__info-section">
            <span className="vibrato-card__info-term">Evenness (%)</span>
            <span className="vibrato-card__info-desc">
              How consistent the oscillation is cycle to cycle. 60 %+ indicates controlled
              vibrato; below that suggests irregular wobble or a straight tone with occasional
              drift.
            </span>
          </div>
          <p className="vibrato-card__info-note">
            If all values show 0, no vibrato was detected — either the pitch swings were
            narrower than 10 ct or the pattern was too irregular to measure.
          </p>
        </div>
      )}
    </div>
  );
}
