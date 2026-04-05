import { useState } from "react";

function KeyTranspose() {
  const [semitones, setSemitones] = useState(0);

  // Transpose via Web Audio detune is deferred — for now this is a UI placeholder
  // that will be wired in when pitch-shifting DSP is added

  return (
    <div className="key-transpose">
      <span className="key-transpose__label">Transpose</span>
      <div className="key-transpose__controls">
        <button
          className="key-transpose__btn"
          onClick={() => setSemitones((s) => Math.max(-6, s - 1))}
        >
          -
        </button>
        <span className="key-transpose__value">
          {semitones > 0 ? `+${semitones}` : semitones} st
        </span>
        <button
          className="key-transpose__btn"
          onClick={() => setSemitones((s) => Math.min(6, s + 1))}
        >
          +
        </button>
        {semitones !== 0 && (
          <button
            className="key-transpose__btn key-transpose__reset"
            onClick={() => setSemitones(0)}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

export default KeyTranspose;
