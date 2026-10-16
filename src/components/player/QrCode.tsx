import { useMemo } from "react";
import { qrMatrix, qrPath } from "../../lib/qr";

const QUIET_ZONE = 4;

/** Dark modules on a light ground whatever the app theme: scanners expect that. */
function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const matrix = qrMatrix(text);
    return { size: matrix.size, path: qrPath(matrix) };
  }, [text]);
  const side = size + 2 * QUIET_ZONE;
  return (
    <svg
      className="qr-code"
      viewBox={`0 0 ${side} ${side}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={side} height={side} className="qr-code__ground" />
      <path d={path} transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`} className="qr-code__ink" />
    </svg>
  );
}

export default QrCode;
