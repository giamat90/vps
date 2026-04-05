import { usePlayerStore } from "../../stores/player";

function ABToggle() {
  const abMode = usePlayerStore((s) => s.abMode);
  const activeTakeId = usePlayerStore((s) => s.activeTakeId);
  const setABMode = usePlayerStore((s) => s.setABMode);

  const disabled = !activeTakeId;

  return (
    <div className={`ab-toggle ${disabled ? "ab-toggle--disabled" : ""}`}>
      <button
        className={`ab-toggle__btn ${abMode === "original" ? "ab-toggle__btn--active" : ""}`}
        onClick={() => setABMode("original")}
        disabled={disabled}
      >
        Original
      </button>
      <button
        className={`ab-toggle__btn ${abMode === "take" ? "ab-toggle__btn--active" : ""}`}
        onClick={() => setABMode("take")}
        disabled={disabled}
      >
        Take
      </button>
    </div>
  );
}

export default ABToggle;
