import { useSettingsStore } from "../../stores/settings";
import type { PitchAlgorithm } from "../../lib/types";

const DESCRIPTIONS: Record<PitchAlgorithm, string> = {
  srh: "Default — spectral, robust on strong chest voices.",
  pyin: "Classic autocorrelation-based tracker.",
  hps: "Harmonic Product Spectrum — simple, can jitter on weak harmonics.",
  crepe: "Deep-learning tracker — smoother on sustained notes, slower to process.",
};

function PitchAlgorithmControl() {
  const pitchAlgorithm = useSettingsStore((s) => s.pitchAlgorithm);
  const setPitchAlgorithm = useSettingsStore((s) => s.setPitchAlgorithm);

  return (
    <div className="pitch-algorithm-control">
      <label className="pitch-algorithm-control__label" htmlFor="pitch-algorithm-select">
        Pitch detection algorithm
      </label>
      <select
        id="pitch-algorithm-select"
        className="pitch-algorithm-control__select"
        value={pitchAlgorithm}
        onChange={(e) => setPitchAlgorithm(e.target.value as PitchAlgorithm)}
      >
        <option value="srh">SRH</option>
        <option value="pyin">pYIN</option>
        <option value="hps">HPS</option>
        <option value="crepe">CREPE</option>
      </select>
      <p className="pitch-algorithm-control__desc">{DESCRIPTIONS[pitchAlgorithm]}</p>
    </div>
  );
}

export default PitchAlgorithmControl;
