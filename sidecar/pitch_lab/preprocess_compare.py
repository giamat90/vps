"""
A/B test: run a pitch-detection algorithm on a track before vs after the
pitch_lab cleaning pipeline (preprocess.py), to see whether removing likely
Demucs bleed artifacts changes/improves what it detects. Writes the cleaned
audio to results/ too, so it can be run through visualize.py/sonify.py like
any other track for a full look.

Usage:
    python preprocess_compare.py tracks/some_song_vocals.wav
    python preprocess_compare.py tracks/some_song_vocals.wav --algo pyin --steps highpass,hpss
"""
import argparse
from pathlib import Path
import numpy as np
import librosa
import librosa.display
import soundfile as sf
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from algorithms import srh_production, pyin_production, first_peak_production
from preprocess import apply_pipeline, DEFAULT_PIPELINE, STEPS

LAB_DIR = Path(__file__).resolve().parent
RESULTS_DIR = LAB_DIR / "results"

ALGORITHMS = {
    "srh": ("SRH", srh_production),
    "pyin": ("pYIN", pyin_production),
    "firstpeak": ("First-Peak", first_peak_production),
}


def _voiced_stats(pitch: dict):
    voiced = np.array(pitch["voiced"], dtype=bool)
    confidence = np.array(pitch["confidence"])
    pct_voiced = 100 * voiced.mean() if len(voiced) else 0.0
    mean_conf = float(confidence[voiced].mean()) if voiced.any() else 0.0
    return pct_voiced, mean_conf


def compare_preprocessing(wav_path: Path, algo: str = "srh", steps: list = None, out_dir: Path = RESULTS_DIR) -> Path:
    if algo not in ALGORITHMS:
        raise ValueError(f"Unknown algorithm '{algo}' — expected one of {list(ALGORITHMS)}")
    label, detect = ALGORITHMS[algo]
    steps = steps or DEFAULT_PIPELINE

    audio, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    cleaned = apply_pipeline(audio, sr, steps)

    raw_pitch = detect(audio, sr)
    clean_pitch = detect(cleaned, sr)

    raw_pct, raw_conf = _voiced_stats(raw_pitch)
    clean_pct, clean_conf = _voiced_stats(clean_pitch)

    out_dir.mkdir(parents=True, exist_ok=True)
    cleaned_wav_path = out_dir / f"{wav_path.stem}-cleaned.wav"
    sf.write(str(cleaned_wav_path), cleaned, sr)

    D = librosa.amplitude_to_db(np.abs(librosa.stft(audio)), ref=np.max)
    f0_raw = np.where(np.array(raw_pitch["voiced"], dtype=bool), raw_pitch["f0"], np.nan)
    f0_clean = np.where(np.array(clean_pitch["voiced"], dtype=bool), clean_pitch["f0"], np.nan)

    fig, ax = plt.subplots(figsize=(14, 7))
    librosa.display.specshow(D, sr=sr, x_axis="time", y_axis="log", ax=ax)
    ax.plot(raw_pitch["times"], f0_raw, color="magenta", linewidth=1, alpha=0.7, label=f"{label} — raw")
    ax.plot(clean_pitch["times"], f0_clean, color="cyan", linewidth=1.2, label=f"{label} — cleaned ({'+'.join(steps)})")
    ax.set_ylim(50, 1500)
    ax.set_title(
        f"{wav_path.name} — {label}: raw ({raw_pct:.0f}% voiced, conf {raw_conf:.2f}) "
        f"vs cleaned ({clean_pct:.0f}% voiced, conf {clean_conf:.2f})"
    )
    ax.legend(loc="upper right")

    out_path = out_dir / f"{wav_path.stem}-preprocess-{algo}.png"
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)

    print(f"{wav_path.name} [{label}]: raw {raw_pct:.1f}% voiced (conf {raw_conf:.2f}) "
          f"-> cleaned {clean_pct:.1f}% voiced (conf {clean_conf:.2f})")
    print(f"Cleaned audio: {cleaned_wav_path}")
    return out_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("wav_path", type=Path)
    parser.add_argument("--algo", choices=list(ALGORITHMS), default="srh")
    parser.add_argument("--steps", type=str, default=None,
                         help=f"Comma-separated steps from {list(STEPS)}; default: {','.join(DEFAULT_PIPELINE)}")
    args = parser.parse_args()

    steps = args.steps.split(",") if args.steps else None
    out = compare_preprocessing(args.wav_path, args.algo, steps)
    print(f"Saved {out}")
