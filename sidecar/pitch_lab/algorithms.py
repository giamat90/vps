"""
Pitch-detection algorithms available for comparison in the lab.

`srh_production`, `pyin_production`, `hps_production`, `crepe_production`,
and `praat_production` call the exact functions shipped in processor.py — no
duplication, so results always reflect what's actually running in the app
(all five are user-selectable in the shipped Settings panel, not just SRH).
`srh_variant` reimplements SRH with every constant exposed as a keyword
argument, for A/B testing parameter changes before manually porting a winning
combination back into processor.py; `praat_variant` does the same for every
Boersma-algorithm knob parselmouth exposes.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import librosa
from scipy.signal import find_peaks
from scipy.signal.windows import chebwin
from scipy.ndimage import median_filter, gaussian_filter1d
from processor import detect_pitch_srh, detect_pitch, detect_pitch_hps, detect_pitch_crepe, detect_pitch_praat


def srh_production(audio: np.ndarray, sr: int) -> dict:
    return detect_pitch_srh(audio, sr)


def pyin_production(audio: np.ndarray, sr: int) -> dict:
    return detect_pitch(audio, sr)


def hps_production(audio: np.ndarray, sr: int) -> dict:
    return detect_pitch_hps(audio, sr)


def crepe_production(audio: np.ndarray, sr: int) -> dict:
    return detect_pitch_crepe(audio, sr)


def praat_production(audio: np.ndarray, sr: int) -> dict:
    return detect_pitch_praat(audio, sr)


def praat_variant(
    audio: np.ndarray, sr: int, *,
    time_step: float = 512 / 22050,
    pitch_floor: float = 65.0,
    pitch_ceiling: float = 1400.0,
    max_number_of_candidates: int = 15,
    very_accurate: bool = False,
    silence_threshold: float = 0.03,
    voicing_threshold: float = 0.45,
    octave_cost: float = 0.01,
    octave_jump_cost: float = 0.35,
    voiced_unvoiced_cost: float = 0.14,
) -> dict:
    """
    Parametrized wrapper over parselmouth's full Boersma-algorithm signature
    (processor.py's detect_pitch_praat keeps Praat defaults). The interesting
    knobs for the VoceVista comparison: `octave_cost` (raising it strengthens
    the "prefer harmonic fundamental" pull toward lower candidates) and
    `voicing_threshold` (raising it trades voiced coverage for confidence).
    """
    import parselmouth

    snd = parselmouth.Sound(audio.astype(np.float64), sampling_frequency=sr)
    pitch = snd.to_pitch_ac(
        time_step=time_step,
        pitch_floor=pitch_floor,
        max_number_of_candidates=max_number_of_candidates,
        very_accurate=very_accurate,
        silence_threshold=silence_threshold,
        voicing_threshold=voicing_threshold,
        octave_cost=octave_cost,
        octave_jump_cost=octave_jump_cost,
        voiced_unvoiced_cost=voiced_unvoiced_cost,
        pitch_ceiling=pitch_ceiling,
    )

    times = np.asarray(pitch.xs())
    f0 = pitch.selected_array["frequency"].copy()
    confidence = np.clip(pitch.selected_array["strength"], 0.0, 1.0)
    voiced = f0 > 0
    f0[~voiced] = 0.0
    confidence[~voiced] = 0.0

    return {
        "times": times.tolist(),
        "f0": f0.tolist(),
        "voiced": voiced.tolist(),
        "confidence": confidence.tolist(),
    }


def srh_variant(
    audio: np.ndarray, sr: int, *,
    frame_length: int = 2756,
    fft_size: int = 4096,
    hop_length: int = 512,
    n_harmonics: int = 5,
    fmin: float = 65.0,
    fmax: float = 1400.0,
    voicing_threshold: float = 0.25,
    amplitude_threshold_db: float = -50.0,
    median_size: int = 6,
    gaussian_sigma: float = 1.5,
) -> dict:
    """Parametrized reimplementation of detect_pitch_srh (processor.py:126-268)."""
    target_sr = 22050
    if sr != target_sr:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=target_sr)
        sr = target_sr

    amplitude_threshold = 10 ** (amplitude_threshold_db / 20)

    audio = np.pad(audio, frame_length // 2, mode="reflect")
    frames = librosa.util.frame(audio, frame_length=frame_length, hop_length=hop_length)
    n_frames = frames.shape[1]

    freqs = np.fft.rfftfreq(fft_size, d=1.0 / sr)
    bin_width = sr / fft_size
    f0_candidates = np.arange(fmin, fmax, 0.5)

    harmonic_bins = np.array([
        np.round(f0_candidates * n / bin_width).astype(int)
        for n in range(1, n_harmonics + 1)
    ]).T
    inter_bins = np.array([
        np.round(f0_candidates * (n + 0.5) / bin_width).astype(int)
        for n in range(1, n_harmonics + 1)
    ]).T
    max_bin = len(freqs) - 1
    harmonic_bins = np.clip(harmonic_bins, 0, max_bin)
    inter_bins = np.clip(inter_bins, 0, max_bin)

    window = chebwin(frame_length, at=100)
    f0 = np.zeros(n_frames)
    confidence = np.zeros(n_frames)

    for i in range(n_frames):
        raw_frame = frames[:, i]
        if np.sqrt(np.mean(raw_frame ** 2)) < amplitude_threshold:
            continue
        frame = raw_frame * window
        spectrum = np.abs(np.fft.rfft(frame, n=fft_size))
        spectrum = spectrum / (spectrum.max() + 1e-8)
        harmonic_energy = spectrum[harmonic_bins].sum(axis=1)
        inter_energy = spectrum[inter_bins].sum(axis=1)
        srh_scores = harmonic_energy - inter_energy
        best_idx = np.argmax(srh_scores)
        best_score = srh_scores[best_idx]
        if 0 < best_idx < len(srh_scores) - 1:
            alpha, beta, gamma = srh_scores[best_idx - 1], srh_scores[best_idx], srh_scores[best_idx + 1]
            denom = alpha - 2 * beta + gamma
            p = np.clip(0.5 * (alpha - gamma) / denom, -1.0, 1.0) if denom != 0 else 0.0
        else:
            p = 0.0
        f0[i] = f0_candidates[best_idx] + p * 0.5
        confidence[i] = best_score

    if confidence.max() > 0:
        confidence = confidence / confidence.max()

    voiced = confidence > voicing_threshold
    f0_clean = np.where(voiced, f0, 0.0)

    f0_smooth = f0_clean.copy()
    voiced_indices = np.where(voiced)[0]
    if len(voiced_indices) > 3:
        f0_smooth[voiced_indices] = median_filter(f0_clean[voiced_indices], size=median_size)
        f0_smooth[voiced_indices] = gaussian_filter1d(f0_smooth[voiced_indices], sigma=gaussian_sigma)
    f0_clean = f0_smooth

    times = librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=hop_length)
    return {
        "times": times.tolist(),
        "f0": f0_clean.tolist(),
        "voiced": voiced.tolist(),
        "confidence": confidence.tolist(),
    }


def first_peak_production(audio: np.ndarray, sr: int) -> dict:
    return first_peak_variant(audio, sr)


def first_peak_variant(
    audio: np.ndarray, sr: int, *,
    frame_length: int = 2756,
    fft_size: int = 4096,
    hop_length: int = 512,
    fmin: float = 65.0,
    fmax: float = 1400.0,
    peak_prominence: float = 0.1,
    voicing_threshold: float = 0.15,
    amplitude_threshold_db: float = -50.0,
) -> dict:
    """
    Naive "first spectral peak" pitch detector: per frame, scan the magnitude
    spectrum from fmin upward and take the first local maximum that clears
    `peak_prominence` (as a fraction of the frame's own peak magnitude) as F0.

    Unlike SRH (sums harmonic energy across candidates) or pYIN
    (autocorrelation), this does zero harmonic reasoning — it assumes the
    first strong partial encountered from below the fundamental range IS the
    fundamental. Kept deliberately naive as a baseline: it's expected to fail
    whenever a strong non-fundamental partial (sub-harmonic noise, breath,
    a harmonic that outweighs F0 after Demucs separation artifacts) sits
    below the true F0 in the spectrum.
    """
    target_sr = 22050
    if sr != target_sr:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=target_sr)
        sr = target_sr

    amplitude_threshold = 10 ** (amplitude_threshold_db / 20)

    audio = np.pad(audio, frame_length // 2, mode="reflect")
    frames = librosa.util.frame(audio, frame_length=frame_length, hop_length=hop_length)
    n_frames = frames.shape[1]

    freqs = np.fft.rfftfreq(fft_size, d=1.0 / sr)
    band_idx = np.where((freqs >= fmin) & (freqs <= fmax))[0]
    band_freqs = freqs[band_idx]

    window = chebwin(frame_length, at=100)
    f0 = np.zeros(n_frames)
    confidence = np.zeros(n_frames)

    for i in range(n_frames):
        raw_frame = frames[:, i]
        if np.sqrt(np.mean(raw_frame ** 2)) < amplitude_threshold:
            continue

        frame = raw_frame * window
        spectrum = np.abs(np.fft.rfft(frame, n=fft_size))
        spectrum = spectrum / (spectrum.max() + 1e-8)

        band_spectrum = spectrum[band_idx]
        peaks, _ = find_peaks(band_spectrum, height=peak_prominence)
        if len(peaks) == 0:
            continue

        first_peak = peaks[0]  # lowest-frequency qualifying peak — no harmonic check
        f0[i] = band_freqs[first_peak]
        confidence[i] = band_spectrum[first_peak]

    voiced = confidence > voicing_threshold
    f0_clean = np.where(voiced, f0, 0.0)

    times = librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=hop_length)
    return {
        "times": times.tolist(),
        "f0": f0_clean.tolist(),
        "voiced": voiced.tolist(),
        "confidence": confidence.tolist(),
    }
