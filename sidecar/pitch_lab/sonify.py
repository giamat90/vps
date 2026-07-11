"""
Render a pitch-detection algorithm's F0 curve as an audible sine tone, mixed
with the original track (original in the left channel, pitch tone in the
right) so octave errors, harmonic jumps, and unvoiced glitches can be caught
by ear instead of only by eye. Produces one file per algorithm.

Usage:
    python sonify.py tracks/some_song_vocals.wav              # all algorithms
    python sonify.py tracks/some_song_vocals.wav --algo srh   # SRH only
"""
import argparse
from pathlib import Path
import numpy as np
import librosa
import soundfile as sf

from algorithms import srh_production, pyin_production, first_peak_production, hps_production, crepe_production, praat_production

LAB_DIR = Path(__file__).resolve().parent
RESULTS_DIR = LAB_DIR / "results"

ALGORITHMS = {
    "srh": srh_production,
    "pyin": pyin_production,
    "firstpeak": first_peak_production,
    "hps": hps_production,
    "crepe": crepe_production,
    "praat": praat_production,
}


def sonify_pitch(audio: np.ndarray, sr: int, pitch: dict, out_path: Path) -> Path:
    """Render an already-computed {times, f0, voiced} dict as a sine tone
    mixed with the original (original left channel, tone right channel).
    Detector-agnostic and independent of how the pitch dict was produced —
    works the same for a raw algorithm's output or postprocess.py's
    smoothed output, so the two can be A/B'd by ear."""
    times = np.array(pitch["times"])
    f0 = np.array(pitch["f0"])
    voiced = np.array(pitch["voiced"], dtype=float)

    sample_times = np.arange(len(audio)) / sr
    f0_per_sample = np.interp(sample_times, times, f0)
    voiced_per_sample = np.interp(sample_times, times, voiced) > 0.5

    phase = 2 * np.pi * np.cumsum(f0_per_sample) / sr
    tone = np.sin(phase) * 0.5
    tone[~voiced_per_sample] = 0.0

    stereo = np.stack([audio, tone], axis=1)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), stereo, sr)
    return out_path


def sonify(wav_path: Path, algo: str = "srh", out_dir: Path = RESULTS_DIR) -> Path:
    if algo not in ALGORITHMS:
        raise ValueError(f"Unknown algorithm '{algo}' — expected one of {list(ALGORITHMS)}")
    detect = ALGORITHMS[algo]

    audio, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    pitch = detect(audio, sr)

    out_path = out_dir / f"{wav_path.stem}-{algo}.wav"
    return sonify_pitch(audio, sr, pitch, out_path)


def sonify_all(wav_path: Path, out_dir: Path = RESULTS_DIR) -> list[Path]:
    return [sonify(wav_path, algo, out_dir) for algo in ALGORITHMS]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("wav_path", type=Path)
    parser.add_argument("--algo", choices=list(ALGORITHMS), default=None,
                         help="Sonify only this algorithm; default sonifies all")
    args = parser.parse_args()

    if args.algo:
        out = sonify(args.wav_path, args.algo)
        print(f"Saved {out} — original in left channel, pitch tone in right channel")
    else:
        for out in sonify_all(args.wav_path):
            print(f"Saved {out} — original in left channel, pitch tone in right channel")
