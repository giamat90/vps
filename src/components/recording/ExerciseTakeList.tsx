import { useState } from "react";
import { useExerciseStore } from "../../stores/exercise";
import { usePlayerStore } from "../../stores/player";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface ExerciseTakeListProps {
  trackContainerRef: React.RefObject<HTMLDivElement | null>;
}

function ExerciseTakeList({ trackContainerRef }: ExerciseTakeListProps) {
  const exerciseTakes       = useExerciseStore((s) => s.exerciseTakes);
  const activeId            = useExerciseStore((s) => s.loadedTrackId);
  const loadIntoTrack        = useExerciseStore((s) => s.loadExerciseTakeIntoTrack);
  const clearLoadedTrack     = useExerciseStore((s) => s.clearLoadedTrack);
  const deleteTake          = useExerciseStore((s) => s.deleteExerciseTake);
  const isRecording         = usePlayerStore((s) => s.isRecording);
  const [loadError, setLoadError] = useState<string | null>(null);

  if (exerciseTakes.length === 0) {
    return <p className="exercise-take-list__empty">No recordings yet.</p>;
  }

  const handleClick = async (takeId: string) => {
    if (isRecording) return;
    setLoadError(null);
    if (takeId === activeId) {
      clearLoadedTrack();
      return;
    }
    const take = exerciseTakes.find((t) => t.id === takeId);
    const container = trackContainerRef.current;
    if (!take || !container) return;
    try {
      await loadIntoTrack(take, container);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ul className="exercise-take-list">
      {loadError && <li className="exercise-take-list__load-error">{loadError}</li>}
      {exerciseTakes.map((take) => {
        const isActive = take.id === activeId;
        const date = new Date(take.recordedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return (
          <li
            key={take.id}
            className={`exercise-take-list__item${isActive ? " exercise-take-list__item--active" : ""}${isRecording ? " exercise-take-list__item--disabled" : ""}`}
            onClick={() => void handleClick(take.id)}
            title={isRecording ? "Stop recording to load a take" : undefined}
          >
            <div className="exercise-take-list__meta">
              <span className="exercise-take-list__date">{date}</span>
              <span className="exercise-take-list__dur">{formatDuration(take.duration)}</span>
            </div>
            <button
              className="exercise-take-list__delete"
              onClick={(e) => { e.stopPropagation(); void deleteTake(take.id); }}
              title="Delete"
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default ExerciseTakeList;
