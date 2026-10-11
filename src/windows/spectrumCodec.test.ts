import { describe, it, expect } from "vitest";
import { decodeSpectrum, encodeSpectrum } from "./spectrumCodec";

describe("spectrum codec", () => {
  it("round-trips a spectrum to within a bit under half a decibel", () => {
    const db = new Float32Array([-100, -87.3, -60, -33.3, -12.5, -0.4, 0]);
    const out = decodeSpectrum(encodeSpectrum(db));
    expect(out).toHaveLength(db.length);
    for (let i = 0; i < db.length; i++) expect(Math.abs(out[i] - db[i])).toBeLessThan(0.4);
  });

  it("keeps the length of a real analyser frame", () => {
    const db = new Float32Array(4096).map((_, i) => -100 + (i / 4096) * 100);
    expect(decodeSpectrum(encodeSpectrum(db))).toHaveLength(4096);
  });

  it("is one byte per bin, as base64", () => {
    const encoded = encodeSpectrum(new Float32Array(300).fill(-50));
    expect(encoded.length).toBe(Math.ceil(300 / 3) * 4);
  });

  it("clamps what lies outside the -100..0 dB window", () => {
    const out = decodeSpectrum(encodeSpectrum(new Float32Array([-250, 12])));
    expect(out[0]).toBe(-100);
    expect(out[1]).toBe(0);
  });

  it("treats silence (-Infinity) and NaN as the floor", () => {
    const out = decodeSpectrum(encodeSpectrum(new Float32Array([Number.NEGATIVE_INFINITY, Number.NaN])));
    expect(Array.from(out)).toEqual([-100, -100]);
  });

  it("can decode into a buffer the caller owns", () => {
    const into = new Float32Array(3);
    const out = decodeSpectrum(encodeSpectrum(new Float32Array([-100, -50, 0])), into);
    expect(out).toBe(into);
    expect(into[2]).toBe(0);
  });

  it("allocates when the buffer it was given is the wrong size", () => {
    const into = new Float32Array(8);
    const out = decodeSpectrum(encodeSpectrum(new Float32Array([-100, -50, 0])), into);
    expect(out).not.toBe(into);
    expect(out).toHaveLength(3);
  });

  it("rejects text that is not base64", () => {
    expect(() => decodeSpectrum("***not base64***")).toThrow();
  });
});
