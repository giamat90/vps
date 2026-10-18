import { useLoopToggle } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";

function LoopButton() {
  const loop = useLoopToggle(usePlayerStore);

  return (
    <button
      className={`loop-btn${loop.active ? " loop-btn--active" : ""}`}
      title={loop.title}
      disabled={loop.disabled}
      aria-label="Loop punch region"
      aria-pressed={loop.active}
      onClick={loop.toggle}
    >
      ⟳
    </button>
  );
}

export default LoopButton;
