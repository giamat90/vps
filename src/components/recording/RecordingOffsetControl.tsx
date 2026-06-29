import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../../stores/player";

const N_COUNTIN = 4;
const N_MEASURED = 8;
const INTERVAL_S = 1.0;
const FIRST_CLICK_S = 0.5; // gap before first click once recording starts

type CalibPhase = "idle" | "counting" | "measuring" | "analyzing" | "done" | "error";

function scheduleClick(ctx: AudioContext, atTime: number, isCountIn: boolean): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = isCountIn ? 880 : 1320;
  gain.gain.setValueAtTime(0, atTime);
  gain.gain.linearRampToValueAtTime(isCountIn ? 0.2 : 0.4, atTime + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, atTime + 0.08);
  osc.start(atTime);
  osc.stop(atTime + 0.09);
}

// Returns measured round-trip latency in ms, or null if detection failed.
function detectLatencyMs(buffer: AudioBuffer): number | null {
  const samples = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  // 1 ms hop, 5 ms RMS frame
  const hop = Math.round(sr / 1000);
  const frame = hop * 5;
  const numFrames = Math.ceil(samples.length / hop);

  const env = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const s = i * hop;
    const e = Math.min(s + frame, samples.length);
    let sum = 0;
    for (let j = s; j < e; j++) sum += samples[j] * samples[j];
    env[i] = Math.sqrt(sum / (e - s));
  }

  let maxVal = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > maxVal) maxVal = env[i];
  if (maxVal < 0.005) return null;
  const threshold = maxVal * 0.15;

  // Peak detection — minimum 300 ms between peaks (1 frame = 1 ms)
  const peaks: number[] = [];
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] > env[i - 1] && env[i] > env[i + 1] && env[i] > threshold) {
      if (peaks.length === 0 || i - peaks[peaks.length - 1] > 300) {
        peaks.push(i);
      } else if (env[i] > env[peaks[peaks.length - 1]]) {
        peaks[peaks.length - 1] = i;
      }
    }
  }

  // Expected click positions in the recording (ms): first click at FIRST_CLICK_S,
  // then after N_COUNTIN count-in beats, N_MEASURED beats are the measurement targets.
  const offsets: number[] = [];
  for (let i = 0; i < N_MEASURED; i++) {
    const expectedMs = Math.round((FIRST_CLICK_S + (N_COUNTIN + i) * INTERVAL_S) * 1000);
    // Search window: -100 ms to +500 ms around expected position
    const candidates = peaks.filter(p => p >= expectedMs - 100 && p <= expectedMs + 500);
    if (candidates.length === 0) continue;
    const closest = candidates.reduce((a, b) =>
      Math.abs(a - expectedMs) < Math.abs(b - expectedMs) ? a : b,
    );
    offsets.push(closest - expectedMs);
  }

  if (offsets.length < 3) return null;
  offsets.sort((a, b) => a - b);
  return offsets[Math.floor(offsets.length / 2)];
}

