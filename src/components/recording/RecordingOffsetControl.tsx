import {
  MAX_OFFSET_MS,
  N_MEASURED,
  confidenceOf,
  useLatencyCalibration,
  type CalibrationMessages,
} from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";

const MESSAGES: CalibrationMessages = {
  inputUnavailable: "Microphone unavailable: ",
  noSignal: "Could not detect claps — clap clearly on each click and try again.",
  rejected:
    "Calibration failed — measured value out of range / too few claps detected. Try again in a quieter room.",
};

function RecordingOffsetControl() {
  const {
    phase, isActive, countdown, measuredCount, result, errorMsg, devices, micDeviceId, recordingOffsets,
    targetName, start, cancel, apply, dismiss, setOffsetFromInput,
  } = useLatencyCalibration({ useStore: usePlayerStore, messages: MESSAGES, followOutputDevice: true });

  return (
    <div className="rec-offset">
      <h3 className="rec-offset__title">Recording Latency Compensation</h3>

      {!isActive && (
        <>
          <p className="rec-offset__hint">
            Compensation applied per device before saving each take (0 = auto-detected ~20 ms).
            Use <strong>Calibrate</strong> to measure automatically.
          </p>
          <div className="rec-offset__list">
            {devices.map((d) => {
              const entry = recordingOffsets[d.deviceId];
              return (
                <div
                  key={d.deviceId}
                  className={`rec-offset__row${d.deviceId === micDeviceId ? " rec-offset__row--active" : ""}`}
                >
                  <span className="rec-offset__name">
                    {d.label || `Mic ${d.deviceId.slice(0, 8)}`}
                  </span>
                  {entry?.stale ? (
                    <span className="rec-offset__chip rec-offset__chip--stale" title="A device this calibration was measured with is no longer connected">
                      stale
                    </span>
                  ) : entry?.madMs !== undefined ? (
                    <span
                      className={`rec-offset__chip rec-offset__chip--${confidenceOf(entry.madMs)}`}
                      title={`Clap spread (MAD): ${entry.madMs} ms`}
                    >
                      {confidenceOf(entry.madMs)}
                    </span>
                  ) : null}
                  <input
                    type="number"
                    className="rec-offset__input"
                    value={entry?.offset ?? 0}
                    min={0}
                    max={MAX_OFFSET_MS}
                    step={1}
                    onChange={(e) => setOffsetFromInput(d.deviceId, e.target.value)}
                  />
                  <span className="rec-offset__unit">ms</span>
                  <button
                    className="rec-offset__row-calib-btn"
                    onClick={() => start(d.deviceId)}
                    title={`Calibrate latency for ${d.label || "this device"}`}
                  >
                    Cal
                  </button>
                </div>
              );
            })}
          </div>

          {phase === "idle" && (recordingOffsets[micDeviceId] === undefined || recordingOffsets[micDeviceId]?.stale) && (
            <div className="rec-offset__banner rec-offset__banner--warn">
              <span>
                {recordingOffsets[micDeviceId]?.stale
                  ? "Your audio setup changed — recalibrate?"
                  : "This microphone hasn't been calibrated — measure its latency?"}
              </span>
              <div className="rec-offset__banner-actions">
                <button className="rec-offset__banner-btn" onClick={() => start(micDeviceId)}>
                  Calibrate
                </button>
              </div>
            </div>
          )}

          {phase === "done" && result !== null && (
            <div className="rec-offset__banner rec-offset__banner--ok">
              <span>
                Measured: <strong>{result.medianMs} ms</strong>{" "}
                <span
                  className={`rec-offset__chip rec-offset__chip--${confidenceOf(result.madMs)}`}
                  title={`Clap spread (MAD): ${result.madMs} ms over ${result.detectedCount}/${N_MEASURED} claps`}
                >
                  {confidenceOf(result.madMs)} confidence
                </span>
              </span>
              {confidenceOf(result.madMs) === "low" && (
                <span className="rec-offset__banner-hint">
                  Measurements varied a lot — consider re-running in a quieter room with short, crisp claps.
                </span>
              )}
              <div className="rec-offset__banner-actions">
                <button className="rec-offset__banner-btn" onClick={apply}>
                  Apply to {targetName("device")}
                </button>
                <button
                  className="rec-offset__banner-btn rec-offset__banner-btn--ghost"
                  onClick={dismiss}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
          {phase === "error" && (
            <div className="rec-offset__banner rec-offset__banner--err">
              <span>{errorMsg}</span>
              <button
                className="rec-offset__banner-btn rec-offset__banner-btn--ghost"
                onClick={dismiss}
              >
                Close
              </button>
            </div>
          )}
        </>
      )}

      {isActive && (
        <div className="rec-offset__active">
          <p className="rec-offset__active-device">
            {targetName("Default microphone")}
          </p>
          {phase === "counting" && (
            <>
              <p className="rec-offset__active-label">Count-in — get ready to clap</p>
              <div className="rec-offset__active-count">{countdown}</div>
            </>
          )}
          {phase === "measuring" && (
            <>
              <p className="rec-offset__active-label">Clap in time with each click!</p>
              <div className="rec-offset__active-count">
                {measuredCount}
                <span className="rec-offset__active-total"> / {N_MEASURED}</span>
              </div>
            </>
          )}
          {phase === "analyzing" && (
            <p className="rec-offset__active-label">Analyzing claps…</p>
          )}
          <button className="rec-offset__cancel-btn" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export default RecordingOffsetControl;
