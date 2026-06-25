import { convertFileSrc } from "@tauri-apps/api/core";
import { useExerciseStore } from "../../stores/exercise";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ExerciseTakeList() {
  const exerciseTakes       = useExerciseStore((s) => s.exerciseTakes);
  const activeId            = useExerciseStore((s) => s.activeExerciseTakeId);
  const setActive           = useExerciseStore((s) => s.setActiveExerciseTake);
  const deleteTake          = useExerciseStore((s) => s.deleteExerciseTake);

  if (exerciseTakes.length === 0) {
    return <p className="exercise-take-list__empty">No recordings yet.</p>;
  }

  return (
    <ul className="exercise-take-list">
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
            className={`exercise-take-list__item${isActive ? " exercise-take-list__item--active" : ""}`}
            onClick={() => setActive(isActive ? null : take.id)}
          >
            <div className="exercise-take-list__meta">
              <span className="exercise-take-list__date">{date}</span>
              <span className="exercise-take-list__dur">{formatDuration(take.duration)}</span>
            </div>
            {isActive && (
              <audio
                className="exercise-take-list__player"
                controls
                src={convertFileSrc(take.filepath.replace(/\\/g, "/"))}
              />
            )}
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