function RecordingOffsetControl() {
  const audioDevices = usePlayerStore((s) => s.audioDevices);
  const selectedDeviceId = usePlayerStore((s) => s.selectedDeviceId);
  const selectedOutputDeviceId = usePlayerStore((s) => s.selectedOutputDeviceId);
  const recordingOffsets = usePlayerStore((s) => s.recordingOffsets);
  const setRecordingOffset = usePlayerStore((s) => s.setRecordingOffset);
  const fetchAudioDevices = usePlayerStore((s) => s.fetchAudioDevices);

  const [phase, setPhase] = useState<CalibPhase>("idle");
  const [countdown, setCountdown] = useState(0);
  const [measuredCount, setMeasuredCount] = useState(0);
  const [result, setResult] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    fetchAudioDevices();
    return () => { cancelledRef.current = true; };
  }, []);

  const micDeviceId = selectedDeviceId ?? "";

  const startCalibration = async () => {
    cancelledRef.current = false;
    setPhase("counting");
    setCountdown(N_COUNTIN);
    setMeasuredCount(0);
    setResult(null);
    setErrorMsg("");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
          echoCancellation: { exact: false },
          noiseSuppression: { exact: false },
          autoGainControl: { exact: false },
        },
        video: false,
      });
    } catch (e) {
      console.error("[calibration] getUserMedia failed:", e);
      setErrorMsg("Microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
      setPhase("error");
      return;
    }

    const mimeType =
      ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(
        (t) => MediaRecorder.isTypeSupported(t),
      ) ?? "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onerror = (e) => console.error("[calibration] MediaRecorder error:", e);

    // Use the same output device the song plays through so the singer hears clicks
    // from the same headphones they use during practice.
    const ctxOpts = selectedOutputDeviceId
      ? ({ sinkId: selectedOutputDeviceId } as AudioContextOptions)
      : undefined;
    const ctx = new AudioContext(ctxOpts);
    ctxRef.current = ctx;

    recorder.start(100);
    const schedBase = ctx.currentTime;
    const firstClickCtx = schedBase + FIRST_CLICK_S;

    for (let i = 0; i < N_COUNTIN + N_MEASURED; i++) {
      const clickCtx = firstClickCtx + i * INTERVAL_S;
      scheduleClick(ctx, clickCtx, i < N_COUNTIN);
      const uiDelayMs = (clickCtx - schedBase) * 1000;
      const ci = i;
      setTimeout(() => {
        if (cancelledRef.current) return;
        if (ci < N_COUNTIN) {
          setCountdown(N_COUNTIN - ci);
          setPhase("counting");
        } else {
          setMeasuredCount(ci - N_COUNTIN + 1);
          setPhase("measuring");
        }
      }, uiDelayMs);
    }

    // Stop 1.5 s after the last click to capture the last clap
    const totalDurationMs =
      (FIRST_CLICK_S + (N_COUNTIN + N_MEASURED - 1) * INTERVAL_S + 1.5) * 1000;

    setTimeout(async () => {
      if (cancelledRef.current) return;
      setPhase("analyzing");

      const blob = await new Promise<Blob>((resolve) => {
        const mtype = recorder.mimeType;
        recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: mtype }));
        if (recorder.state === "recording") recorder.stop();
        else resolve(new Blob(chunksRef.current, { type: mtype }));
      });

      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch((e: unknown) => console.warn("[calibration] ctx close:", e));
      ctxRef.current = null;

      if (cancelledRef.current) return;

      try {
        const arrayBuf = await blob.arrayBuffer();
        const decCtx = new AudioContext();
        const audioBuf = await decCtx.decodeAudioData(arrayBuf);
        decCtx.close().catch((e: unknown) => console.warn("[calibration] decCtx close:", e));

        if (cancelledRef.current) return;

        const measured = detectLatencyMs(audioBuf);
        if (measured === null || measured < 0) {
          setErrorMsg("Could not detect claps — clap clearly on each click and try again.");
          setPhase("error");
        } else {
          setResult(measured);
          setPhase("done");
        }
      } catch (e) {
        console.error("[calibration] analysis error:", e);
        if (!cancelledRef.current) {
          setErrorMsg("Analysis failed: " + (e instanceof Error ? e.message : String(e)));
          setPhase("error");
        }
      }
    }, totalDurationMs);
  };

  const cancel = () => {
    cancelledRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    ctxRef.current?.close().catch((e: unknown) =>
      console.warn("[calibration] ctx close on cancel:", e),
    );
    ctxRef.current = null;
    recorderRef.current = null;
    setPhase("idle");
  };

  const applyResult = () => {
    if (result !== null) setRecordingOffset(micDeviceId, result);
    setPhase("idle");
  };

  const devices = [
    { deviceId: "", label: "Default microphone" },
    ...audioDevices,
  ];

  const isActive = phase !== "idle" && phase !== "done" && phase !== "error";

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
            {devices.map((d) => (
              <div
                key={d.deviceId}
                className={`rec-offset__row${d.deviceId === micDeviceId ? " rec-offset__row--active" : ""}`}
              >
                <span className="rec-offset__name">
                  {d.label || `Mic ${d.deviceId.slice(0, 8)}`}
                </span>
                <input
                  type="number"
                  className="rec-offset__input"
                  value={recordingOffsets[d.deviceId] ?? 0}
                  min={0}
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

          {phase === "done" && result !== null && (
            <div className="rec-offset__banner rec-offset__banner--ok">
              <span>Measured: <strong>{result} ms</strong></span>
              <div className="rec-offset__banner-actions">
                <button className="rec-offset__banner-btn" onClick={applyResult}>
                  Apply to selected mic
                </button>
                <button
                  className="rec-offset__banner-btn rec-offset__banner-btn--ghost"
                  onClick={() => setPhase("idle")}
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
                onClick={() => setPhase("idle")}
              >
                Close
              </button>
            </div>
          )}

          <button className="rec-offset__calib-btn" onClick={startCalibration}>
            Calibrate
          </button>
        </>
      )}

      {isActive && (
        <div className="rec-offset__active">
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
