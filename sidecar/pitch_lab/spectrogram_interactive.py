"""
Interactive (pan/zoom) spectrogram, written to a self-contained HTML file
instead of a static PNG — the matplotlib plots from visualize.py are fixed
images, this lets you zoom into a specific note/transient in the browser.

Frequency axis is cropped to <=4000 Hz (covers the vocal range plus several
harmonics) to keep the payload a reasonable size; the STFT itself still runs
at full resolution, only the plotted slice is cropped.

Usage:
    python spectrogram_interactive.py tracks/some_song_vocals.wav
"""
import sys
from pathlib import Path
import numpy as np
import librosa
import plotly.graph_objects as go

LAB_DIR = Path(__file__).resolve().parent
RESULTS_DIR = LAB_DIR / "results"

MAX_FREQ_HZ = 4000


def plot_interactive_spectrogram(wav_path: Path, out_dir: Path = RESULTS_DIR) -> Path:
    audio, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    D = librosa.amplitude_to_db(np.abs(librosa.stft(audio, n_fft=2048, hop_length=512)), ref=np.max)
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    times = librosa.frames_to_time(np.arange(D.shape[1]), sr=sr, hop_length=512)

    freq_mask = freqs <= MAX_FREQ_HZ
    D = D[freq_mask, :]
    freqs = freqs[freq_mask]

    fig = go.Figure(data=go.Heatmap(
        z=D,
        x=times,
        y=freqs,
        colorscale="Inferno",
        zmin=-80,
        zmax=0,
        colorbar=dict(title="dB"),
    ))
    fig.update_yaxes(type="log", title="Hz")
    fig.update_xaxes(title="time (s)")
    fig.update_layout(
        title=f"{wav_path.name} — spectrogram (scroll/drag to zoom, double-click to reset)",
        height=750,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{wav_path.stem}-spectrogram.html"
    fig.write_html(str(out_path), include_plotlyjs=True)
    return out_path


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python spectrogram_interactive.py <path-to-wav>", file=sys.stderr)
        sys.exit(1)
    out = plot_interactive_spectrogram(Path(sys.argv[1]))
    print(f"Saved {out} — open in a browser, scroll/drag to zoom")
