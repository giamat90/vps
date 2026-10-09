const MIN_TOKEN_LENGTH = 4;

function tokens(label: string): string[] {
  return [...new Set(label.toUpperCase().split(/\W+/).filter((t) => t.length >= MIN_TOKEN_LENGTH))];
}

/**
 * After getUserMedia opens a mic, Windows can reroute the "Default" output to
 * the Communications endpoint, so the real hardware output has to be named
 * explicitly. Excludes the Default/Communications aliases and virtual (Steam)
 * devices, then prefers the output sharing the most label tokens with the
 * selected mic (a USB interface names its input and output alike). Scoring by
 * count rather than taking the first hit keeps a generic shared word such as
 * "Audio" from pairing a mic with an unrelated sound card.
 */
export function pickHardwareOutput(devices: MediaDeviceInfo[], inputDeviceId: string | null): string | undefined {
  const inputLabel = (devices.find((d) => d.kind === "audioinput" && d.deviceId === inputDeviceId)?.label ?? "").toUpperCase();
  const real = devices.filter(
    (d) =>
      d.kind === "audiooutput" &&
      !d.label.startsWith("Default -") &&
      !d.label.startsWith("Communications -") &&
      !d.label.toLowerCase().includes("steam"),
  );

  let best: MediaDeviceInfo | undefined;
  let bestScore = 0;
  for (const d of real) {
    const score = tokens(d.label).filter((t) => inputLabel.includes(t)).length;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return (best ?? real[0])?.deviceId;
}
