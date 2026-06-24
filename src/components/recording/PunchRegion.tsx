import { usePlayerStore } from "../../stores/player";

function toMMSS(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function parseMMSS(value: string): number | null {
  const match = value.match(/^(\d+):([0-5]\d)$/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function PunchRegion() {
  const punchIn      = usePlayerStore((s) => s.punchIn);
  const punchOut     = usePlayerStore((s) => s.punchOut);
  const currentTime  = usePlayerStore((s) => s.currentTime);
  const duration     = usePlayerStore((s) => s.duration);
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const setPunchIn   = usePlayerStore((s) => s.setPunchIn);
  const setPunchOut  = usePlayerStore((s) => s.setPunchOut);
  const clearPunch   = usePlayerStore((s) => s.clearPunch);

  if (isRecording) return null;

  const handleInChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseMMSS(e.target.value);
    if (t !== null && t >= 0 && t < (punchOut ?? duration)) setPunchIn(t);
  };

  const handleOutChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseMMSS(e.target.value);
    if (t !== null && t > (punchIn ?? 0) && t <= duration) setPunchOut(t);
  };

  const isActive = punchIn !== null || punchOut !== null;

  return (
    <div className={`punch-region ${isActive ? "punch-region--active" : ""}`}>
      <span className="punch-region__label">Punch</span>

      <label className="punch-region__field">
        <span>In</span>
        <input
          className="punch-region__input"
          type="text"
          placeholder="--:--"
          value={punchIn !== null ? toMMSS(punchIn) : ""}
          onChange={handleInChange}
        />
        <button
          className="punch-region__set-btn"
          title="Set punch-in to current position"
          onClick={() => setPunchIn(Math.floor(currentTime))}
        >
          ←
        </button>
      </label>

      <label className="punch-region__field">
        <span>Out</span>
        <input
          className="punch-region__input"
          type="text"
          placeholder="--:--"
          value={punchOut !== null ? toMMSS(punchOut) : ""}
          onChange={handleOutChange}
        />
        <button
          className="punch-region__set-btn"
          title="Set punch-out to current position"
          onClick={() => setPunchOut(Math.floor(currentTime))}
        >
          ←
        </button>
      </label>

      {isActive && (
        <button
          className="punch-region__clear-btn"
          title="Clear punch region"
          onClick={clearPunch}
        >
          ✕
        </button>
      )}
    </div>
  );
}

export default PunchRegion;
