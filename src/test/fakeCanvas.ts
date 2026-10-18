export interface RecordingContext {
  ctx: CanvasRenderingContext2D;
  log: string[];
}

function fmt(v: unknown): string {
  if (typeof v === "number") return String(Number(v.toPrecision(12)));
  if (typeof v === "string") return JSON.stringify(v);
  if (v && typeof v === "object" && "width" in v && "height" in v && !ArrayBuffer.isView(v)) {
    const o = v as { width: number; height: number };
    return `[canvas ${o.width}x${o.height}]`;
  }
  if (ArrayBuffer.isView(v)) {
    const a = v as unknown as ArrayLike<number>;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum = (sum * 31 + a[i]) % 2147483647;
    return `[data ${a.length} #${sum}]`;
  }
  return JSON.stringify(v);
}

function pattern(n: number, seed: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) d[i] = (i * 7 + seed) % 251;
  return d;
}

/**
 * A 2D context that records every call and property assignment as a string, so draw code can be
 * asserted on (and two implementations compared) without pixels.
 */
export function createRecordingContext(): RecordingContext {
  const log: string[] = [];
  const props: Record<string, unknown> = {};
  const handler: ProxyHandler<object> = {
    get(_t, name: string) {
      if (name in props) return props[name];
      if (name === "createLinearGradient") {
        return (...a: unknown[]) => {
          log.push(`createLinearGradient(${a.map(fmt).join(",")})`);
          return { addColorStop: (o: number, c: string) => log.push(`gradient.addColorStop(${fmt(o)},${fmt(c)})`) };
        };
      }
      if (name === "measureText") {
        return (text: string) => {
          log.push(`measureText(${fmt(text)})`);
          return { width: text.length * 6 };
        };
      }
      if (name === "createImageData") {
        return (w: number, h: number) => {
          log.push(`createImageData(${w},${h})`);
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        };
      }
      if (name === "getImageData") {
        return (x: number, y: number, w: number, h: number) => {
          log.push(`getImageData(${x},${y},${w},${h})`);
          return { width: w, height: h, data: pattern(w * h * 4, x + y) };
        };
      }
      return (...a: unknown[]) => {
        log.push(`${name}(${a.map(fmt).join(",")})`);
      };
    },
    set(_t, name: string, value) {
      props[name] = value;
      log.push(`${name}=${fmt(value)}`);
      return true;
    },
  };
  return { ctx: new Proxy({}, handler) as unknown as CanvasRenderingContext2D, log };
}

export interface FakeCanvas {
  canvas: HTMLCanvasElement;
  log: string[];
}

export function createFakeCanvas(cssWidth: number, cssHeight: number): FakeCanvas {
  const { ctx, log } = createRecordingContext();
  const canvas = {
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    offsetWidth: cssWidth,
    offsetHeight: cssHeight,
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => ctx,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, log };
}
