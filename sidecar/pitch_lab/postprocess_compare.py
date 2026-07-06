"""
A/B: run a pitch-detection algorithm on a track, then compare its raw output
against the output after postprocess.py's implausible-jump rejection +
interpolation. Detector-agnostic — works with srh, pyin, or firstpeak.

Usage:
    python postprocess_compare.py tracks/some_song_vocals.wav
    python postprocess_compare.py tracks/some_song_vocals.wav --algo pyin
"""
import argparse
from pathlib import Path
import numpy as np
import librosa
import librosa.display
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from algorithms import srh_production, pyin_production, first_peak_production
from postprocess import smooth_pitch
from sonify import sonify_pitch

LAB_DIR = Path(__file__).resolve().parent
RESULTS_DIR = LAB_DIR / "results"

ALGORITHMS = {
    "srh": ("SRH", srh_production),
    "pyin": ("pYIN", pyin_production),
    "firstpeak": ("First-Peak", first_peak_production),
}


def compare_postprocessing(
    wav_path: Path, algo: str = "srh",
    window_frames: int = 7, n_sigmas: float = 3.0,
    min_deviation_cents: float = 150.0, max_gap_frames: int = 8,
    out_dir: Path = RESULTS_DIR,
) -> Path:
    if algo not in ALGORITHMS:
        raise ValueError(f"Unknown algorithm '{algo}' — expected one of {list(ALGORITHMS)}")
    label, detect = ALGORITHMS[algo]

    audio, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    raw_pitch = detect(audio, sr)
    smoothed = smooth_pitch(
        raw_pitch, window_frames=window_frames, n_sigmas=n_sigmas,
        min_deviation_cents=min_deviation_cents, max_gap_frames=max_gap_frames,
    )

    D = librosa.amplitude_to_db(np.abs(librosa.stft(audio)), ref=np.max)
    f0_raw = np.where(np.array(raw_pitch["voiced"], dtype=bool), raw_pitch["f0"], np.nan)
    f0_smooth = np.where(np.array(smoothed["voiced"], dtype=bool), smoothed["f0"], np.nan)

    fig, ax = plt.subplots(figsize=(14, 7))
    librosa.display.specshow(D, sr=sr, x_axis="time", y_axis="log", ax=ax)
    ax.plot(raw_pitch["times"], f0_raw, color="magenta", linewidth=1, alpha=0.7, label=f"{label} — raw")
    ax.plot(smoothed["times"], f0_smooth, color="cyan", linewidth=1.2, label=f"{label} — smoothed")
    ax.set_ylim(50, 1500)
    ax.set_title(
        f"{wav_path.name} — {label}: {smoothed['n_flagged']} implausible jumps flagged, "
        f"{smoothed['n_bridged']} frames bridged"
    )
    ax.legend(loc="upper right")

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{wav_path.stem}-postprocess-{algo}.png"
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)

    raw_wav_path = out_dir / f"{wav_path.stem}-{algo}-raw.wav"
    smoothed_wav_path = out_dir / f"{wav_path.stem}-{algo}-smoothed.wav"
    sonify_pitch(audio, sr, raw_pitch, raw_wav_path)
    sonify_pitch(audio, sr, smoothed, smoothed_wav_path)

    print(f"{wav_path.name} [{label}]: {smoothed['n_flagged']} frames flagged as implausible jumps, "
          f"{smoothed['n_bridged']} frames bridged by interpolation")
    print(f"Sonified for A/B listening: {raw_wav_path.name} vs {smoothed_wav_path.name}")
    return out_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("wav_path", type=Path)
    parser.add_argument("--algo", choices=list(ALGORITHMS), default="srh")
    parser.add_argument("--window-frames", type=int, default=7)
    parser.add_argument("--n-sigmas", type=float, default=3.0)
    parser.add_argument("--min-deviation-cents", type=float, default=150.0)
    parser.add_argument("--max-gap-frames", type=int, default=8)
    args = parser.parse_args()

    out = compare_postprocessing(
        args.wav_path, args.algo, args.window_frames, args.n_sigmas,
        args.min_deviation_cents, args.max_gap_frames,
    )
    print(f"Saved {out}")
