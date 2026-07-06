"""
Analyze a user's vocal recording (take).
Pitch algorithm is user-selectable (SRH default — spectral, avoids locking
onto the second formant); see processor.get_pitch_fn.
"""

import os
import sys
import traceback
import numpy as np
import librosa
import soundfile as sf
from processor import get_pitch_fn, compute_short_term_spectrum

SAMPLE_RATE = 44100
CONFIDENCE_THRESHOLD = 0.5
SRH_SR = 22050
SRH_HOP = 512
STEP_MS = SRH_HOP / SRH_SR * 1000   # ≈ 23.2 ms per frame — fallback when a pitch result has <2 frames

# Raw mic takes have far more dynamic range than a mastered/limited commercial
# mix, so matching peak level alone still leaves takes sounding quiet next to
# vocals.wav/instrumental.wav. Match RMS (average loudness) to the reference
# track instead, capped so we never push peaks past PEAK_CEILING_DBFS.
TARGET_RMS_DBFS_FALLBACK = -18.0  # used when no reference track is available (exercise mode)
PEAK_CEILING_DBFS = -1.0


def _rms_dbfs(samples: np.ndarray) -> float:
    rms = np.sqrt(np.mean(samples.astype(np.float64) ** 2))
    return 20 * np.log10(rms) if rms > 0 else -120.0


def _detect_vibrato(frequency: np.ndarray, confidence: np.ndarray, step_ms: float) -> dict:
    """
    Estimate vibrato rate, depth, and regularity from a pitch contour.
    Vibrato is a quasi-periodic modulation of pitch, typically 4–8 Hz with 20–200 cent depth.
    """
    valid = (confidence >= CONFIDENCE_THRESHOLD) & (frequency > 0)
    if valid.sum() < 100:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    freqs = frequency.copy()
    freqs[~valid] = np.nan

    nans = np.isnan(freqs)
    if nans.all():
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    x = np.arange(len(freqs))
    freqs[nans] = np.interp(x[nans], x[~nans], freqs[~nans])

    mean_pitch = np.nanmean(freqs)
    cents = 1200 * np.log2(freqs / mean_pitch + 1e-9)

    from scipy.ndimage import uniform_filter1d
    window = max(3, int(500 / step_ms))
    smoothed = uniform_filter1d(cents, size=window)
    detrended = cents - smoothed

    step_sec = step_ms / 1000.0
    fs = 1.0 / step_sec
    min_lag = int(fs / 8.0)
    max_lag = int(fs / 4.0)

    if max_lag <= min_lag or max_lag >= len(detrended) // 2:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    autocorr = np.correlate(detrended, detrended, mode="full")
    autocorr = autocorr[len(detrended) - 1:]
    autocorr /= autocorr[0] + 1e-9

    search_region = autocorr[min_lag:max_lag + 1]
    if len(search_region) == 0:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    peak_idx = np.argmax(search_region)
    peak_lag = min_lag + peak_idx
    peak_val = search_region[peak_idx]

    rate = fs / peak_lag if peak_lag > 0 else 0.0
    depth = float(np.std(detrended) * 2)
    regularity = max(0.0, min(1.0, float(peak_val)))

    if depth < 10 or regularity < 0.15:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    return {
        "rate": round(rate, 2),
        "depth": round(depth, 1),
        "regularity": round(regularity, 3),
    }


def convert_take_to_wav(recording_path: str, output_path: str) -> dict:
    """
    Decode a take (typically .webm/opus) to PCM and write it out as WAV
    for export. Keeps the file's native sample rate and channel count,
    and exports the full recording (no latency-offset trimming).
    """
    audio, sr = librosa.load(recording_path, sr=None, mono=False)
    data = audio.T if audio.ndim > 1 else audio
    sf.write(output_path, data, sr)
    return {"path": output_path}


def _probe_source(path: str) -> tuple:
    """
    Returns (duration_sec, sample_rate, full_samples_or_None). For plain WAV
    files, soundfile.info() gives an instant, reliable duration and we defer
    decoding to an offset-based partial read. For anything soundfile can't
    parse (e.g. a take's .webm/opus), `librosa.get_duration(path=...)` is
    unreliable — it silently returns 0 for at least some real Opus-in-WebM
    recordings — so decode the whole file up front instead and slice it
    in memory; this is what already happens in `convert_take_to_wav`.
    """
    try:
        info = sf.info(path)
        return info.frames / info.samplerate, info.samplerate, None
    except Exception:
        audio, sr = librosa.load(path, sr=None, mono=False)
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        samples = audio.T  # (n, channels)
        return samples.shape[0] / sr, sr, samples


