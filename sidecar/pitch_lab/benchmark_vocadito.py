"""
Score the pitch detectors against vocadito, a public set of 40 solo-vocal excerpts with
hand-corrected frame-level f0 (Bittner et al., ISMIR 2021, CC-BY 4.0, Zenodo 5557945).

Unlike the other lab tools this has ground truth, not another detector's opinion. The audio is
clean solo singing, not Demucs output, so it measures the detectors themselves, not how they cope
with separation bleed (use the consensus comparison in the README for that).

Usage:
    python benchmark_vocadito.py                    # all six algorithms, downloads the data first time
    python benchmark_vocadito.py srh pyin           # only these
    python benchmark_vocadito.py --tracks 6 29 34   # only these vocadito tracks

Writes results/vocadito-benchmark.md and .json. The data goes to datasets/vocadito/ (gitignored).
"""
import argparse
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import soundfile as sf

from algorithms import (
    srh_production, pyin_production, hps_production, crepe_production, praat_production,
    first_peak_production,
)

LAB_DIR = Path(__file__).resolve().parent
DATA_DIR = LAB_DIR / "datasets" / "vocadito"
RESULTS_DIR = LAB_DIR / "results"
ZIP_URL = "https://zenodo.org/api/records/5557945/files/vocadito.zip/content"

ALGORITHMS = {
    "srh": srh_production,
    "pyin": pyin_production,
    "firstpeak": first_peak_production,
    "hps": hps_production,
    "crepe": crepe_production,
    "praat": praat_production,
}

TOLERANCE_CENTS = 50.0  # the MIREX/mir_eval standard for raw pitch accuracy
STRICT_CENTS = 25.0


def ensure_dataset() -> None:
    if (DATA_DIR / "Audio").is_dir() and (DATA_DIR / "Annotations" / "F0").is_dir():
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    archive = DATA_DIR / "vocadito.zip"
    print(f"downloading vocadito (58 MB) to {archive}", flush=True)
    urllib.request.urlretrieve(ZIP_URL, archive)
    with zipfile.ZipFile(archive) as z:
        z.extractall(DATA_DIR)
    archive.unlink()


