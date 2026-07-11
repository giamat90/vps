"""
Plot a spectrogram with a pitch-detection algorithm's F0 curve overlaid.
Produces one plot per algorithm (not overlaid together) so SRH and pYIN can
each be inspected against the actual harmonic content without one curve
obscuring the other.

Usage:
    python visualize.py tracks/some_song_vocals.wav              # both algorithms
    python visualize.py tracks/some_song_vocals.wav --algo srh   # SRH only
    python visualize.py tracks/some_song_vocals.wav --algo pyin  # pYIN only
"""
import argparse
from pathlib import Path
import numpy as np
import librosa
import librosa.display
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from algorithms import srh_production, pyin_production, first_peak_production, hps_production, crepe_production, praat_production

LAB_DIR = Path(__file__).resolve().parent
RESULTS_DIR = LAB_DIR / "results"

ALGORITHMS = {
    "srh": ("SRH", srh_production),
    "pyin": ("pYIN", pyin_production),
    "firstpeak": ("First-Peak", first_peak_production),
    "hps": ("HPS", hps_production),
    "crepe": ("CREPE", crepe_production),
    "praat": ("Praat", praat_production),
}


def plot_spectrum(wav_path: Path, algo: str = "srh", out_dir: Path = RESULTS_DIR) -> Path:
    if algo not in ALGORITHMS:
        raise ValueError(f"Unknown algorithm '{algo}' — expected one of {list(ALGORITHMS)}")
    label, detect = ALGORITHMS[algo]

    audio, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    pitch = detect(audio, sr)

    times = np.array(pitch["times"])
    f0 = np.array(pitch["f0"])
    voiced = np.array(pitch["voiced"], dtype=bool)
    confidence = np.array(pitch["confidence"])

    D = librosa.amplitude_to_db(np.abs(librosa.stft(audio)), ref=np.max)

    fig, (ax1, ax2) = plt.subplots(
        2, 1, figsize=(14, 8), sharex=True, gridspec_kw={"height_ratios": [3, 1]}
    )

    librosa.display.specshow(D, sr=sr, x_axis="time", y_axis="log", ax=ax1)
    # NaN out unvoiced frames rather than dropping them, so matplotlib leaves a
    # real gap instead of drawing a straight line across silence/unvoiced runs.
    f0_display = np.where(voiced, f0, np.nan)
    ax1.plot(times, f0_display, color="cyan", linewidth=1.2, label=f"{label} F0 (voiced)")
    ax1.scatter(times[~voiced], np.full((~voiced).sum(), 55), color="red", s=2, alpha=0.4, label="unvoiced")
    ax1.set_ylim(50, 1500)
    ax1.set_title(f"{wav_path.name} — spectrogram + {label} F0")
    ax1.legend(loc="upper right")

    ax2.plot(times, confidence, color="orange", linewidth=1)
    ax2.set_ylabel(f"{label} confidence")
    ax2.set_xlabel("time (s)")

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{wav_path.stem}-spectrum-{algo}.png"
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)
    return out_path


def plot_all(wav_path: Path, out_dir: Path = RESULTS_DIR) -> list[Path]:
    return [plot_spectrum(wav_path, algo, out_dir) for algo in ALGORITHMS]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("wav_path", type=Path)
    parser.add_argument("--algo", choices=list(ALGORITHMS), default=None,
                         help="Plot only this algorithm; default plots both")
    args = parser.parse_args()

    if args.algo:
        out = plot_spectrum(args.wav_path, args.algo)
        print(f"Saved {out}")
    else:
        for out in plot_all(args.wav_path):
            print(f"Saved {out}")
