/** The analyser's dB values live in this window; anything outside it carries no information here. */
const MIN_DB = -100;
const MAX_DB = 0;
const CHUNK = 0x2000;

/** One byte per bin: 0.4 dB resolution is finer than the panel can show, and a 4096-bin frame is ~5.5 KB as base64. */
export function encodeSpectrum(db: Float32Array): string {
  const bytes = new Uint8Array(db.length);
  for (let i = 0; i < db.length; i++) {
    const v = db[i];
    bytes[i] = Number.isFinite(v)
      ? Math.max(0, Math.min(255, Math.round(((v - MIN_DB) / (MAX_DB - MIN_DB)) * 255)))
      : 0;
  }
  let text = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(text);
}

export function decodeSpectrum(encoded: string, into?: Float32Array): Float32Array {
  const text = atob(encoded);
  const out = into && into.length === text.length ? into : new Float32Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = MIN_DB + (text.charCodeAt(i) / 255) * (MAX_DB - MIN_DB);
  }
  return out;
}
