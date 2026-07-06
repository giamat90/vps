"""
Batch-run visualize/compare/sonify over every wav in tracks/, and write a
summary report ranking tracks by SRH/pYIN disagreement so you can triage
which ones need closest inspection first.

Usage:
    python batch_report.py
"""
import sys
from pathlib import Path
import numpy as np
import librosa

from algorithms import srh_production, pyin_production
from visualize import plot_all
from compare import compare_track, DISAGREEMENT_CENTS
from sonify import sonify_all

LAB_DIR = Path(__file__).resolve().parent
TRACKS_DIR = LAB_DIR / "tracks"
RESULTS_DIR = LAB_DIR / "results"


def disagreement_pct(wav_path: Path) -> float:
    audio, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    srh = srh_production(audio, sr)
    pyin = pyin_production(audio, sr)

    times = np.array(srh["times"])
    f0_srh = np.array(srh["f0"])
    voiced_srh = np.array(srh["voiced"], dtype=bool)
    f0_pyin = np.interp(times, pyin["times"], pyin["f0"])
    voiced_pyin = np.interp(times, pyin["times"], np.array(pyin["voiced"], dtype=float)) > 0.5

    both_voiced = voiced_srh & voiced_pyin & (f0_srh > 0) & (f0_pyin > 0)
    if not both_voiced.any():
        return 0.0
    cents_diff = 1200 * np.log2(f0_srh[both_voiced] / f0_pyin[both_voiced])
    flagged = np.abs(cents_diff) > DISAGREEMENT_CENTS
    return 100 * flagged.sum() / both_voiced.sum()


def main():
    wavs = sorted(TRACKS_DIR.glob("*.wav")) + sorted(TRACKS_DIR.glob("*.mp3"))
    if not wavs:
        print(f"No .wav/.mp3 files in {TRACKS_DIR} — drop split vocals.wav files there first.", file=sys.stderr)
        sys.exit(1)

    rows = []
    for wav_path in wavs:
        print(f"Processing {wav_path.name}...")
        plot_all(wav_path)
        compare_track(wav_path)
        sonify_all(wav_path)
        pct = disagreement_pct(wav_path)
        rows.append((wav_path.name, pct))

    rows.sort(key=lambda r: -r[1])

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    report_path = RESULTS_DIR / "index.md"
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("# Pitch detection batch report\n\n")
        f.write(f"SRH vs pYIN disagreement (>{DISAGREEMENT_CENTS} cents), worst first. ")
        f.write("High disagreement doesn't itself prove SRH is wrong — check the per-algorithm spectrogram ")
        f.write("overlays (`<name>-spectrum-<algo>.png`) and listen to the sonified pitch tracks ")
        f.write("(`<name>-<algo>.wav`, original in left channel / detected pitch tone in right) before concluding.\n\n")
        f.write("| Track | Disagreement % |\n|---|---|\n")
        for name, pct in rows:
            f.write(f"| {name} | {pct:.1f}% |\n")

    print(f"\nWrote {report_path}")


if __name__ == "__main__":
    main()