def _load_source_slice(source: dict, start_sec: float, end_sec: float) -> tuple:
    """
    Decode the portion of `source` that falls within [start_sec, end_sec) of
    the *project* timeline, returning (samples, sr) already padded/truncated
    to exactly (end_sec - start_sec) seconds. `samples` is shape (n, channels).
    """
    path = source["path"]
    window_len = end_sec - start_sec

    if source.get("isTake"):
        # fileTime = projectTime - startPosition + audioOffset (see player.ts).
        start_position = float(source.get("startPosition", 0.0))
        audio_offset = float(source.get("audioOffset", 0.0))
        file_start = start_sec - start_position + audio_offset
        file_end = end_sec - start_position + audio_offset
    else:
        file_start = start_sec
        file_end = end_sec

    duration, sr, full_samples = _probe_source(path)
    clipped_start = max(0.0, file_start)
    clipped_end = min(duration, file_end)

    if clipped_end <= clipped_start:
        # Requested window doesn't overlap this source's file at all — silence.
        return None, None

    if full_samples is not None:
        start_idx = int(round(clipped_start * sr))
        end_idx = int(round(clipped_end * sr))
        samples = full_samples[start_idx:end_idx]
    else:
        audio, sr = librosa.load(
            path, sr=None, mono=False,
            offset=clipped_start, duration=clipped_end - clipped_start,
        )
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        samples = audio.T  # (n, channels)

    # Position this slice within the full window (front/back silence for
    # the part of the window this source doesn't cover).
    lead_silence = max(0.0, clipped_start - max(0.0, file_start))
    lead_samples = int(round(lead_silence * sr))
    target_samples = int(round(window_len * sr))

    if samples.shape[1] == 1:
        samples = np.repeat(samples, 2, axis=1)

    out = np.zeros((target_samples, samples.shape[1]), dtype=np.float32)
    n = min(samples.shape[0], target_samples - lead_samples)
    if n > 0:
        out[lead_samples:lead_samples + n] = samples[:n]
    return out, sr


def mix_export(sources: list, start_sec: float, end_sec: float, output_path: str) -> dict:
    """
    Render a single WAV mixdown from `sources` (each {path, gain, isTake,
    startPosition?, audioOffset?}), trimmed to [start_sec, end_sec) of the
    project timeline, summing per-source gain. Mute/solo has already been
    resolved to a final linear gain by the caller — sources with gain 0
    should already be omitted, but any included source is still mixed in.
    """
    if not sources:
        raise ValueError("mix_export requires at least one source")

    target_sr = None
    channels = 2
    mixed = None

    for source in sources:
        samples, sr = _load_source_slice(source, start_sec, end_sec)
        if samples is None:
            continue

        if target_sr is None:
            target_sr = sr
        elif sr != target_sr:
            samples = librosa.resample(samples.T, orig_sr=sr, target_sr=target_sr).T

        gained = samples * float(source["gain"])
        if mixed is None:
            mixed = gained
        else:
            # Sources can differ in sample count by a rounding error after
            # resampling — trim to the shorter one rather than crash.
            n = min(mixed.shape[0], gained.shape[0])
            mixed = mixed[:n] + gained[:n]

    if mixed is None or target_sr is None:
        # None of the sources overlapped the requested window at all.
        target_samples = int(round((end_sec - start_sec) * SAMPLE_RATE))
        mixed = np.zeros((target_samples, channels), dtype=np.float32)
        target_sr = SAMPLE_RATE

    peak = float(np.max(np.abs(mixed))) if mixed.size else 0.0
    if peak > 1.0:
        mixed = mixed / peak

    sf.write(output_path, mixed, target_sr)
    return {"path": output_path}


