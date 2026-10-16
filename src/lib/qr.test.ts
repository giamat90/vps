import { describe, it, expect } from "vitest";
import jsQR from "jsqr";
import { qrMatrix, qrPath } from "./qr";

const QUIET = 4;

/** Paints the path the way the browser would (module units, dark on white) and returns RGBA pixels. */
function rasterize(path: string, size: number, scale: number) {
  const side = (size + 2 * QUIET) * scale;
  const rgba = new Uint8ClampedArray(side * side * 4).fill(255);
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let py = (y + QUIET) * scale; py < (y + QUIET + 1) * scale; py++) {
      for (let px = (x + QUIET) * scale; px < (x + QUIET + w) * scale; px++) {
        const i = (py * side + px) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      }
    }
  }
  return { rgba, side };
}

describe("the QR code", () => {
  const link = "http://192.168.8.104:49152/pack/0123456789abcdef0123456789abcdef";

  it("decodes back to the link it was made from", () => {
    const matrix = qrMatrix(link);
    const { rgba, side } = rasterize(qrPath(matrix), matrix.size, 4);
    const decoded = jsQR(rgba, side, side);
    expect(decoded?.data).toBe(link);
  });

  it("stays a small, easy code for a link of this length", () => {
    expect(qrMatrix(link).size).toBeLessThanOrEqual(41);
  });

  it("is drawn from runs of dark modules without gaps or overlaps", () => {
    const matrix = qrMatrix(link);
    let dark = 0;
    for (let r = 0; r < matrix.size; r++) for (let c = 0; c < matrix.size; c++) if (matrix.isDark(r, c)) dark++;
    const covered = [...qrPath(matrix).matchAll(/h(\d+)v1/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(covered).toBe(dark);
  });
});
