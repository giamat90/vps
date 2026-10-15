"""The practice pack VPS sends to the phone: what it gathers from a song folder
and that the result reads back through mps-core's reader."""

import json
import shutil
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from mps_core import pack
from pack_export import build_practice_pack

SR = 22050
needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")


def tone(freq, seconds=2.0):
    t = np.arange(int(SR * seconds)) / SR
    return (0.3 * np.sin(2 * np.pi * freq * t)).astype("float32")


@pytest.fixture
def song(tmp_path):
    d = tmp_path / "song"
    d.mkdir()
    sf.write(d / "vocals.wav", tone(220), SR)
    sf.write(d / "instrumental.wav", tone(110), SR)
    times = [i * 0.0232 for i in range(int(2.0 / 0.0232))]
    json.dump(
        {"pitchData": {"times": times, "f0": [220.0] * len(times), "voiced": [True] * len(times), "confidence": [1.0] * len(times)}},
        open(d / "analysis.json", "w"),
    )
    return d


META = {
    "songId": "abc-123",
    "title": "Practice Song",
    "artist": "Someone",
    "durationS": 2.0,
    "bpm": 100.0,
    "key": "A minor",
    "metronomeOffsetS": 0.1,
    "loops": [{"name": "Verse", "start": 0.2, "end": 1.2}],
    "createdAt": "2026-10-15T12:00:00Z",
}


def fake_encode(src, dst, *, bitrate_kbps=96, mono=False, **_):
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_bytes(f"{Path(src).name}|{bitrate_kbps}|{mono}".encode())
    return Path(dst)


def test_a_song_becomes_a_pack_that_reads_back(song, tmp_path):
    out = tmp_path / "out" / "song.vppack"
    result = build_practice_pack(str(song), str(out), META, encode=fake_encode)
    assert result["hasReference"] and not result["hasLyrics"] and result["variants"] == []
    m = pack.read_manifest(out)
    assert m["app"] == "vps" and m["title"] == "Practice Song" and m["durationS"] == 2.0
    assert [t["name"] for t in m["tracks"]] == ["vocals", "instrumental"]
    assert m["loops"] == [{"name": "Verse", "start": 0.2, "end": 1.2}]
    with zipfile.ZipFile(out) as z:
        assert z.read("vocals.m4a") == b"vocals.wav|64|True"
        assert z.read("instrumental.m4a") == b"instrumental.wav|96|False"
        ref = json.loads(z.read("reference_pitch.json"))
    assert ref["hopS"] == 0.02 and len(ref["f0"]) == 100 and ref["f0"][10] == 220.0


def test_cached_transpositions_and_lyrics_are_included(song, tmp_path):
    for n in (-2, 3):
        d = song / "pitched" / str(n)
        d.mkdir(parents=True)
        sf.write(d / "vocals.wav", tone(220), SR)
        sf.write(d / "instrumental.wav", tone(110), SR)
    (song / "pitched" / "5").mkdir()
    sf.write(song / "pitched" / "5" / "vocals.wav", tone(220), SR)
    (song / "pitched" / "99").mkdir()
    (song / "lyrics.json").write_text(json.dumps({"lines": []}))
    out = tmp_path / "p.vppack"
    result = build_practice_pack(str(song), str(out), META, encode=fake_encode)
    assert result["variants"] == [-2, 3]
    assert result["hasLyrics"]
    m = pack.read_manifest(out)
    assert [v["semitones"] for v in m["variants"]] == [-2, 3]
    assert m["lyrics"] == {"file": "lyrics.json"}


def test_a_song_without_analysis_has_no_reference(song, tmp_path):
    (song / "analysis.json").unlink()
    out = tmp_path / "p.vppack"
    result = build_practice_pack(str(song), str(out), META, encode=fake_encode)
    assert not result["hasReference"]
    assert pack.read_manifest(out)["reference"] is None


def test_missing_stems_and_bad_metadata_are_refused_cleanly(song, tmp_path):
    (song / "instrumental.wav").unlink()
    out = tmp_path / "p.vppack"
    with pytest.raises(pack.PackError, match="instrumental.wav"):
        build_practice_pack(str(song), str(out), META, encode=fake_encode)
    sf.write(song / "instrumental.wav", tone(110), SR)
    bad = dict(META, loops=[{"name": "Past the end", "start": 1.0, "end": 99.0}])
    with pytest.raises(pack.PackError, match="inside the song"):
        build_practice_pack(str(song), str(out), bad, encode=fake_encode)
    assert not out.exists()


def test_progress_uses_the_sidecars_value_then_stage_order(song, tmp_path):
    # Same shape as main.make_progress_callback: callback(value, stage) rounds
    # the value, so a swapped order fails with "type str doesn't define __round__".
    sent = []

    def callback(value: float, stage: str):
        sent.append({"stage": stage, "value": round(value, 3)})

    build_practice_pack(str(song), str(tmp_path / "p.vppack"), META, on_progress=callback, encode=fake_encode)
    values = [m["value"] for m in sent]
    assert values == sorted(values) and values[-1] == 1.0
    assert all(isinstance(m["stage"], str) and m["stage"] for m in sent)


@needs_ffmpeg
def test_with_real_ffmpeg_the_pack_is_aac_and_much_smaller(song, tmp_path):
    out = tmp_path / "p.vppack"
    build_practice_pack(str(song), str(out), META)
    with zipfile.ZipFile(out) as z:
        v = z.read("vocals.m4a")
    assert v[4:8] == b"ftyp"
    assert out.stat().st_size < (song / "vocals.wav").stat().st_size + (song / "instrumental.wav").stat().st_size
