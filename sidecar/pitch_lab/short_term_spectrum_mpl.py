"""
Short-Term Spectrum of a separated vocal track at one moment in time — the
matplotlib twin of the app's ShortTermSpectrumPanel
(src/components/analysis/ShortTermSpectrumPanel.tsx).

Same recipe as the panel: one 8192-sample Blackman-windowed FFT in dBFS, a
log-Hz x axis (30 Hz .. 20 kHz) drawn as the max bin per pixel column, the
thermal colormap on a -100..0 dB span, a wide moving-average envelope on
top, and LPC formant markers (F1/F2/F3).

Overlays the F0 each selected pitch algorithm detected at that moment (solid
line) and its harmonics (dotted), so you can see whether a detector locked
onto the fundamental or an upper harmonic. Algorithms run once over the whole
track at startup (CREPE and pYIN are slow).

Opens an interactive window with a time slider (left/right keys: +-0.05 s,
up/down: +-1 s). Pass --save to write a PNG into results/ instead.

Usage:
    python short_term_spectrum_mpl.py tracks/some_song_vocals.wav
    python short_term_spectrum_mpl.py tracks/some_song_vocals.wav --time 42.5
    python short_term_spectrum_mpl.py tracks/some_song_vocals.wav --time 42.5 --save
    python short_term_spectrum_mpl.py tracks/some_song_vocals.wav --algo srh praat
    python short_term_spectrum_mpl.py tracks/some_song_vocals.wav --algo all --harmonics 8
    python short_term_spectrum_mpl.py tracks/some_song_vocals.wav --algo none   # spectrum only
"""
import argparse
import time as clock
from pathlib import Path
import numpy as np
import librosa
from scipy.signal import lfilter
import matplotlib
matplotlib.use("TkAgg")  # native window backend — NOT Agg, which is save-only/headless
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from matplotlib.colors import ListedColormap
from matplotlib.patches import Polygon
from matplotlib.widgets import Slider

from algorithms import (
    srh_production, pyin_production, first_peak_production,
    hps_production, crepe_production, praat_production,
)

PITCH_SR = 22050  # what visualize.py feeds the detectors

LAB_DIR = Path(__file__).resolve().parent
RESULTS_DIR = LAB_DIR / "results"

FFT_SIZE = 8192
F_MIN, F_MAX = 30.0, 20000.0
MIN_DB, MAX_DB = -100.0, 0.0
N_COLUMNS = 1000
BG = "#0f0f1e"
ALGORITHMS = {
    "srh": ("SRH", srh_production, "#ff8c1e"),
    "pyin": ("pYIN", pyin_production, "#b388ff"),
    "firstpeak": ("First-Peak", first_peak_production, "#bdbdbd"),
    "hps": ("HPS", hps_production, "#7cff6b"),
    "crepe": ("CREPE", crepe_production, "#ff5252"),
    "praat": ("Praat", praat_production, "#6ec1ff"),
}
FORMANT_COLORS = ["#ffcf5c", "#5cffe0", "#ff5ca8"]
WINDOW = np.blackman(FFT_SIZE)

# Formant estimator constants — same values as src/lib/formants.ts
PRE_EMPHASIS = 0.97
DECIMATED_SR = 12000
MIN_FORMANT_HZ, MAX_FORMANT_HZ, MAX_BANDWIDTH_HZ = 90, 4000, 400


def _thermal_colormap() -> ListedColormap:
    # Control points copied from buildColormap() in src/lib/spectroUtils.ts
    stops = np.array([
        [0, 0, 0, 16], [51, 10, 10, 110], [102, 0, 112, 255], [140, 0, 229, 255],
        [179, 170, 255, 0], [209, 255, 170, 0], [235, 255, 34, 0], [255, 255, 255, 255],
    ], dtype=float)
    idx = np.arange(256)
    rgb = np.stack([np.interp(idx, stops[:, 0], stops[:, c]) for c in (1, 2, 3)], axis=1)
    return ListedColormap(rgb / 255.0)


THERMAL = _thermal_colormap()


def frame_at(audio: np.ndarray, sr: int, t: float) -> np.ndarray:
    start = int(round(t * sr)) - FFT_SIZE // 2
    frame = np.zeros(FFT_SIZE, dtype=np.float32)
    lo, hi = max(0, start), min(len(audio), start + FFT_SIZE)
    if hi > lo:
        frame[lo - start:hi - start] = audio[lo:hi]
    return frame


