import qrcode from "qrcode-generator";

export interface QrMatrix {
  size: number;
  isDark: (row: number, col: number) => boolean;
}

/** Medium error correction: a screen is a clean medium, and a smaller code is easier for a phone to find. */
export function qrMatrix(text: string): QrMatrix {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  return { size: code.getModuleCount(), isDark: (row, col) => code.isDark(row, col) };
}

/** One SVG path for all dark modules, merged into horizontal runs, in module units. */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row++) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.isDark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < matrix.size && matrix.isDark(row, col)) col++;
      parts.push(`M${start} ${row}h${col - start}v1h-${col - start}z`);
    }
  }
  return parts.join("");
}