def analyze_recording(
    recording_path: str,
    output_dir=None,
    on_progress=None,
    audio_offset_s: float = 0.0,
    reference_path: str | None = None,
    pitch_algorithm: str = "srh",
) -> dict:
    """
    Analyze a vocal recording (user take).

    audio_offset_s: seconds to skip at the start of the file (latency compensation).
    reference_path: optional loudness reference (e.g. vocals.wav) to RMS-match the take against.
    pitch_algorithm: one of "srh" (default), "pyin", "hps", "crepe" — see
      processor.PITCH_ALGORITHMS / get_pitch_fn. Must match whatever was used
      for the song's own pitch data for song/take pitch curves to compare
      meaningfully.
    Returns dict with pitchData (parallel arrays), onsets, dynamics, vibrato, normalizedPath.
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    # --- Stage 1: pitch extraction (0.0 – 0.50) ---
    on_progress(0.0, "pitch-extraction")
    print(f"Running {pitch_algorithm.upper()} pitch extraction on recording...", file=sys.stderr)

    audio, sr = librosa.load(recording_path, sr=SRH_SR, mono=True, offset=audio_offset_s)
    pitch_result = get_pitch_fn(pitch_algorithm)(audio, sr)
    n_voiced = sum(pitch_result["voiced"])
    print(f"Pitch detection complete: {n_voiced} voiced frames", file=sys.stderr)
    on_progress(0.50, "pitch-extraction")

    # Different algorithms may use different effective hop lengths, which
    # _detect_vibrato's frequency-domain step-size assumption depends on —
    # derive it from the actual returned times rather than assuming the
    # SRH-specific STEP_MS constant.
    pitch_times = pitch_result["times"]
    step_ms = (pitch_times[1] - pitch_times[0]) * 1000 if len(pitch_times) > 1 else STEP_MS

    # --- Stage 2: Onset detection (0.50 – 0.70) ---
    on_progress(0.60, "onset-detection")
    print("Detecting onsets...", file=sys.stderr)

    audio_lr, sr_lr = librosa.load(recording_path, sr=SAMPLE_RATE, mono=True, offset=audio_offset_s)
    onset_frames = librosa.onset.onset_detect(y=audio_lr, sr=sr_lr, units="frames")
    onsets = [round(t, 4) for t in librosa.frames_to_time(onset_frames, sr=sr_lr).tolist()]
    on_progress(0.70, "onset-detection")

    # --- Stage 3: Dynamics / RMS (0.70 – 0.85) ---
    on_progress(0.80, "dynamics")
    print("Computing dynamics...", file=sys.stderr)

    rms = librosa.feature.rms(y=audio_lr)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr_lr)
    dynamics = [
        {"time": round(float(rms_times[i]), 4), "rms": round(float(rms[i]), 6)}
        for i in range(len(rms))
    ]
    on_progress(0.85, "dynamics")

    # --- Stage 4: Vibrato detection (0.85 – 0.90) ---
    on_progress(0.90, "vibrato-detection")
    print("Analyzing vibrato...", file=sys.stderr)

    vibrato = _detect_vibrato(
        np.array(pitch_result["f0"]),
        np.array(pitch_result["confidence"]),
        step_ms,
    )

    # --- Stage 5: Short-Term Spectrum (0.90 – 1.0) ---
    on_progress(0.92, "short-term-spectrum")
    print("Computing short-term spectrum...", file=sys.stderr)

    st_spectrum_result = {"stSpectrumTimes": [], "stSpectrumB64": "", "stSpectrumFrames": 0, "stSpectrumBins": 0}
    try:
        st_spectrum_result = compute_short_term_spectrum(audio_lr, sr_lr)
    except Exception as e:
        print(f"Short-term spectrum error: {e}", file=sys.stderr)

    # --- Stage 6: Loudness normalization (1.0) ---
    print("Normalizing take loudness...", file=sys.stderr)

    # Unlike every other stage above, this one has no fallback if it fails —
    # a caller (Rust's save_exercise_take/save_take) that gets a truthy
    # normalizedPath back deletes the raw recording, trusting the normalized
    # file exists. Guard against any decode/write failure (a real webm/opus
    # recording can hit backend-specific quirks the other librosa.load calls
    # above didn't — see _probe_source's docstring on unreliable duration
    # metadata for this exact file type) so a broken normalization degrades
    # to "no normalized file" instead of a dangling reference to one that was
    # never actually written.
    normalized_path = None
    gain_linear = 0.0
    try:
        take_audio, take_sr = librosa.load(recording_path, sr=None, mono=True, offset=audio_offset_s)
        take_rms_db = _rms_dbfs(take_audio)
        take_peak = float(np.max(np.abs(take_audio))) if take_audio.size else 0.0

        if reference_path and os.path.exists(reference_path):
            ref_audio, _ = librosa.load(reference_path, sr=take_sr, mono=True)
            target_rms_db = _rms_dbfs(ref_audio)
        else:
            target_rms_db = TARGET_RMS_DBFS_FALLBACK

        gain_linear = 10 ** ((target_rms_db - take_rms_db) / 20)
        if take_peak > 0:
            max_safe_gain = 10 ** (PEAK_CEILING_DBFS / 20) / take_peak
            gain_linear = min(gain_linear, max_safe_gain)

        candidate_path = os.path.splitext(recording_path)[0] + ".wav"
        sf.write(candidate_path, take_audio * gain_linear, take_sr)

        # Verify the write actually landed before reporting success — a
        # caller trusts this path enough to delete the raw recording.
        if os.path.exists(candidate_path) and os.path.getsize(candidate_path) > 0:
            normalized_path = candidate_path
        else:
            print(f"Normalization wrote no usable file at {candidate_path}", file=sys.stderr)
    except Exception as e:
        print(f"Loudness normalization error: {e}\n{traceback.format_exc()}", file=sys.stderr)

    on_progress(1.0, "complete")

    return {
        "pitchData": pitch_result,
        "onsets": onsets,
        "dynamics": dynamics,
        "vibrato": vibrato,
        "normalizedPath": normalized_path,
        "appliedGainDb": round(20 * np.log10(gain_linear), 2) if gain_linear > 0 else 0.0,
        **st_spectrum_result,
    }
