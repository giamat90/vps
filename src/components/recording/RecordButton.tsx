import { usePlayerStore } from "../../stores/player";

function RecordButton() {
  const isRecording = usePlayerStore((s) => s.isRecording);
  const startRecording = usePlayerStore((s) => s.startRecording);
  const stopRecording = usePlayerStore((s) => s.stopRecording);

  const handleClick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <button
      className={`record-btn ${isRecording ? "record-btn--active" : ""}`}
      onClick={handleClick}
      title={isRecording ? "Stop recording" : "Record"}
    >
      <span className="record-btn__dot" />
    </button>
  );
}

export default RecordButton;