def spectrum_dbfs(frame: np.ndarray) -> np.ndarray:
    # Divide by the window's coherent gain so a full-scale tone reads 0 dBFS,
    # the same scale the sidecar's stored spectra and the panel's
    # WEBAUDIO_TO_DBFS correction land on.
    mag = np.abs(np.fft.rfft(frame * WINDOW)) / (WINDOW.sum() / 2.0)
    return 20.0 * np.log10(mag + 1e-12)


class ColumnMapper:
    """Max-bin-per-pixel-column reduction on the log-Hz axis (buildSpectrumPoints)."""

    def __init__(self, sr: int):
        self.f_max = min(F_MAX, sr / 2.0)
        self.log_min, self.log_max = np.log(F_MIN), np.log(self.f_max)
        bin_hz = sr / FFT_SIZE
        n_bins = FFT_SIZE // 2 + 1
        px = np.arange(N_COLUMNS)
        to_freq = lambda x: np.exp(self.log_min + (x / N_COLUMNS) * (self.log_max - self.log_min))
        f_lo = to_freq(np.maximum(0, px - 0.5))
        f_hi = to_freq(np.minimum(N_COLUMNS, px + 0.5))
        self.bin_lo = np.clip(np.floor(f_lo / bin_hz).astype(int), 0, n_bins - 1)
        self.bin_hi = np.clip(np.ceil(f_hi / bin_hz).astype(int), 0, n_bins - 1)
        self.log_freqs = self.log_min + (px / N_COLUMNS) * (self.log_max - self.log_min)

    def reduce(self, db: np.ndarray) -> np.ndarray:
        return np.array([db[lo:hi + 1].max() for lo, hi in zip(self.bin_lo, self.bin_hi)])


def smooth_envelope(normalized: np.ndarray) -> np.ndarray:
    # Moving average whose half-window widens 15 -> 40 columns with frequency
    # (smoothSpectrumEnvelope in spectroUtils.ts)
    n = len(normalized)
    i = np.arange(n)
    w = np.floor(15 + (i / n) * 25 + 0.5).astype(int)
    start = np.maximum(0, i - w)
    end = np.minimum(n - 1, i + w)
    cs = np.concatenate([[0.0], np.cumsum(normalized)])
    return (cs[end + 1] - cs[start]) / (end - start + 1)


def estimate_formants(frame: np.ndarray, sr: int) -> list[float]:
    if np.abs(frame).max() < 1e-4:
        return []
    y = librosa.resample(frame, orig_sr=sr, target_sr=DECIMATED_SR) if sr > DECIMATED_SR else frame
    sr_d = min(sr, DECIMATED_SR)
    y = lfilter([1.0, -PRE_EMPHASIS], [1.0], y) * np.hamming(len(y))
    a = librosa.lpc(y, order=round(sr_d / 1000) + 2)
    found = []
    for root in np.roots(a):
        if root.imag <= 0 or np.abs(root) >= 1:
            continue
        freq = np.arctan2(root.imag, root.real) * sr_d / (2 * np.pi)
        bandwidth = -(sr_d / np.pi) * np.log(np.abs(root))
        if MIN_FORMANT_HZ <= freq <= MAX_FORMANT_HZ and 0 <= bandwidth <= MAX_BANDWIDTH_HZ:
            found.append(float(freq))
    return sorted(found)[:3]


def detect_tracks(audio: np.ndarray, sr: int, algos: list[str]) -> list[dict]:
    pitch_audio = librosa.resample(audio, orig_sr=sr, target_sr=PITCH_SR) if sr != PITCH_SR else audio
    tracks = []
    for key in algos:
        label, detect, color = ALGORITHMS[key]
        started = clock.time()
        print(f"Running {label}...", flush=True)
        try:
            pitch = detect(pitch_audio, PITCH_SR)
        except ModuleNotFoundError as e:
            print(f"  WARNING: skipping {label} — missing module '{e.name}' "
                  f"(run with the sidecar venv: ..\\.venv\\Scripts\\python.exe)", flush=True)
            continue
        print(f"  {label} done in {clock.time() - started:.1f}s", flush=True)
        tracks.append({
            "label": label, "color": color,
            "times": np.asarray(pitch["times"]), "f0": np.asarray(pitch["f0"]),
            "voiced": np.asarray(pitch["voiced"], dtype=bool),
        })
    return tracks


