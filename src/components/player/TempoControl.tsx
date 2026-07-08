import { useEffect, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { metronome } from "../../audio/metronome";

interface Props {
  detectedBpm?: number;
}

function TempoControl({ detectedBpm }: Props) {
  const playbackRate    = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const isPlaying       = usePlayerStore((s) => s.isPlaying);

  const [bpmInput, setBpmInput] = useState(() =>
    detectedBpm ? String(Math.round(detectedBpm * playbackRate)) : ""
  );
  const [rateInput, setRateInput] = useState(() => playbackRate.toFixed(2));
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);

  const effectiveBpm = (detectedBpm ?? 120) * playbackRate;

  useEffect(() => {
    if (metronomeEnabled && isPlaying) {
      metronome.start(effectiveBpm);
    } else {
      metronome.stop();
    }
  }, [metronomeEnabled, isPlaying]);

  useEffect(() => {
    if (metronomeEnabled && isPlaying) metronome.setBpm(effectiveBpm);
  }, [effectiveBpm]);

  useEffect(() => () => metronome.stop(), []);

  const commitBpm = (raw: string) => {
    if (!detectedBpm) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      setBpmInput(String(Math.round(detectedBpm * playbackRate)));
      return;
    }
    const rate = Math.max(0.25, Math.min(2.5, n / detectedBpm));
    const rounded = parseFloat(rate.toFixed(4));
    setPlaybackRate(rounded);
    setBpmInput(String(Math.round(detectedBpm * rounded)));
    setRateInput(rounded.toFixed(2));
  };

  const commitRate = (raw: string) => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) {
      setRateInput(playbackRate.toFixed(2));
      return;
    }
    const rate = Math.max(0.25, Math.min(2.5, n));
    const rounded = parseFloat(rate.toFixed(4));
    setPlaybackRate(rounded);
    setRateInput(rounded.toFixed(2));
    if (detectedBpm) setBpmInput(String(Math.round(detectedBpm * rounded)));
  };

  return (
    <div className="tempo-control">
      <div className="tempo-control__header">
        <div className="tempo-control__header-left">
          <span className="tempo-control__label">Speed</span>
          {detectedBpm && (
            <span className="tempo-control__row-prefix">{Math.round(detectedBpm)} BPM</span>
          )}
        </div>
        <button
          className={`metronome-btn${metronomeEnabled ? " metronome-btn--active" : ""}`}
          onClick={() => setMetronomeEnabled((v) => !v)}
          title={metronomeEnabled ? "Disable metronome" : "Enable metronome (clicks while playing)"}
        >
          🥁
        </button>
      </div>

      <div className="tempo-control__bpm-group">
        <div className="tempo-control__bpm-row">
          {detectedBpm && (
            <>
              <input
                type="number"
                min={Math.round(detectedBpm * 0.25)}
                max={Math.round(detectedBpm * 2.5)}
                value={bpmInput}
                className="tempo-control__bpm-input"
                onChange={(e) => setBpmInput(e.target.value)}
                onBlur={(e) => commitBpm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitBpm(bpmInput);
                }}
              />
              <span className="tempo-control__bpm-unit">BPM</span>
            </>
          )}
        </div>
        <div className="tempo-control__bpm-row">
          <input
            type="number"
            min={0.25}
            max={2.5}
            step={0.05}
            value={rateInput}
            className="tempo-control__bpm-input"
            onChange={(e) => setRateInput(e.target.value)}
            onBlur={(e) => commitRate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRate(rateInput);
            }}
          />
          <span className="tempo-control__bpm-unit">×</span>
        </div>
      </div>
    </div>
  );
}

export default TempoControl;
