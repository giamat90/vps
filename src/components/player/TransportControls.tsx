import { usePlayerStore } from "../../stores/player";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function TransportControls() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const stop = usePlayerStore((s) => s.stop);
  const vocalsVolume = usePlayerStore((s) => s.vocalsVolume);
  const instrumentalVolume = usePlayerStore((s) => s.instrumentalVolume);
  const setVocalsVolume = usePlayerStore((s) => s.setVocalsVolume);
  const setInstrumentalVolume = usePlayerStore((s) => s.setInstrumentalVolume);

  return (
    <div className="transport">
      <div className="transport__playback">
        <button className="transport__btn" onClick={stop} title="Stop">
          &#9632;
        </button>
        <button
          className="transport__btn transport__btn--play"
          onClick={togglePlay}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? "\u275A\u275A" : "\u25B6"}
        </button>
        <span className="transport__time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>

      <div className="transport__volumes">
        <label className="transport__vol">
          <span>Vocals</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={vocalsVolume}
            onChange={(e) => setVocalsVolume(Number(e.target.value))}
          />
        </label>
        <label className="transport__vol">
          <span>Instrumental</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={instrumentalVolume}
            onChange={(e) => setInstrumentalVolume(Number(e.target.value))}
          />
        </label>
      </div>
    </div>
  );
}

export default TransportControls;
