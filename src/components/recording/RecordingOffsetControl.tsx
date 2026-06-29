import { useEffect } from "react";
import { usePlayerStore } from "../../stores/player";

function RecordingOffsetControl() {
  const audioDevices = usePlayerStore((s) => s.audioDevices);
  const selectedDeviceId = usePlayerStore((s) => s.selectedDeviceId);
  const recordingOffsets = usePlayerStore((s) => s.recordingOffsets);
  const setRecordingOffset = usePlayerStore((s) => s.setRecordingOffset);
  const fetchAudioDevices = usePlayerStore((s) => s.fetchAudioDevices);

  useEffect(() => {
    fetchAudioDevices();
  }, []);

  const devices = [
    { deviceId: "", label: "Default microphone" },
    ...audioDevices,
  ];

  return (
    <div className="rec-offset">
      <h3 className="rec-offset__title">Recording Latency Offset</h3>
      <p className="rec-offset__hint">
        If takes still sound late after auto-compensation, add extra offset per device.
        Record a sharp clap on a visible transient and adjust until it snaps to the beat.
      </p>
      <div className="rec-offset__list">
        {devices.map((d) => (
          <div
            key={d.deviceId}
            className={`rec-offset__row${d.deviceId === (selectedDeviceId ?? "") ? " rec-offset__row--active" : ""}`}
          >
            <span className="rec-offset__name">
              {d.label || `Mic ${d.deviceId.slice(0, 8)}`}
            </span>
            <input
              type="number"
              className="rec-offset__input"
              value={recordingOffsets[d.deviceId] ?? 0}
              min={-500}
              max={500}
              step={1}
              onChange={(e) =>
                setRecordingOffset(d.deviceId, parseInt(e.target.value) || 0)
              }
            />
            <span className="rec-offset__unit">ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default RecordingOffsetControl;
