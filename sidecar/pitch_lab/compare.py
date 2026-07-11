"""
Run SRH and pYIN on the same track and flag frames where they disagree, as
an automated first pass to triage which regions need closest listening.
Disagreement doesn't prove either algorithm is wrong (both can be wrong
together, or agree on the same octave error) — treat this as a pointer to
where to look with visualize.py / sonify.py, not a verdict.

First-Peak, HPS, CREPE, and Praat are overlaid too for reference (First-Peak
is the naive no-harmonic-logic baseline; HPS/CREPE/Praat are the other three
shipped, user-selectable algorithms), but the disagreement metric itself stays
SRH vs pYIN — those are the two detectors this metric was built to compare.

Usage:
    python compare.py tracks/some_song_vocals.wav
"""
import sys
from pathlib import Path
import numpy as np
import librosa
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from algorithms import srh_production, pyin_production, first_peak_production, hps_production, crepe_production, praat_production

LAB_DIR = Path(__file__).resolve().parent
RESULTS_DIR = LAB_DIR / "results"

DISAGREEMENT_CENTS = 50  # flag frames where SRH/pYIN differ by more than a quartertone


def compare_track(wav_path: Path, out_dir: Path = RESULTS_DIR) -> Path:
    audio, sr = librosa.load(str(wav_path), sr=22050, mono=True)

    srh = srh_production(audio, sr)
    pyin = pyin_production(audio, sr)
    firstpeak = first_peak_production(audio, sr)
    hps = hps_production(audio, sr)
    crepe = crepe_production(audio, sr)
    praat = praat_production(audio, sr)

    times = np.array(srh["times"])
    f0_srh = np.array(srh["f0"])
    voiced_srh = np.array(srh["voiced"], dtype=bool)

    f0_pyin = np.interp(times, pyin["times"], pyin["f0"])
    voiced_pyin = np.interp(times, pyin["times"], np.array(pyin["voiced"], dtype=float)) > 0.5

    f0_firstpeak = np.interp(times, firstpeak["times"], firstpeak["f0"])
    voiced_firstpeak = np.interp(times, firstpeak["times"], np.array(firstpeak["voiced"], dtype=float)) > 0.5

    f0_hps = np.interp(times, hps["times"], hps["f0"])
    voiced_hps = np.interp(times, hps["times"], np.array(hps["voiced"], dtype=float)) > 0.5

    f0_crepe = np.interp(times, crepe["times"], crepe["f0"])
    voiced_crepe = np.interp(times, crepe["times"], np.array(crepe["voiced"], dtype=float)) > 0.5

    f0_praat = np.interp(times, praat["times"], praat["f0"])
    voiced_praat = np.interp(times, praat["times"], np.array(praat["voiced"], dtype=float)) > 0.5

    both_voiced = voiced_srh & voiced_pyin & (f0_srh > 0) & (f0_pyin > 0)
    cents_diff = np.zeros_like(f0_srh)
    cents_diff[both_voiced] = 1200 * np.log2(f0_srh[both_voiced] / f0_pyin[both_voiced])

    flagged = both_voiced & (np.abs(cents_diff) > DISAGREEMENT_CENTS)
    n_flagged = int(flagged.sum())
    n_both_voiced = int(both_voiced.sum())
    pct = 100 * n_flagged / n_both_voiced if n_both_voiced else 0.0

    fig, (ax1, ax2) = plt.subplots(
        2, 1, figsize=(14, 7), sharex=True, gridspec_kw={"height_ratios": [2, 1]}
    )

    # NaN out unvoiced frames rather than dropping them, so matplotlib leaves a
    # real gap instead of drawing a straight line across silence/unvoiced runs.
    ax1.plot(times, np.where(voiced_firstpeak, f0_firstpeak, np.nan), label="First-Peak",
              color="yellow", linewidth=0.8, alpha=0.5, zorder=1)
    ax1.plot(times, np.where(voiced_hps, f0_hps, np.nan), label="HPS",
              color="lime", linewidth=0.8, alpha=0.5, zorder=1)
    ax1.plot(times, np.where(voiced_crepe, f0_crepe, np.nan), label="CREPE",
              color="orange", linewidth=0.8, alpha=0.6, zorder=2)
    ax1.plot(times, np.where(voiced_praat, f0_praat, np.nan), label="Praat",
              color="black", linewidth=0.9, alpha=0.7, zorder=2)
    ax1.plot(times, np.where(voiced_srh, f0_srh, np.nan), label="SRH", color="cyan", linewidth=1.2, zorder=3)
    ax1.plot(times, np.where(voiced_pyin, f0_pyin, np.nan), label="pYIN", color="magenta", linewidth=1, alpha=0.7, zorder=2)
    ax1.scatter(times[flagged], f0_srh[flagged], color="red", s=10, zorder=5,
                label=f">{DISAGREEMENT_CENTS}c disagreement (SRH vs pYIN)")
    ax1.set_ylim(50, 1500)
    ax1.set_ylabel("Hz")
    ax1.set_title(f"{wav_path.name} — SRH vs pYIN ({pct:.1f}% of jointly-voiced frames disagree >{DISAGREEMENT_CENTS}c)")
    ax1.legend(loc="upper right")

    ax2.plot(times, cents_diff, color="gray", linewidth=0.8)
    ax2.axhline(DISAGREEMENT_CENTS, color="red", linestyle="--", linewidth=0.8)
    ax2.axhline(-DISAGREEMENT_CENTS, color="red", linestyle="--", linewidth=0.8)
    ax2.set_ylabel("SRH - pYIN (cents)")
    ax2.set_xlabel("time (s)")

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{wav_path.stem}_compare.png"
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)

    print(f"{wav_path.name}: {n_flagged}/{n_both_voiced} frames disagree >{DISAGREEMENT_CENTS}c ({pct:.1f}%)")
    return out_path


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python compare.py <path-to-wav>", file=sys.stderr)
        sys.exit(1)
    out = compare_track(Path(sys.argv[1]))
    print(f"Saved {out}")
