import { autocorrelatePitch } from "@giamat90/mps-core/pitch";
import { frequencyToNoteName } from "./analysisUtils";

export interface PitchReading {
  frequency: number;
  name: string;
  cents: number;
}

/**
 * Real-time pitch detector: an AnalyserNode on a microphone MediaStream feeding
 * the shared autocorrelation in mps-core. Call getCurrentPitch() on each animation frame.
 */
export class PitchDetector {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private buffer: Float32Array<ArrayBuffer> = new Float32Array(0) as Float32Array<ArrayBuffer>;

  start(stream: MediaStream): void {
    this.stop();
    this.ctx = new AudioContext();
    void this.ctx.resume();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
  }

  getCurrentPitch(): PitchReading | null {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this.buffer);

    const freq = autocorrelatePitch(this.buffer, this.ctx!.sampleRate);
    if (freq === null) return null;

    const { name, cents } = frequencyToNoteName(freq);
    return { frequency: freq, name, cents };
  }

  stop(): void {
    this.source?.disconnect();
    this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    this.source = null;
  }
}
