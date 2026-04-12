"""
Core processing pipeline for uploaded songs.
Demucs stem separation → pyin pitch → librosa onsets/dynamics/BPM → key detection.
"""

import os
import sys
import gc
import time
import traceback
import numpy as np
import soundfile as sf
import librosa

SAMPLE_RATE = 44100
CONFIDENCE_THRESHOLD = 0.5

# Krumhansl-Kessler key profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _log(msg: str):
    print(msg, file=sys.stderr, flush=True)


def _detect_key(pitch_hz: np.ndarray, confidence: np.ndarray) -> str:
    valid = (confidence >= CONFIDENCE_THRESHOLD) & (pitch_hz > 0)
    freqs = pitch_hz[valid]
    if len(freqs) < 50:
        return "Unknown"

    midi = 69 + 12 * np.log2(freqs / 440.0)
    pitch_classes = np.round(midi).astype(int) % 12
    histogram = np.bincount(pitch_classes, minlength=12).astype(float)
    histogram /= histogram.sum() + 1e-9

    best_score = -np.inf
    best_key = "C major"
    for shift in range(12):
        rotated = np.roll(histogram, -shift)
        maj_score = np.corrcoef(rotated, MAJOR_PROFILE)[0, 1]
        min_score = np.corrcoef(rotated, MINOR_PROFILE)[0, 1]
        if maj_score > best_score:
            best_score = maj_score
            best_key = f"{NOTE_NAMES[shift]} major"
        if min_score > best_score:
            best_score = min_score
            best_key = f"{NOTE_NAMES[shift]} minor"

    return best_key


