"""
Core processing pipeline for uploaded songs.
Demucs stem separation → CREPE pitch → librosa onsets/dynamics/BPM → key detection.
"""

import os
import sys
import traceback
import numpy as np
import soundfile as sf
import librosa

SAMPLE_RATE = 44100
CREPE_STEP_MS = 10
CREPE_MODEL = "small"
CONFIDENCE_THRESHOLD = 0.5

# Krumhansl-Kessler key profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _detect_key(pitch_hz: np.ndarray, confidence: np.ndarray) -> str:
    """Detect musical key from pitch data using pitch class histogram."""
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
    """
    Full processing pipeline for an uploaded song.

    Args:
        input_path: Path to audio file (mp3, wav, etc.)
        output_dir: Directory to write stems and analysis data.
        on_progress: Callback(value: float, stage: str) for progress updates.

    Returns:
        Dict with vocals/instrumental paths, pitchData, onsets, dynamics, detectedBpm, detectedKey.
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    os.makedirs(output_dir, exist_ok=True)

    # --- Stage 1: Demucs stem separation (0.0 – 0.50) ---
    on_progress(0.0, "stem-separation")
    print("Loading Demucs separator...", file=sys.stderr)

    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from demucs.audio import AudioFile

    model = get_model("htdemucs")
    model.eval()
    on_progress(0.05, "stem-separation")

    # Load audio at model's sample rate
    wav = AudioFile(input_path).read(streams=0, samplerate=model.samplerate, channels=model.audio_channels)
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()
    on_progress(0.10, "stem-separation")

    with torch.no_grad():
        sources = apply_model(model, wav[None], progress=False)[0]
    on_progress(0.45, "stem-separation")

    # sources shape: (num_sources, channels, samples)
    # model.sources: ['drums', 'bass', 'other', 'vocals']
    source_names = model.sources
    vocals_idx = source_names.index("vocals")
    vocals_tensor = sources[vocals_idx]

    # Sum all non-vocal sources for instrumental
    instrumental_tensor = sum(sources[i] for i in range(len(source_names)) if i != vocals_idx)

    # Denormalize
    vocals_tensor = vocals_tensor * ref.std() + ref.mean()
    instrumental_tensor = instrumental_tensor * ref.std() + ref.mean()

    vocals_np = vocals_tensor.numpy()
    instrumental_np = instrumental_tensor.numpy()

    # Shape: (channels, samples). Transpose for soundfile (samples, channels).
    vocals_path = os.path.join(output_dir, "vocals.wav")
    instrumental_path = os.path.join(output_dir, "instrumental.wav")
    sf.write(vocals_path, vocals_np.T, model.samplerate)
    sf.write(instrumental_path, instrumental_np.T, model.samplerate)
    on_progress(0.50, "stem-separation")

    # --- Stage 2: CREPE pitch extraction on vocals (0.50 – 0.70) ---
    on_progress(0.50, "pitch-extraction")
    print("Running CREPE pitch extraction...", file=sys.stderr)

    import torch
    import torchcrepe

    # Load vocals as mono at 16kHz for CREPE
    vocals_mono, sr_vocals = librosa.load(vocals_path, sr=16000, mono=True)
    audio_tensor = torch.tensor(vocals_mono).unsqueeze(0)  # (1, samples)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    frequency, confidence = torchcrepe.predict(
        audio_tensor, sr_vocals,
        hop_length=int(sr_vocals * CREPE_STEP_MS / 1000),
        model="tiny",
        device=device,
        return_periodicity=True,
        batch_size=512,
    )
    frequency = frequency.squeeze(0).numpy()
    confidence = confidence.squeeze(0).numpy()
    on_progress(0.70, "pitch-extraction")

    # Build pitchData array (matching frontend PitchPoint interface)
    times = np.arange(len(frequency)) * (CREPE_STEP_MS / 1000.0)
    pitch_data = []
    for i in range(len(frequency)):
        if confidence[i] >= CONFIDENCE_THRESHOLD and frequency[i] > 0:
            pitch_data.append({
                "time": round(float(times[i]), 4),
                "frequency": round(float(frequency[i]), 2),
                "confidence": round(float(confidence[i]), 3),
            })

    # --- Stage 3: Onset detection (0.70 – 0.80) ---
    on_progress(0.70, "onset-detection")
    print("Detecting onsets...", file=sys.stderr)

    vocals_lr, sr_lr = librosa.load(vocals_path, sr=SAMPLE_RATE, mono=True)
    onset_frames = librosa.onset.onset_detect(y=vocals_lr, sr=sr_lr, units="frames")
    onsets = librosa.frames_to_time(onset_frames, sr=sr_lr).tolist()
    onsets = [round(t, 4) for t in onsets]
    on_progress(0.80, "onset-detection")

    # --- Stage 4: Dynamics / RMS (0.80 – 0.85) ---
    on_progress(0.80, "dynamics")
    print("Computing dynamics...", file=sys.stderr)

    rms = librosa.feature.rms(y=vocals_lr)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr_lr)
    dynamics = []
    for i in range(len(rms)):
        dynamics.append({
            "time": round(float(rms_times[i]), 4),
            "rms": round(float(rms[i]), 6),
        })
    on_progress(0.85, "dynamics")

    # --- Stage 5: BPM detection (0.85 – 0.90) ---
    on_progress(0.85, "bpm-detection")
    print("Estimating BPM...", file=sys.stderr)

    # Load original (full mix) for BPM — more rhythmic content
    full_mix, sr_full = librosa.load(input_path, sr=SAMPLE_RATE, mono=True)
    tempo = librosa.beat.tempo(y=full_mix, sr=sr_full)
    detected_bpm = round(float(tempo[0]), 1) if len(tempo) > 0 else None
    on_progress(0.90, "bpm-detection")

    # --- Stage 6: Key detection (0.90 – 1.0) ---
    on_progress(0.90, "key-detection")
    print("Detecting key...", file=sys.stderr)

    detected_key = _detect_key(frequency, confidence)
    on_progress(1.0, "complete")

    return {
        "vocals": vocals_path,
        "instrumental": instrumental_path,
        "pitchData": pitch_data,
        "onsets": onsets,
        "dynamics": dynamics,
        "detectedBpm": detected_bpm,
        "detectedKey": detected_key,
    }