def cents(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return 1200.0 * np.log2(a / b)


def score_track(ref_t: np.ndarray, ref_f: np.ndarray, est_t: np.ndarray, est_f: np.ndarray) -> dict:
    """Nearest estimate frame for every reference frame (the reference hop is 5.8 ms, ours ~23 ms);
    est_f == 0 means unvoiced. Frames beyond the estimator's last frame count as unvoiced."""
    idx = np.clip(np.searchsorted(est_t, ref_t), 1, len(est_t) - 1)
    idx = np.where(ref_t - est_t[idx - 1] < est_t[idx] - ref_t, idx - 1, idx)
    est = est_f[idx].copy()
    est[np.abs(est_t[idx] - ref_t) > 0.05] = 0.0

    ref_voiced = ref_f > 0
    est_voiced = est > 0
    both = ref_voiced & est_voiced
    dev = cents(est[both], ref_f[both])
    folded = np.abs(dev - 1200.0 * np.round(dev / 1200.0))
    err = np.abs(dev)
    return {
        "n": int(len(ref_f)),
        "ref_voiced": int(ref_voiced.sum()),
        "ref_unvoiced": int((~ref_voiced).sum()),
        "est_voiced_on_ref_voiced": int(both.sum()),
        "est_voiced_on_ref_unvoiced": int((~ref_voiced & est_voiced).sum()),
        "pitch_ok": int((err <= TOLERANCE_CENTS).sum()),
        "pitch_ok_strict": int((err <= STRICT_CENTS).sum()),
        "chroma_ok": int((folded <= TOLERANCE_CENTS).sum()),
        "octave_errors": int(((err > TOLERANCE_CENTS) & (folded <= TOLERANCE_CENTS)).sum()),
        "overall_ok": int((err <= TOLERANCE_CENTS).sum() + (~ref_voiced & ~est_voiced).sum()),
        "median_dev_cents": float(np.median(dev)) if dev.size else 0.0,
        "mean_abs_dev_when_ok": float(err[err <= TOLERANCE_CENTS].mean()) if (err <= TOLERANCE_CENTS).any() else 0.0,
    }


def summarise(rows: list[dict]) -> dict:
    total = lambda k: sum(r[k] for r in rows)
    per_track = [r["pitch_ok"] / max(r["ref_voiced"], 1) for r in rows]
    return {
        "tracks": len(rows),
        "raw_pitch_accuracy_50c": total("pitch_ok") / total("ref_voiced"),
        "raw_pitch_accuracy_25c": total("pitch_ok_strict") / total("ref_voiced"),
        "raw_chroma_accuracy_50c": total("chroma_ok") / total("ref_voiced"),
        "octave_errors": total("octave_errors") / total("ref_voiced"),
        "voicing_recall": total("est_voiced_on_ref_voiced") / total("ref_voiced"),
        "voicing_false_alarm": total("est_voiced_on_ref_unvoiced") / total("ref_unvoiced"),
        "overall_accuracy": total("overall_ok") / total("n"),
        "mean_abs_dev_when_ok_cents": float(np.mean([r["mean_abs_dev_when_ok"] for r in rows])),
        "median_dev_cents": float(np.median([r["median_dev_cents"] for r in rows])),
        "worst_tracks": [[r["track"], round(p, 3)] for p, r in sorted(zip(per_track, rows), key=lambda x: x[0])[:5]],
    }


def markdown(summaries: dict, rows: dict) -> str:
    cols = [
        ("Pitch within 50 c", "raw_pitch_accuracy_50c", "{:.1%}"),
        ("Pitch within 25 c", "raw_pitch_accuracy_25c", "{:.1%}"),
        ("Chroma within 50 c", "raw_chroma_accuracy_50c", "{:.1%}"),
        ("Octave errors", "octave_errors", "{:.1%}"),
        ("Voiced recall", "voicing_recall", "{:.1%}"),
        ("False voiced", "voicing_false_alarm", "{:.1%}"),
        ("Overall", "overall_accuracy", "{:.1%}"),
        ("Mean error when right (c)", "mean_abs_dev_when_ok_cents", "{:.1f}"),
        ("Median bias (c)", "median_dev_cents", "{:+.1f}"),
    ]
    names = list(summaries)
    out = ["# vocadito benchmark", "", f"{next(iter(summaries.values()))['tracks']} tracks, pooled over all reference frames.", "",
           "| | " + " | ".join(names) + " |", "|---|" + "---|" * len(names)]
    for label, key, fmt in cols:
        out.append(f"| {label} | " + " | ".join(fmt.format(summaries[n][key]) for n in names) + " |")
    out += ["", "Worst tracks (vocadito id, pitch accuracy within 50 cents):", ""]
    for n in names:
        out.append(f"- {n}: " + ", ".join(f"{t} ({p:.0%})" for t, p in summaries[n]["worst_tracks"]))
    return "\n".join(out) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("algorithms", nargs="*", help=f"any of {', '.join(ALGORITHMS)}; default: all six")
    ap.add_argument("--tracks", type=int, nargs="*", help="vocadito track ids (default: all 40)")
    args = ap.parse_args()
    algos = args.algorithms or list(ALGORITHMS)
    unknown = [a for a in algos if a not in ALGORITHMS]
    if unknown:
        ap.error(f"unknown algorithm {unknown}; choose from {', '.join(ALGORITHMS)}")

    ensure_dataset()
    wavs = sorted((DATA_DIR / "Audio").glob("vocadito_*.wav"), key=lambda p: int(p.stem.split("_")[1]))
    if args.tracks:
        wavs = [w for w in wavs if int(w.stem.split("_")[1]) in args.tracks]

    rows: dict[str, list[dict]] = {a: [] for a in algos}
    for w in wavs:
        n = int(w.stem.split("_")[1])
        ref = np.loadtxt(DATA_DIR / "Annotations" / "F0" / f"vocadito_{n}_f0.csv", delimiter=",")
        audio, sr = sf.read(str(w), dtype="float32", always_2d=False)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        for a in algos:
            r = ALGORITHMS[a](audio, sr)
            row = score_track(ref[:, 0], ref[:, 1], np.asarray(r["times"], float), np.asarray(r["f0"], float))
            row["track"] = n
            rows[a].append(row)
        print(f"track {n:>2}: " + "  ".join(f"{a} {rows[a][-1]['pitch_ok'] / max(rows[a][-1]['ref_voiced'], 1):.0%}" for a in algos), flush=True)

    summaries = {a: summarise(rows[a]) for a in algos}
    RESULTS_DIR.mkdir(exist_ok=True)
    (RESULTS_DIR / "vocadito-benchmark.json").write_text(json.dumps({"summary": summaries, "rows": rows}, indent=1))
    report = markdown(summaries, rows)
    (RESULTS_DIR / "vocadito-benchmark.md").write_text(report)
    print("\n" + report)


if __name__ == "__main__":
    sys.exit(main())
