#!/usr/bin/env python3
"""
VPS Python Sidecar
Communicates with Tauri shell via JSON lines on stdin/stdout.
Commands execute synchronously on the main thread to avoid GIL/numpy
deadlocks that occur with background threads on Windows.
"""

import sys
import json
import traceback

from processor import process
from analysis import analyze_recording, convert_take_to_wav


def send(msg: dict):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def make_progress_callback(cmd_name: str):
    def callback(value: float, stage: str):
        send({"type": "progress", "cmd": cmd_name, "stage": stage, "value": round(value, 3)})
    return callback


def main():
    send({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            send({"type": "error", "message": f"Invalid JSON: {line}"})
            continue

        try:
            if cmd.get("cmd") == "process":
                result = process(
                    cmd["filePath"],
                    cmd["outputDir"],
                    on_progress=make_progress_callback("process"),
                    high_quality=cmd.get("highQuality", False),
                )
                send({"type": "result", "cmd": "process", "data": result})

            elif cmd.get("cmd") == "analyze":
                result = analyze_recording(
                    cmd["recordingPath"],
                    cmd["outputDir"],
                    on_progress=make_progress_callback("analyze"),
                    audio_offset_s=float(cmd.get("audioOffset", 0.0)),
                )
                send({"type": "result", "cmd": "analyze", "data": result})

            elif cmd.get("cmd") == "convert_take":
                result = convert_take_to_wav(cmd["recordingPath"], cmd["outputPath"])
                send({"type": "result", "cmd": "convert_take", "data": result})

            elif cmd.get("cmd") == "pitch_shift":
                from processor import pitch_shift_song
                result = pitch_shift_song(
                    cmd["songDir"],
                    cmd["cacheDir"],
                    cmd["nSteps"],
                    on_progress=make_progress_callback("pitch_shift"),
                )
                send({"type": "result", "cmd": "pitch_shift", "data": result})

            elif cmd.get("cmd") == "import_yt":
                from yt_importer import import_yt
                result = import_yt(
                    cmd["url"],
                    cmd["outputDir"],
                    on_progress=make_progress_callback("import_yt"),
                    high_quality=cmd.get("highQuality", False),
                )
                send({"type": "result", "cmd": "import_yt", "data": result})

            elif cmd.get("cmd") == "ping":
                send({"type": "pong"})

            elif cmd.get("cmd") == "quit":
                send({"type": "bye"})
                break

            else:
                send({"type": "error", "message": f"Unknown command: {cmd.get('cmd')}"})

        except Exception as e:
            send({
                "type": "error",
                "cmd": cmd.get("cmd"),
                "message": str(e),
                "traceback": traceback.format_exc(),
            })


if __name__ == "__main__":
    main()
