"""
Interactive (pan/zoom) waveform of a separated vocal track as a native
matplotlib window. Mirrors spectrogram_mpl.py: toolbar box-zoom / pan / home.

Usage:
    python waveform_mpl.py tracks/some_song_vocals.wav
"""
import sys
from pathlib import Path
import numpy as np
import librosa
import matplotlib
matplotlib.use("TkAgg")  # native window backend — NOT Agg, which is save-only/headless
import matplotlib.pyplot as plt

MAX_POINTS = 200_000  # min/max envelope keeps the plot responsive on full-length songs


def _envelope(audio: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n_bins = min(MAX_POINTS, len(audio))
    block = max(1, len(audio) // n_bins)
    n_bins = len(audio) // block
    blocks = audio[: n_bins * block].reshape(n_bins, block)
    times = (np.arange(n_bins) * block + block / 2) / sr
    return times, blocks.min(axis=1), blocks.max(axis=1)


def show_waveform(wav_path: Path) -> None:
    audio, sr = librosa.load(str(wav_path), sr=None, mono=True)
    times, lo, hi = _envelope(audio, sr)

    fig, ax = plt.subplots(figsize=(14, 5))
    ax.fill_between(times, lo, hi, color="#4a90d9", linewidth=0)
    ax.axhline(0, color="#888888", linewidth=0.5)
    ax.set_xlim(0, len(audio) / sr)
    ax.set_ylim(-1.05 * max(np.abs(audio).max(), 1e-6), 1.05 * max(np.abs(audio).max(), 1e-6))
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Amplitude")
    ax.set_title(f"{wav_path.name} — waveform ({sr} Hz, {len(audio) / sr:.1f}s)")
    fig.tight_layout()
    plt.show()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python waveform_mpl.py <path-to-audio>", file=sys.stderr)
        sys.exit(1)
    show_waveform(Path(sys.argv[1]))
