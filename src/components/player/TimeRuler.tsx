import { useTimeRuler } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";

export default function TimeRuler() {
  const { canvasRef, cursor, handlers } = useTimeRuler({
    useStore: usePlayerStore,
    accentRgb: "233,69,96",
    lockWhileRecording: true,
  });

  return (
    <div className="time-ruler">
      <canvas ref={canvasRef} className="time-ruler__canvas" {...handlers} style={{ cursor }} />
    </div>
  );
}