def f0_at(track: dict, t: float) -> float | None:
    times = track["times"]
    if len(times) == 0:
        return None
    i = int(np.clip(np.searchsorted(times, t), 1, len(times) - 1)) if len(times) > 1 else 0
    if len(times) > 1 and abs(times[i - 1] - t) < abs(times[i] - t):
        i -= 1
    f0 = float(track["f0"][i])
    return f0 if track["voiced"][i] and f0 > 0 else None


def loudest_time(audio: np.ndarray, sr: int) -> float:
    rms = librosa.feature.rms(y=audio, frame_length=FFT_SIZE, hop_length=FFT_SIZE // 4)[0]
    return float(librosa.frames_to_time(int(np.argmax(rms)), sr=sr, hop_length=FFT_SIZE // 4))


class SpectrumPlot:
    def __init__(self, audio: np.ndarray, sr: int, name: str, t0: float,
                 pitch_tracks: list[dict], n_harmonics: int):
        self.audio, self.sr, self.name = audio, sr, name
        self.pitch_tracks, self.n_harmonics = pitch_tracks, n_harmonics
        self.duration = len(audio) / sr
        self.mapper = ColumnMapper(sr)
        self.dynamic: list = []

        self.fig = plt.figure(figsize=(13, 6), facecolor=BG)
        self.ax = self.fig.add_axes((0.07, 0.17, 0.90, 0.72), facecolor=BG)
        ax, m = self.ax, self.mapper
        ax.set_xlim(m.log_min, m.log_max)
        ax.set_ylim(MIN_DB, MAX_DB)
        ax.set_yticks(np.arange(MIN_DB, MAX_DB + 1, 10))
        decades = [f for f in (100, 1000, 10000) if f <= m.f_max]
        ax.set_xticks([np.log(f) for f in decades], [f"{f // 1000}k" if f >= 1000 else str(f) for f in decades])
        ax.grid(color="white", alpha=0.08, linewidth=1)
        ax.tick_params(colors="#c8c8d4", labelsize=9)
        for side in ax.spines.values():
            side.set_color((1, 1, 1, 0.25))
        ax.set_xlabel("Hz", color="#c8c8d4")
        ax.set_ylabel("dBFS", color="#c8c8d4")

        ramp = np.linspace(0, 1, 256)
        gradient = THERMAL(ramp)
        gradient[:, 3] = ramp * 0.35
        self.fill = ax.imshow(
            gradient[:, None, :], extent=(m.log_min, m.log_max, MIN_DB, MAX_DB),
            origin="lower", aspect="auto", interpolation="bilinear", zorder=1,
        )
        # The x axis is ln(Hz) with custom tick labels, so matplotlib's default readout shows an
        # empty x; the gradient image would also print its RGBA under the cursor.
        ax.format_coord = lambda x, y: f"{np.exp(x):.1f} Hz, {y:.1f} dBFS"
        self.fill.format_cursor_data = lambda data: ""
        self.lines = LineCollection([], linewidths=1.5, zorder=2)
        ax.add_collection(self.lines)
        (self.envelope,) = ax.plot([], [], color="white", alpha=0.85, linewidth=2, zorder=3)
        self.title = ax.set_title("", color="white", fontsize=11)

        slider_ax = self.fig.add_axes((0.07, 0.05, 0.85, 0.04), facecolor="#1c1c30")
        self.slider = Slider(slider_ax, "time (s)", 0.0, self.duration, valinit=t0, valstep=0.01, color="#4a90d9")
        self.slider.label.set_color("#c8c8d4")
        self.slider.valtext.set_color("#c8c8d4")
        self.slider.on_changed(self.update)
        self.fig.canvas.mpl_connect("key_press_event", self.on_key)
        self.update(t0)

    def on_key(self, event) -> None:
        step = {"left": -0.05, "right": 0.05, "down": -1.0, "up": 1.0}.get(event.key)
        if step is not None:
            self.slider.set_val(float(np.clip(self.slider.val + step, 0.0, self.duration)))

    def update(self, t: float) -> None:
        for artist in self.dynamic:
            artist.remove()
        self.dynamic = []

        frame = frame_at(self.audio, self.sr, t)
        db = self.mapper.reduce(spectrum_dbfs(frame))
        normalized = np.clip((db - MIN_DB) / (MAX_DB - MIN_DB), 0.0, 1.0)
        xs = self.mapper.log_freqs
        ys = MIN_DB + normalized * (MAX_DB - MIN_DB)

        points = np.column_stack([xs, ys])
        self.lines.set_segments(np.stack([points[:-1], points[1:]], axis=1))
        self.lines.set_color(THERMAL(np.floor(normalized[1:] * 255).astype(int) / 255.0))

        clip = Polygon([(xs[0], MIN_DB), *points, (xs[-1], MIN_DB)], closed=True,
                       transform=self.ax.transData, facecolor="none", edgecolor="none")
        self.fill.set_clip_path(clip)

        smooth = smooth_envelope(normalized)
        self.envelope.set_data(xs, MIN_DB + smooth * (MAX_DB - MIN_DB))

        formants = estimate_formants(frame, self.sr)
        for i, f in enumerate(formants):
            x = np.log(f)
            line = self.ax.axvline(x, color=FORMANT_COLORS[i], linewidth=1.5, linestyle=(0, (4, 3)), zorder=4)
            label = self.ax.text(x, 0.02 + 0.05 * i, f"F{i + 1} {round(f)}Hz", color=FORMANT_COLORS[i],
                                 ha="center", va="bottom", fontsize=9, family="monospace",
                                 transform=self.ax.get_xaxis_transform(), zorder=5)
            self.dynamic += [line, label]

        for row, track in enumerate(self.pitch_tracks):
            f0 = f0_at(track, t)
            text = f"{track['label']}  " + (f"F0 {f0:.1f} Hz" if f0 else "unvoiced")
            self.dynamic.append(self.ax.text(
                0.01, 0.97 - 0.045 * row, text, color=track["color"], ha="left", va="top",
                fontsize=9, family="monospace", transform=self.ax.transAxes, zorder=6))
            if not f0:
                continue
            for k in range(1, self.n_harmonics + 1):
                fk = f0 * k
                if fk > self.mapper.f_max:
                    break
                if fk < F_MIN:
                    continue
                self.dynamic.append(self.ax.axvline(
                    np.log(fk), color=track["color"], zorder=4,
                    linewidth=1.8 if k == 1 else 1.0, alpha=0.95 if k == 1 else 0.6,
                    linestyle="-" if k == 1 else (0, (1, 2))))

        self.title.set_text(f"{self.name} — Short-Term Spectrum @ {t:.2f}s")
        self.fig.canvas.draw_idle()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", type=Path)
    parser.add_argument("--time", type=float, default=None,
                        help="Start position in seconds; default is the loudest moment of the track")
    parser.add_argument("--algo", nargs="+", default=["srh"], choices=[*ALGORITHMS, "all", "none"],
                        help="Pitch algorithm(s) to overlay (F0 + harmonics); 'all' runs all six, 'none' skips")
    parser.add_argument("--harmonics", type=int, default=10,
                        help="Number of harmonics drawn per F0, including the fundamental (default 10)")
    parser.add_argument("--save", action="store_true",
                        help="Write results/<name>-short-term-spectrum-<time>s.png instead of opening a window")
    args = parser.parse_args()

    audio, sr = librosa.load(str(args.audio_path), sr=None, mono=True)
    t0 = args.time if args.time is not None else loudest_time(audio, sr)
    t0 = float(np.clip(t0, 0.0, len(audio) / sr))

    algos = [] if "none" in args.algo else (list(ALGORITHMS) if "all" in args.algo else list(dict.fromkeys(args.algo)))
    pitch_tracks = detect_tracks(audio, sr, algos)

    if args.save:
        plt.switch_backend("Agg")
    else:
        # Default left/right bindings are view-history back/forward; we use them to step time.
        plt.rcParams["keymap.back"] = [k for k in plt.rcParams["keymap.back"] if k != "left"]
        plt.rcParams["keymap.forward"] = [k for k in plt.rcParams["keymap.forward"] if k != "right"]

    plot = SpectrumPlot(audio, sr, args.audio_path.name, t0, pitch_tracks, args.harmonics)
    if args.save:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        out = RESULTS_DIR / f"{args.audio_path.stem}-short-term-spectrum-{t0:.2f}s.png"
        plot.fig.savefig(out, dpi=130, facecolor=BG)
        print(f"Saved {out}")
    else:
        plt.show()


if __name__ == "__main__":
    main()
