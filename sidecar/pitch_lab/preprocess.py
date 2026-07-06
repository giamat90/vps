"""
Optional audio "cleaning" steps applied to a split vocal track BEFORE pitch
detection. Aimed at suppressing artifacts from imperfect Demucs separation
(instrument/drum bleed, transient noise bursts) — NOT generic denoising.
VPS's own history (see VPS/CLAUDE.md "Pitch detection choices") already
found that treating Demucs output like raw noisy speech backfires (the
LP-residual approach was tried and reverted); what actually hurts pitch
detection here is leftover non-vocal energy that leaked through separation,
not broadband noise.

Steps are composable — apply only the ones relevant to a given track's
symptoms via `apply_pipeline(audio, sr, steps=[...])`, not all of them
blindly.
"""
import numpy as np
import librosa
from scipy.signal import butter, sosfiltfilt


def trim_silence(audio: np.ndarray, sr: int, top_db: float = 40.0) -> np.ndarray:
    """Drop leading/trailing near-silence so frame padding (reflect mode,
    used by detect_pitch_srh) doesn't smear silence into the first/last
    analysis windows."""
    trimmed, _ = librosa.effects.trim(audio, top_db=top_db)
    return trimmed


def highpass_rumble(audio: np.ndarray, sr: int, cutoff_hz: float = 55.0, order: int = 4) -> np.ndarray:
    """Remove sub-fmin rumble/bleed (kick drum, bass, mic handling noise)
    that sits below any plausible singing fundamental (fmin=65Hz in both
    SRH and pYIN) but can still distort broadband RMS gating."""
    sos = butter(order, cutoff_hz, btype="highpass", fs=sr, output="sos")
    return sosfiltfilt(sos, audio)


def harmonic_only(audio: np.ndarray, sr: int, margin: float = 8.0) -> np.ndarray:
    """Suppress percussive/transient bleed (residual drums, clicks, pick
    noise) via median-filtering HPSS, keeping only the harmonic-sustained
    component pitch detection actually cares about. Higher margin = more
    aggressive percussive suppression (and more risk of softening real
    vocal transients like plosives/consonant onsets)."""
    return librosa.effects.harmonic(audio, margin=margin)


def spectral_denoise(
    audio: np.ndarray, sr: int, *,
    n_fft: int = 2048,
    hop_length: int = 512,
    over_subtraction: float = 1.5,
    floor_ratio: float = 0.15,
    noise_percentile: float = 10.0,
) -> np.ndarray:
    """
    Conservative spectral-gating denoise (Boll 1979-style spectral
    subtraction): estimate a noise magnitude profile from the quietest
    `noise_percentile`% of frames (assumed residual bleed/room noise, not
    vocal signal), subtract `over_subtraction` times that profile from every
    frame, floored at `floor_ratio` of the original magnitude so no bin is
    ever fully zeroed. The floor matters — zeroing bins entirely causes
    "musical noise" artifacts and, more importantly here, risks stripping
    legitimate low-level vocal texture (breathiness, rasp) that some
    singers rely on. Kept deliberately mild for the same reason `hpss`
    turned out to hurt raspy vocals in this lab's own tests: anything that
    suppresses "noise-like" energy risks suppressing real vocal color too.
    """
    stft = librosa.stft(audio, n_fft=n_fft, hop_length=hop_length)
    mag, phase = np.abs(stft), np.angle(stft)

    frame_energy = mag.mean(axis=0)
    noise_thresh = np.percentile(frame_energy, noise_percentile)
    noise_frames = mag[:, frame_energy <= noise_thresh]
    if noise_frames.shape[1] == 0:
        return audio
    noise_profile = np.median(noise_frames, axis=1, keepdims=True)

    subtracted = mag - over_subtraction * noise_profile
    floor = floor_ratio * mag
    mag_clean = np.maximum(subtracted, floor)

    stft_clean = mag_clean * np.exp(1j * phase)
    return librosa.istft(stft_clean, hop_length=hop_length, length=len(audio))


def normalize_loudness(audio: np.ndarray, sr: int, target_dbfs: float = -20.0) -> np.ndarray:
    """RMS-normalize to a fixed loudness so algorithms with an absolute dB
    threshold (SRH/first-peak's amplitude_threshold=-50dBFS in
    processor.py/algorithms.py) behave consistently across tracks
    mixed/mastered at different levels, instead of silently gating
    differently depending on source loudness."""
    rms = np.sqrt(np.mean(audio ** 2))
    if rms < 1e-9:
        return audio
    target_rms = 10 ** (target_dbfs / 20)
    return audio * (target_rms / rms)


STEPS = {
    "trim": trim_silence,
    "highpass": highpass_rumble,
    "hpss": harmonic_only,
    "denoise": spectral_denoise,
    "normalize": normalize_loudness,
}

# Order matters: trim first (cheap, avoids padding artifacts), highpass
# before hpss (remove rumble before harmonic/percussive median filtering),
# normalize last (reflects the loudness of the actually-analyzed signal).
#
# "hpss" is deliberately NOT in the default pipeline: tested against SRH on
# two real split vocal tracks (see pitch_lab/README.md "Preprocessing
# findings"), it never improved voiced%/confidence and measurably hurt one
# of them (raspy/gritty vocal texture reads partly as "percussive" to HPSS
# and gets suppressed like drum bleed). Pass it explicitly via --steps if a
# specific track is suspected to have real percussive/drum bleed.
DEFAULT_PIPELINE = ["trim", "highpass", "normalize"]


def apply_pipeline(audio: np.ndarray, sr: int, steps: list = None) -> np.ndarray:
    if steps is None:
        steps = DEFAULT_PIPELINE
    for name in steps:
        if name not in STEPS:
            raise ValueError(f"Unknown preprocessing step '{name}' — expected one of {list(STEPS)}")
        audio = STEPS[name](audio, sr)
    return audio
