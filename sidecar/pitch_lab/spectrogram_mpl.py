"""
Interactive (pan/zoom) spectrogram as a native matplotlib window — run
directly as a script, no HTML file or extra dependency (Plotly) required.
matplotlib's own toolbar (magnifying-glass box-zoom, pan hand, reset-view
home button) is enough for zooming into a note or transient.

For a shareable/standalone file instead of a window, use
spectrogram_interactive.py (writes a self-contained HTML you can open later
without re-running Python).

Usage:
    python spectrogram_mpl.py tracks/some_song_vocals.wav
"""
import sys
from pathlib import Path
import numpy as np
import librosa
import librosa.display
import matplotlib
matplotlib.use("TkAgg")  # native window backend — NOT Agg, which is save-only/headless
import matplotlib.pyplot as plt


def show_spectrogram(wav_path: Path) -> None:
    audio, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    D = librosa.amplitude_to_db(np.abs(librosa.stft(audio, n_fft=2048, hop_length=512)), ref=np.max)

    fig, ax = plt.subplots(figsize=(14, 7))
    img = librosa.display.specshow(D, sr=sr, x_axis="time", y_axis="log", ax=ax)
    ax.set_title(f"{wav_path.name} — spectrogram (toolbar: box-zoom / pan / reset)")
    fig.colorbar(img, ax=ax, format="%+2.0f dB")
    fig.tight_layout()
    plt.show()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python spectrogram_mpl.py <path-to-wav>", file=sys.stderr)
        sys.exit(1)
    show_spectrogram(Path(sys.argv[1]))
