"""
Analyze a user's vocal recording (take).
Lighter than the full processor — no Demucs needed since input is already vocals.
Extracts pitch, onsets, dynamics, and vibrato metrics.
"""

import sys
import numpy as np
import librosa

SAMPLE_RATE = 44100
CREPE_STEP_MS = 10
CREPE_MODEL = "small"
CONFIDENCE_THRESHOLD = 0.5


def _detect_vibrato(frequency: np.ndarray, confidence: np.ndarray, step_ms: int = CREPE_STEP_MS) -> dict:
    """
    Estimate vibrato rate, depth, and regularity from a pitch contour.

    Vibrato is a quasi-periodic modulation of pitch, typically 4–8 Hz with 20–200 cent depth.
    We detect it by finding periodic oscillations in the pitch contour.
    """
    valid = (confidence >= CONFIDENCE_THRESHOLD) & (frequency > 0)
    if valid.sum() < 100:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    # Convert to cents relative to local median (removes melodic contour)
    freqs = frequency.copy()
    freqs[~valid] = np.nan

    # Interpolate gaps for continuity
    nans = np.isnan(freqs)
    if nans.all():
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    x = np.arange(len(freqs))
    freqs[nans] = np.interp(x[nans], x[~nans], freqs[~nans])

    # Convert to cents (relative to mean pitch)
    mean_pitch = np.nanmean(freqs)
    cents = 1200 * np.log2(freqs / mean_pitch + 1e-9)

    # Remove slow melodic contour with high-pass (subtract smoothed version)
    from scipy.ndimage import uniform_filter1d
    window = int(500 / step_ms)  # 500ms smoothing window
    if window < 3:
        window = 3
    smoothed = uniform_filter1d(cents, size=window)
    detrended = cents - smoothed

    # Autocorrelation to find vibrato rate
    step_sec = step_ms / 1000.0
    fs = 1.0 / step_sec

    # Look for vibrato in 4–8 Hz range
    min_lag = int(fs / 8.0)  # 8 Hz
    max_lag = int(fs / 4.0)  # 4 Hz

    if max_lag <= min_lag or max_lag >= len(detrended) // 2:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    autocorr = np.correlate(detrended, detrended, mode="full")
    autocorr = autocorr[len(detrended) - 1:]  # Keep positive lags
    autocorr /= autocorr[0] + 1e-9  # Normalize

    search_region = autocorr[min_lag:max_lag + 1]
    if len(search_region) == 0:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    peak_idx = np.argmax(search_region)
    peak_lag = min_lag + peak_idx
    peak_val = search_region[peak_idx]

    # Vibrato rate from peak lag
    rate = fs / peak_lag if peak_lag > 0 else 0.0

    # Vibrato depth: RMS of detrended signal in cents
    depth = float(np.std(detrended) * 2)  # ~peak-to-peak in cents

    # Regularity: autocorrelation peak strength (0–1)
    regularity = max(0.0, min(1.0, float(peak_val)))

    # Only report vibrato if it's actually significant
    if depth < 10 or regularity < 0.15:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    return {
        "rate": round(rate, 2),
        "depth": round(depth, 1),
        "regularity": round(regularity, 3),
    }


def analyze_recording(recording_path: str, output_dir=None, on_progress=None) -> dict:
    """
    Analyze a vocal recording (user take).

    Args:
        recording_path: Path to the vocal recording file.
        output_dir: Optional output directory (unused for now, reserved for future).
        on_progress: Callback(value: float, stage: str) for progress updates.

    Returns:
        Dict with pitchData, onsets, dynamics, vibrato.
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    # --- Stage 1: CREPE pitch extraction (0.0 – 0.50) ---
    on_progress(0.0, "pitch-extraction")
    print("Running CREPE pitch extraction on recording...", file=sys.stderr)

    import torch
    import torchcrepe

    audio, sr = librosa.load(recording_path, sr=16000, mono=True)
    audio_tensor = torch.tensor(audio).unsqueeze(0)  # (1, samples)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    frequency, confidence = torchcrepe.predict(
        audio_tensor, sr,
        hop_length=int(sr * CREPE_STEP_MS / 1000),
        model="tiny",
        device=device,
        return_periodicity=True,
        batch_size=512,
    )
    frequency = frequency.squeeze(0).numpy()
    confidence = confidence.squeeze(0).numpy()
    on_progress(0.50, "pitch-extraction")

    times = np.arange(len(frequency)) * (CREPE_STEP_MS / 1000.0)
    pitch_data = []
    for i in range(len(frequency)):
        if confidence[i] >= CONFIDENCE_THRESHOLD and frequency[i] > 0:
            pitch_data.append({
                "time": round(float(times[i]), 4),
                "frequency": round(float(frequency[i]), 2),
                "confidence": round(float(confidence[i]), 3),
            })

    # --- Stage 2: Onset detection (0.50 – 0.70) ---
    on_progress(0.60, "onset-detection")
    print("Detecting onsets...", file=sys.stderr)

    audio_lr, sr_lr = librosa.load(recording_path, sr=SAMPLE_RATE, mono=True)
    onset_frames = librosa.onset.onset_detect(y=audio_lr, sr=sr_lr, units="frames")
    onsets = librosa.frames_to_time(onset_frames, sr=sr_lr).tolist()
    onsets = [round(t, 4) for t in onsets]
    on_progress(0.70, "onset-detection")

    # --- Stage 3: Dynamics / RMS (0.70 – 0.85) ---
    on_progress(0.80, "dynamics")
    print("Computing dynamics...", file=sys.stderr)

    rms = librosa.feature.rms(y=audio_lr)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr_lr)
    dynamics = []
    for i in range(len(rms)):
        dynamics.append({
            "time": round(float(rms_times[i]), 4),
            "rms": round(float(rms[i]), 6),
        })
    on_progress(0.85, "dynamics")

    # --- Stage 4: Vibrato detection (0.85 – 1.0) ---
    on_progress(0.90, "vibrato-detection")
    print("Analyzing vibrato...", file=sys.stderr)

    vibrato = _detect_vibrato(frequency, confidence, CREPE_STEP_MS)
    on_progress(1.0, "complete")

    return {
        "pitchData": pitch_data,
        "onsets": onsets,
        "dynamics": dynamics,
        "vibrato": vibrato,
    }
