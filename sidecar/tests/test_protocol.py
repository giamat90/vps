"""The real `python main.py` process, driven exactly like Rust's SidecarManager does: JSON lines over stdio."""

import json
import os
import queue
import subprocess
import sys
import threading

import numpy as np
import pytest
import soundfile as sf

from helpers import harmonic_tone, sine, write_wav

pytestmark = pytest.mark.slow

SR = 22050


class Sidecar:
    def __init__(self, home):
        env = {**os.environ, "USERPROFILE": str(home), "HOME": str(home), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        self.proc = subprocess.Popen(
            [sys.executable, "main.py"],
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        self.lines: "queue.Queue[bytes]" = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for line in self.proc.stdout:
            self.lines.put(line)
        self.lines.put(b"")

    def send(self, obj):
        self.send_raw(json.dumps(obj))

    def send_raw(self, text):
        self.proc.stdin.write((text + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def recv(self, timeout=60):
        line = self.lines.get(timeout=timeout)
        assert line != b"", "sidecar closed stdout"
        return json.loads(line.decode("utf-8"))

    def final(self, timeout=120):
        """Everything up to (and including) the first non-progress message."""
        progress = []
        while True:
            msg = self.recv(timeout)
            if msg["type"] == "progress":
                progress.append(msg)
            else:
                return msg, progress

    def call(self, obj, timeout=120):
        self.send(obj)
        return self.final(timeout)

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


@pytest.fixture(scope="module")
def sidecar(tmp_path_factory):
    home = tmp_path_factory.mktemp("home")
    sc = Sidecar(home)
    ready = sc.recv(timeout=120)
    sc.ready = ready
    yield sc
    sc.close()


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    d = tmp_path_factory.mktemp("work")
    write_wav(d / "tone.wav", harmonic_tone(220, SR, 2.0), SR)
    return d


def test_announces_readiness_first(sidecar):
    assert sidecar.ready["type"] == "ready"
    assert "advisory" in sidecar.ready


def test_ping_pong(sidecar):
    assert sidecar.call({"cmd": "ping"})[0] == {"type": "pong"}


def test_invalid_json_is_reported_and_the_loop_survives(sidecar):
    sidecar.send_raw("{broken")
    msg, _ = sidecar.final(30)
    assert msg["type"] == "error" and "Invalid JSON" in msg["message"]
    assert sidecar.call({"cmd": "ping"})[0]["type"] == "pong"


def test_blank_lines_are_ignored(sidecar):
    sidecar.send_raw("")
    sidecar.send_raw("   ")
    assert sidecar.call({"cmd": "ping"})[0]["type"] == "pong"


def test_unknown_commands_are_reported_by_name(sidecar):
    msg, _ = sidecar.call({"cmd": "make_coffee"})
    assert msg["type"] == "error" and "Unknown command: make_coffee" in msg["message"]


def test_a_command_without_a_cmd_field_is_an_unknown_command(sidecar):
    msg, _ = sidecar.call({"hello": 1})
    assert msg["type"] == "error" and "Unknown command" in msg["message"]


def test_a_command_missing_a_required_argument_returns_a_traceback_not_a_crash(sidecar):
    msg, _ = sidecar.call({"cmd": "compute_st_spectrum"})
    assert msg["type"] == "error" and msg["cmd"] == "compute_st_spectrum"
    assert "audioPath" in msg["message"] and "Traceback" in msg["traceback"]
    assert sidecar.call({"cmd": "ping"})[0]["type"] == "pong"


def test_an_exception_inside_a_command_is_reported_with_the_command_name(sidecar, tmp_path):
    msg, _ = sidecar.call({"cmd": "compute_st_spectrum", "audioPath": str(tmp_path / "missing.wav")})
    assert msg["type"] == "error" and msg["cmd"] == "compute_st_spectrum"


def test_compute_st_spectrum(sidecar, work):
    msg, _ = sidecar.call({"cmd": "compute_st_spectrum", "audioPath": str(work / "tone.wav"), "audioOffset": 0.5})
    assert msg["type"] == "result" and msg["cmd"] == "compute_st_spectrum"
    d = msg["data"]
    assert d["stSpectrumBins"] == 1280 and d["stSpectrumFrames"] > 0
    assert (d["stSpectrumMinDb"], d["stSpectrumMaxDb"]) == (-100.0, 0.0)


def test_analyze_streams_progress_then_a_result(sidecar, work):
    msg, progress = sidecar.call({"cmd": "analyze", "recordingPath": str(work / "tone.wav"), "outputDir": str(work), "audioOffset": 0, "algorithm": "srh"})
    assert msg["type"] == "result" and msg["cmd"] == "analyze"
    assert progress and all(p["cmd"] == "analyze" and set(p) == {"type", "cmd", "stage", "value"} for p in progress)
    values = [p["value"] for p in progress]
    assert values == sorted(values) and values[-1] == 1.0
    assert all(isinstance(v, float) and v == round(v, 3) for v in values)
    assert msg["data"]["normalizedPath"].endswith("tone.wav")


def test_analyze_honours_the_reference_path_and_algorithm(sidecar, work, tmp_path):
    ref = write_wav(tmp_path / "ref.wav", harmonic_tone(300, SR, 2.0, amp=0.05), SR)
    take = write_wav(tmp_path / "take.webm", harmonic_tone(220, SR, 2.0, amp=0.6), SR)
    msg, _ = sidecar.call({"cmd": "analyze", "recordingPath": take, "outputDir": str(tmp_path), "referencePath": ref, "algorithm": "pyin"})
    assert msg["type"] == "result"
    out, _ = sf.read(msg["data"]["normalizedPath"])
    assert np.sqrt(np.mean(out**2)) == pytest.approx(0.05 / np.sqrt(2) * 0.9, rel=0.35)


def test_convert_take(sidecar, work, tmp_path):
    msg, _ = sidecar.call({"cmd": "convert_take", "recordingPath": str(work / "tone.wav"), "outputPath": str(tmp_path / "o.wav")})
    assert msg == {"type": "result", "cmd": "convert_take", "data": {"path": str(tmp_path / "o.wav")}}
    assert sf.info(str(tmp_path / "o.wav")).samplerate == SR


def test_mix_export_places_a_take_where_the_project_timeline_says(sidecar, tmp_path):
    stem = tmp_path / "stem.wav"
    sf.write(str(stem), np.full(8000 * 6, 0.1, dtype=np.float32), 8000, subtype="FLOAT")
    take = tmp_path / "take.wav"
    sf.write(str(take), np.full(8000 * 2, 0.3, dtype=np.float32), 8000, subtype="FLOAT")
    sources = [
        {"path": str(stem), "gain": 1.0, "isTake": False},
        {"path": str(take), "gain": 1.0, "isTake": True, "startPosition": 3.0, "audioOffset": 0.0, "manualOffset": 0.0},
    ]
    msg, _ = sidecar.call({"cmd": "mix_export", "sources": sources, "startSec": 2.0, "endSec": 6.0, "outputPath": str(tmp_path / "mix.wav")})
    assert msg["type"] == "result"
    data, sr = sf.read(str(tmp_path / "mix.wav"), dtype="float32")
    assert data[int(0.5 * sr), 0] == pytest.approx(0.1, abs=1e-3)
    assert data[int(1.5 * sr), 0] == pytest.approx(0.4, abs=1e-3)


def test_mix_export_with_no_sources_is_an_error(sidecar, tmp_path):
    msg, _ = sidecar.call({"cmd": "mix_export", "sources": [], "startSec": 0, "endSec": 1, "outputPath": str(tmp_path / "x.wav")})
    assert msg["type"] == "error" and "at least one source" in msg["message"]


def test_pitch_shift(sidecar, tmp_path):
    song = tmp_path / "song"
    cache = tmp_path / "cache"
    song.mkdir()
    cache.mkdir()
    for name in ("vocals.wav", "instrumental.wav"):
        write_wav(song / name, sine(220, SR, 1.0), SR)
    msg, progress = sidecar.call({"cmd": "pitch_shift", "songDir": str(song), "cacheDir": str(cache), "nSteps": 2})
    assert msg["type"] == "result"
    assert msg["data"]["vocalsPath"].startswith(str(cache))
    assert progress and progress[-1]["value"] == 1.0


def test_process_an_instrument_track_without_separation(sidecar, work, tmp_path):
    msg, progress = sidecar.call(
        {"cmd": "process", "filePath": str(work / "tone.wav"), "outputDir": str(tmp_path / "o"), "skipSeparation": True, "algorithm": "piano"},
        timeout=180,
    )
    assert msg["type"] == "result" and msg["cmd"] == "process"
    assert os.path.exists(msg["data"]["vocals"]) and os.path.exists(msg["data"]["instrumental"])
    assert progress[-1]["value"] == 1.0


def test_non_ascii_paths_round_trip(sidecar, tmp_path):
    folder = tmp_path / "Música – 日本語 ñ"
    folder.mkdir()
    path = write_wav(folder / "tóno.wav", sine(440, SR, 1.0), SR)
    msg, _ = sidecar.call({"cmd": "convert_take", "recordingPath": path, "outputPath": str(folder / "salida.wav")})
    assert msg["type"] == "result"
    assert msg["data"]["path"] == str(folder / "salida.wav")


def test_quit_says_bye_and_exits_cleanly(tmp_path_factory):
    sc = Sidecar(tmp_path_factory.mktemp("quit-home"))
    try:
        assert sc.recv(timeout=120)["type"] == "ready"
        assert sc.call({"cmd": "quit"})[0] == {"type": "bye"}
        assert sc.proc.wait(timeout=20) == 0
    finally:
        sc.close()


def test_closing_stdin_ends_the_process(tmp_path_factory):
    sc = Sidecar(tmp_path_factory.mktemp("eof-home"))
    try:
        assert sc.recv(timeout=120)["type"] == "ready"
        sc.proc.stdin.close()
        assert sc.proc.wait(timeout=20) == 0
    finally:
        sc.close()


def test_every_command_the_rust_side_sends_is_handled():
    """Rust emits these `cmd` values (grep of commands.rs); each must have a branch in main.py."""
    from pathlib import Path
    import re

    rust = (Path(__file__).resolve().parents[2] / "src-tauri" / "src" / "commands.rs").read_text(encoding="utf-8")
    sent = set(re.findall(r'"cmd":\s*"(\w+)"', rust))
    main_py = (Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")
    handled = set(re.findall(r'cmd\.get\("cmd"\) == "(\w+)"', main_py))
    assert sent, "regex found no commands in commands.rs"
    assert sent <= handled, f"Rust sends commands main.py does not handle: {sent - handled}"


def test_a_failing_freshness_check_is_logged_and_does_not_block_startup(monkeypatch, capsys):
    import io

    import main

    def boom():
        raise RuntimeError("network down")

    monkeypatch.setattr(main, "check_yt_dlp_freshness", boom)
    monkeypatch.setattr(main.sys, "stdin", io.StringIO(""))
    main.main()
    captured = capsys.readouterr()
    assert '"type": "ready"' in captured.out and '"advisory": null' in captured.out
    assert "network down" in captured.err
