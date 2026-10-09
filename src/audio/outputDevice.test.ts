import { describe, it, expect } from "vitest";
import { pickHardwareOutput } from "./outputDevice";

const dev = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: "g" }) as MediaDeviceInfo;

describe("pickHardwareOutput", () => {
  const mic = dev("audioinput", "mic", "Microphone (2-Behringer USB WDM Audio)");

  it("pairs a USB interface's input with its own output", () => {
    const out = pickHardwareOutput([
      mic,
      dev("audiooutput", "realtek", "Speakers (Realtek Audio)"),
      dev("audiooutput", "ub", "Speakers (2-Behringer USB WDM Audio)"),
    ], "mic");
    expect(out).toBe("ub");
  });

  it("prefers the stronger match even when a weaker one is listed first", () => {
    const out = pickHardwareOutput([
      mic,
      dev("audiooutput", "weak", "Speakers (Generic Audio)"),
      dev("audiooutput", "strong", "Headphones (Behringer UM2 Audio)"),
    ], "mic");
    expect(out).toBe("strong");
  });

  it("never returns the Default or Communications aliases, nor Steam's virtual device", () => {
    const out = pickHardwareOutput([
      mic,
      dev("audiooutput", "d", "Default - Speakers (2-Behringer USB WDM Audio)"),
      dev("audiooutput", "c", "Communications - Speakers (2-Behringer USB WDM Audio)"),
      dev("audiooutput", "s", "Steam Streaming Speakers"),
      dev("audiooutput", "real", "Speakers (Realtek Audio)"),
    ], "mic");
    expect(out).toBe("real");
  });

  it("falls back to the first real output when nothing shares a token with the mic", () => {
    const out = pickHardwareOutput([
      dev("audioinput", "m2", "Line In (Focusrite)"),
      dev("audiooutput", "a", "Speakers (Realtek)"),
      dev("audiooutput", "b", "Monitors (Yamaha)"),
    ], "m2");
    expect(out).toBe("a");
  });

  it("falls back to the first real output when the selected mic is unknown or null", () => {
    const outs = [dev("audiooutput", "a", "Speakers (Realtek)"), dev("audiooutput", "b", "Monitors (Yamaha)")];
    expect(pickHardwareOutput(outs, "ghost")).toBe("a");
    expect(pickHardwareOutput(outs, null)).toBe("a");
  });

  it("returns undefined when there is no usable output", () => {
    expect(pickHardwareOutput([], "mic")).toBeUndefined();
    expect(pickHardwareOutput([mic, dev("audiooutput", "d", "Default - Speakers")], "mic")).toBeUndefined();
  });

  it("ignores tokens shorter than four characters (USB, WDM, 2)", () => {
    const out = pickHardwareOutput([
      dev("audioinput", "m", "Mic (USB WDM)"),
      dev("audiooutput", "first", "Out (Realtek)"),
      dev("audiooutput", "usb", "Out (USB WDM)"),
    ], "m");
    expect(out).toBe("first");
  });

  it("is case-insensitive", () => {
    const out = pickHardwareOutput([
      dev("audioinput", "m", "MICROPHONE (behringer)"),
      dev("audiooutput", "x", "Speakers (Realtek)"),
      dev("audiooutput", "y", "speakers (BEHRINGER)"),
    ], "m");
    expect(out).toBe("y");
  });

  it("does not consider input devices as outputs", () => {
    expect(pickHardwareOutput([mic, dev("audioinput", "other", "Behringer")], "mic")).toBeUndefined();
  });
});
