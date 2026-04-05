#!/usr/bin/env python3
"""
VPS Python Sidecar
Communicates with Tauri shell via JSON lines on stdin/stdout.
Commands run in a worker thread so the stdin loop stays responsive.
"""

import sys
import json
import threading
import traceback

from processor import process
from analysis import analyze_recording

# Lock to ensure only one JSON line is written at a time
_write_lock = threading.Lock()

# Track whether a job is currently running
_busy = False
_busy_lock = threading.Lock()


def send(msg: dict):
    """Send a JSON message to stdout (thread-safe)."""
    with _write_lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def _make_progress_callback(cmd_name: str):
    """Create a progress callback that emits JSON progress messages."""
    def on_progress(value: float, stage: str):
        send({"type": "progress", "cmd": cmd_name, "value": round(value, 3), "stage": stage})
    return on_progress


def _run_process(file_path: str, output_dir: str):
    """Run the song processing pipeline in a worker thread."""
    global _busy
    try:
        result = process(file_path, output_dir, on_progress=_make_progress_callback("process"))
        send({"type": "result", "cmd": "process", "data": result})
    except Exception as e:
        send({
            "type": "error",
            "cmd": "process",
            "message": str(e),
            "traceback": traceback.format_exc(),
        })
    finally:
        with _busy_lock:
            _busy = False


def _run_analyze(recording_path: str, output_dir: str = None):
    """Run the recording analysis pipeline in a worker thread."""
    global _busy
    try:
        result = analyze_recording(recording_path, output_dir, on_progress=_make_progress_callback("analyze"))
        send({"type": "result", "cmd": "analyze", "data": result})
    except Exception as e:
        send({
            "type": "error",
            "cmd": "analyze",
            "message": str(e),
            "traceback": traceback.format_exc(),
        })
    finally:
        with _busy_lock:
            _busy = False


def main():
    send({"type": "ready"})
    global _busy

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            send({"type": "error", "message": f"Invalid JSON: {line}"})
            continue

        action = cmd.get("cmd")

        if action == "ping":
            send({"type": "pong"})

        elif action == "quit":
            send({"type": "bye"})
            break

        elif action == "process":
            with _busy_lock:
                if _busy:
                    send({"type": "error", "cmd": "process", "message": "A job is already running"})
                    continue
                _busy = True

            file_path = cmd.get("filePath")
            output_dir = cmd.get("outputDir")
            if not file_path or not output_dir:
                send({"type": "error", "cmd": "process", "message": "Missing filePath or outputDir"})
                with _busy_lock:
                    _busy = False
                continue
            
            thread = threading.Thread(target=_run_process, args=(file_path, output_dir), daemon=True)
            thread.start()

        elif action == "analyze":
            with _busy_lock:
                if _busy:
                    send({"type": "error", "cmd": "analyze", "message": "A job is already running"})
                    continue
                _busy = True

            recording_path = cmd.get("recordingPath")
            output_dir = cmd.get("outputDir")
            if not recording_path:
                send({"type": "error", "cmd": "analyze", "message": "Missing recordingPath"})
                with _busy_lock:
                    _busy = False
                continue

            thread = threading.Thread(target=_run_analyze, args=(recording_path, output_dir), daemon=True)
            thread.start()

        else:
            send({"type": "error", "message": f"Unknown command: {action}"})


if __name__ == "__main__":
    main()