def process(input_path: str, output_dir: str, on_progress=None) -> dict:
    """Full processing pipeline for an uploaded song."""
    if on_progress is None:
        on_progress = lambda v, s: None

    os.makedirs(output_dir, exist_ok=True)

    # ===================================================================
    # Stage 1: Demucs stem separation (0.00 – 0.50)
    # ===================================================================
    on_progress(0.0, "stem-separation")
    _log("Loading Demucs model...")

    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from demucs.audio import AudioFile

    model = get_model("htdemucs")
    model.eval()
    on_progress(0.05, "stem-separation")

    wav = AudioFile(input_path).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()
    on_progress(0.10, "stem-separation")

    _log("Running Demucs separation...")
    with torch.no_grad():
        sources = apply_model(model, wav[None], progress=False)[0]
    on_progress(0.45, "stem-separation")

    source_names = model.sources
    vocals_idx = source_names.index("vocals")
    vocals_tensor = sources[vocals_idx]
    instrumental_tensor = sum(
        sources[i] for i in range(len(source_names)) if i != vocals_idx
    )

    vocals_tensor = vocals_tensor * ref.std() + ref.mean()
    instrumental_tensor = instrumental_tensor * ref.std() + ref.mean()

    vocals_path = os.path.join(output_dir, "vocals.wav")
    instrumental_path = os.path.join(output_dir, "instrumental.wav")
    sf.write(vocals_path, vocals_tensor.numpy().T, model.samplerate)
    sf.write(instrumental_path, instrumental_tensor.numpy().T, model.samplerate)
    on_progress(0.50, "stem-separation")

    _log("Freeing Demucs from memory...")
    del model, sources, wav, ref, vocals_tensor, instrumental_tensor
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # ===================================================================
    # Stage 2: pyin pitch extraction (0.50 – 0.70)
    # ===================================================================
    on_progress(0.50, "pitch-extraction")
    _log("Running pitch detection (pyin)...")

    pitch_data = []

    try:
        vocals_pyin, sr_pyin = librosa.load(vocals_path, sr=22050, mono=True)

        f0, voiced_flag, voiced_probs = librosa.pyin(
            vocals_pyin,
            fmin=librosa.note_to_hz('C2'),
            fmax=librosa.note_to_hz('C7'),
            sr=sr_pyin,
            hop_length=512,
        )

        times = librosa.times_like(f0, sr=sr_pyin, hop_length=512)

        for i in range(len(f0)):
            if voiced_flag[i] and not np.isnan(f0[i]):
                pitch_data.append({
                    "time": round(float(times[i]), 4),
                    "frequency": round(float(f0[i]), 2),
                    "confidence": round(float(voiced_probs[i]), 3),
                })

        _log(f"Pitch detection complete: {len(pitch_data)} voiced frames")

    except Exception as e:
        _log(f"pyin error: {e}\n{traceback.format_exc()}")

    on_progress(0.70, "pitch-extraction")
    gc.collect()

    # ===================================================================
    # Stage 3: Onset detection (0.70 – 0.82)
    # ===================================================================
    on_progress(0.70, "onset-detection")
    _log("Detecting onsets...")

    vocals_lr, sr_lr = librosa.load(vocals_path, sr=SAMPLE_RATE, mono=True)
    onset_frames = librosa.onset.onset_detect(y=vocals_lr, sr=sr_lr, units="frames")
    onsets = librosa.frames_to_time(onset_frames, sr=sr_lr).tolist()
    onsets = [round(t, 4) for t in onsets]
    on_progress(0.82, "onset-detection")

    # ===================================================================
    # Stage 4: Dynamics / RMS (0.82 – 0.88)
    # ===================================================================
    on_progress(0.82, "dynamics")
    _log("Computing dynamics...")

    rms = librosa.feature.rms(y=vocals_lr)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr_lr)
    dynamics = [
        {"time": round(float(rms_times[i]), 4), "rms": round(float(rms[i]), 6)}
        for i in range(len(rms))
    ]
    on_progress(0.88, "dynamics")

    # ===================================================================
    # Stage 5: BPM detection (0.88 – 0.93)
    # ===================================================================
    on_progress(0.88, "bpm-detection")
    _log("Estimating BPM...")

    full_mix, sr_full = librosa.load(input_path, sr=SAMPLE_RATE, mono=True)
    tempo = librosa.beat.tempo(y=full_mix, sr=sr_full)
    detected_bpm = round(float(tempo[0]), 1) if len(tempo) > 0 else None
    on_progress(0.93, "bpm-detection")

    del full_mix, vocals_lr
    gc.collect()

    # ===================================================================
    # Stage 6: Key detection (0.93 – 1.0)
    # ===================================================================
    on_progress(0.93, "key-detection")
    _log("Detecting key...")

    if pitch_data:
        freq_array = np.array([p["frequency"] for p in pitch_data])
        conf_array = np.array([p["confidence"] for p in pitch_data])
        detected_key = _detect_key(freq_array, conf_array)
    else:
        detected_key = "Unknown"

    on_progress(1.0, "complete")
    _log("Processing complete.")

    return {
        "vocals": vocals_path,
        "instrumental": instrumental_path,
        "pitchData": pitch_data,
        "onsets": onsets,
        "dynamics": dynamics,
        "detectedBpm": detected_bpm,
        "detectedKey": detected_key,
    }


def pitch_shift_song(song_dir: str, cache_dir: str, n_steps: float, on_progress=None):
    """Pitch-shift vocals.wav and instrumental.wav by n_steps semitones.

    Results are written to cache_dir/vocals.wav and cache_dir/instrumental.wav.
    Uses the phase vocoder so tempo is preserved.
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    tracks = ["vocals.wav", "instrumental.wav"]
    paths = {}

    for i, name in enumerate(tracks):
        input_path = os.path.join(song_dir, name)
        output_path = os.path.join(cache_dir, name)

        on_progress(i / len(tracks), f"loading-{name}")
        audio, sr = librosa.load(input_path, sr=None, mono=False)

        on_progress((i + 0.5) / len(tracks), f"shifting-{name}")
        if audio.ndim == 1:
            shifted = librosa.effects.pitch_shift(
                audio, sr=sr, n_steps=n_steps, res_type="kaiser_fast"
            )
        else:
            shifted = np.stack([
                librosa.effects.pitch_shift(
                    audio[ch], sr=sr, n_steps=n_steps, res_type="kaiser_fast"
                )
                for ch in range(audio.shape[0])
            ])

        sf.write(output_path, shifted.T if shifted.ndim > 1 else shifted, sr)
        paths[name] = output_path
        del audio, shifted
        gc.collect()

    on_progress(1.0, "complete")
    return {
        "vocalsPath": paths["vocals.wav"],
        "instrumentalPath": paths["instrumental.wav"],
    }
