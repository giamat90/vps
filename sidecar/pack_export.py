"""Build the practice pack a song carries to the phone (see wiki/practice-pack.md).

The format, its rules and the writer live in mps-core (`mps_core.pack`); this
module only gathers what VPS has on disk for one song:

    vocals.wav, instrumental.wav       -> AAC tracks (vocals mono, 64 kbps)
    pitched/{n}/vocals.wav + instr.    -> a transposed variant per cached n
    analysis.json  (pitchData)         -> reference_pitch.json on a 20 ms grid
    lyrics.json                        -> lyrics.json, as stored
    Song.loops / key / bpm / offset    -> the manifest

Nothing is computed that the phone could not do without the laptop's analysis;
the point of the pack is that the phone only plays and listens.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Callable, Optional

from mps_core import pack

VOCALS_KBPS = 64
INSTRUMENTAL_KBPS = 96
SEMITONE_LIMIT = 12


def _cached_variants(song_dir: Path) -> list[int]:
    found: list[int] = []
    base = song_dir / "pitched"
    if not base.is_dir():
        return found
    for entry in base.iterdir():
        try:
            n = int(entry.name)
        except ValueError:
            continue
        if n == 0 or abs(n) > SEMITONE_LIMIT:
            continue
        if (entry / "vocals.wav").is_file() and (entry / "instrumental.wav").is_file():
            found.append(n)
    return sorted(found)


def _reference_bytes(analysis_path: Path, duration_s: float) -> Optional[bytes]:
    if not analysis_path.is_file():
        return None
    with open(analysis_path, encoding="utf-8") as f:
        analysis = json.load(f)
    pd = analysis.get("pitchData") or {}
    times, f0 = pd.get("times"), pd.get("f0")
    if not times or not f0:
        return None
    ref = pack.decimate_reference(times, f0, pd.get("voiced"), duration_s=duration_s)
    return json.dumps(ref, separators=(",", ":")).encode("utf-8")


def build_practice_pack(
    song_dir: str,
    output_path: str,
    meta: dict,
    on_progress: Optional[Callable[[str, float], None]] = None,
    encode: Callable[..., Path] = pack.encode_aac,
) -> dict:
    """Write `output_path` (a .vppack) for the song in `song_dir`.

    `meta` carries what the shell knows: songId, title, artist, durationS, bpm,
    key, metronomeOffsetS, loops [{name,start,end}], createdAt, rev.
    """
    progress = on_progress or (lambda stage, value: None)
    root = Path(song_dir)
    vocals_src = root / "vocals.wav"
    instrumental_src = root / "instrumental.wav"
    for needed in (vocals_src, instrumental_src):
        if not needed.is_file():
            raise pack.PackError(f"{needed.name} is missing from the song folder")

    variants = _cached_variants(root)
    steps = 2 + 2 * len(variants) + 2
    done = 0

    def tick(stage: str) -> None:
        nonlocal done
        done += 1
        progress(stage, done / steps)

    work = Path(tempfile.mkdtemp(prefix="vps-pack-"))
    try:
        files: dict[str, object] = {}
        tracks = {"vocals": "vocals.m4a", "instrumental": "instrumental.m4a"}

        progress("encoding vocals", 0.0)
        files["vocals.m4a"] = encode(vocals_src, work / "vocals.m4a", bitrate_kbps=VOCALS_KBPS, mono=True)
        tick("encoding instrumental")
        files["instrumental.m4a"] = encode(instrumental_src, work / "instrumental.m4a", bitrate_kbps=INSTRUMENTAL_KBPS)
        tick("encoding transpositions")

        variant_entries = []
        for n in variants:
            vdir = root / "pitched" / str(n)
            rel_v, rel_i = f"pitched/{n}/vocals.m4a", f"pitched/{n}/instrumental.m4a"
            files[rel_v] = encode(vdir / "vocals.wav", work / "pv" / str(n) / "vocals.m4a", bitrate_kbps=VOCALS_KBPS, mono=True)
            tick("encoding transpositions")
            files[rel_i] = encode(vdir / "instrumental.wav", work / "pv" / str(n) / "instrumental.m4a", bitrate_kbps=INSTRUMENTAL_KBPS)
            tick("encoding transpositions")
            variant_entries.append({"semitones": n, "tracks": {"vocals": rel_v, "instrumental": rel_i}})

        reference_file = None
        ref = _reference_bytes(root / "analysis.json", float(meta["durationS"]))
        if ref is not None:
            reference_file = "reference_pitch.json"
            files[reference_file] = ref
        tick("writing the pack")

        lyrics_file = None
        lyrics_path = root / "lyrics.json"
        if lyrics_path.is_file():
            lyrics_file = "lyrics.json"
            files[lyrics_file] = lyrics_path.read_bytes()

        manifest = pack.build_manifest(
            app="vps",
            song_id=meta["songId"],
            title=meta["title"],
            artist=meta.get("artist"),
            duration_s=float(meta["durationS"]),
            created_at=meta["createdAt"],
            bpm=meta.get("bpm"),
            key=meta.get("key"),
            metronome_offset_s=meta.get("metronomeOffsetS"),
            tracks=tracks,
            reference_file=reference_file,
            lyrics_file=lyrics_file,
            loops=meta.get("loops") or [],
            variants=variant_entries,
            rev=int(meta.get("rev", 1)),
        )
        out = pack.write_pack(output_path, manifest, files)
        tick("done")
        return {
            "path": str(out),
            "sizeBytes": out.stat().st_size,
            "variants": variants,
            "hasReference": reference_file is not None,
            "hasLyrics": lyrics_file is not None,
            "loops": len(manifest["loops"]),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)
