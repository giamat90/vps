import { useUpdaterStore } from "../../stores/updater";

export default function UpdateDialog() {
  const { status, update, progress, dismissed, installAndRestart, dismiss } = useUpdaterStore();

  if (dismissed || status === "idle" || status === "checking") return null;

  return (
    <div className="update-overlay">
      <div className="update-modal">
        {status === "available" && (
          <>
            <h2 className="update-modal__title">Update available</h2>
            {update && <p className="update-modal__version">v{update.version}</p>}
            {update?.body && <p className="update-modal__notes">{update.body}</p>}
            <div className="update-modal__actions">
              <button className="update-modal__install" onClick={() => installAndRestart()}>
                Install &amp; Restart
              </button>
              <button className="update-modal__later" onClick={dismiss}>
                Later
              </button>
            </div>
          </>
        )}

        {status === "downloading" && (
          <>
            <h2 className="update-modal__title">Downloading update…</h2>
            <div className="progress-bar">
              <div
                className="progress-bar__fill"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          </>
        )}

        {status === "ready" && <h2 className="update-modal__title">Restarting…</h2>}

        {status === "error" && (
          <>
            <h2 className="update-modal__title">Update failed</h2>
            <p className="update-modal__notes">
              Something went wrong while downloading or installing the update.
            </p>
            <div className="update-modal__actions">
              <button className="update-modal__install" onClick={() => installAndRestart()}>
                Try again
              </button>
              <button className="update-modal__later" onClick={dismiss}>
                Later
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
