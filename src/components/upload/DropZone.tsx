import { useLibraryStore } from "../../stores/library";
import { pickFile } from "../../lib/pickFile";
import { useDropZone } from "@giamat90/mps-core/hooks";

export { AUDIO_EXTENSIONS } from "@giamat90/mps-core/hooks";

interface DropZoneProps {
  highQuality?: boolean;
  trackKind?: "vocal" | "instrument";
}

function DropZone({ highQuality, trackKind }: DropZoneProps) {
  const uploadSong = useLibraryStore((s) => s.uploadSong);
  const processing = useLibraryStore((s) => s.processing);
  const isProcessing = processing !== null;
  const { pendingFile, fileName, pick, confirm, cancel } = useDropZone({
    isProcessing,
    pickFile,
    onUpload: (path) => uploadSong(path, highQuality, trackKind),
  });

  if (isProcessing) {
    return (
      <div className="dropzone dropzone--busy">
        <div className="dropzone__progress">
          <div className="dropzone__stage">{processing.stage}</div>
          <div className="progress-bar">
            <div
              className="progress-bar__fill"
              style={{ width: `${Math.round(processing.progress * 100)}%` }}
            />
          </div>
          <div className="dropzone__percent">
            {Math.round(processing.progress * 100)}%
          </div>
        </div>
      </div>
    );
  }

  if (pendingFile) {
    return (
      <div className="dropzone dropzone--pending">
        <div className="dropzone__pending">
          <div className="dropzone__pending-name" title={pendingFile}>{fileName}</div>
          <div className="dropzone__pending-actions">
            <button className="dropzone__btn-cancel" type="button" onClick={cancel}>
              Cancel
            </button>
            <button className="dropzone__btn-process" type="button" onClick={confirm}>
              Analyze
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button className="dropzone" onClick={pick} disabled={isProcessing}>
      <div className="dropzone__idle">
        <div className="dropzone__icon">+</div>
        <div className="dropzone__label">
          {trackKind === "instrument" ? "Upload a practice track" : "Upload a song"}
        </div>
        <div className="dropzone__hint">MP3, WAV, FLAC, OGG, M4A</div>
      </div>
    </button>
  );
}

export default DropZone;
