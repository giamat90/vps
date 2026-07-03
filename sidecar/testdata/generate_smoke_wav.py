#!/usr/bin/env python3
"""
Regenerates smoke_test.wav: a 2-second 440Hz sine tone, 22050Hz mono 16-bit.
Stdlib-only (wave + struct) so it needs no project dependencies to run.
Used by sidecar/smoke_test.py to exercise the built sidecar end-to-end.
"""
import math
import os
import struct
import wave

SAMPLE_RATE = 22050
DURATION_S = 2
FREQ_HZ = 440

out_path = os.path.join(os.path.dirname(__file__), "smoke_test.wav")

with wave.open(out_path, "wb") as f:
    f.setnchannels(1)
    f.setsampwidth(2)
    f.setframerate(SAMPLE_RATE)
    frames = bytearray()
    for i in range(SAMPLE_RATE * DURATION_S):
        sample = int(32767 * 0.5 * math.sin(2 * math.pi * FREQ_HZ * i / SAMPLE_RATE))
        frames += struct.pack("<h", sample)
    f.writeframes(bytes(frames))

print(f"Wrote {out_path}")
