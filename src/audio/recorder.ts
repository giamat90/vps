const CHANNEL_LIVE_RMS_THRESHOLD = 0.003; // ~ -50 dBFS

function measureChannelLevels(ctx: AudioContext, splitter: ChannelSplitterNode, n: number): Promise<number[]> {
  const analysers: AnalyserNode[] = [];
  for (let i = 0; i < n; i++) {
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    splitter.connect(a, i);
    analysers.push(a);
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      const buf = new Float32Array(analysers[0].fftSize);
      const levels = analysers.map((a) => {
        a.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        return Math.sqrt(sumSq / buf.length);
      });
      analysers.forEach((a) => a.disconnect());
      resolve(levels);
    }, 200);
  });
}

export class VocalRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private _isRecording = false;

  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private gains: GainNode[] = [];
  private merger: ChannelMergerNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;

  async init(deviceId?: string | null): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        sampleRate: 44100,
      },
      video: false,
    });
    const settings = this.stream.getAudioTracks()[0].getSettings();
    console.log("[mic] track settings:", settings);

    try {
      this.ctx = new AudioContext({ sampleRate: 44100 });
    } catch (e) {
      console.warn("[recorder] AudioContext with sampleRate:44100 failed, falling back:", e);
      this.ctx = new AudioContext();
    }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.dest = this.ctx.createMediaStreamDestination();

    const nativeChannels = settings.channelCount ?? 1;
    if (nativeChannels <= 1) {
      this.source.connect(this.dest);
      return;
    }
    await this.buildChannelFixGraph(nativeChannels);
  }

  // Some interfaces (e.g. 2-in USB devices) only route the mic to one physical
  // channel. Forcing getUserMedia to mono makes the browser average that live
  // channel against a silent one, halving amplitude (~ -6dB) vs a DAW that reads
  // the correct channel directly. Capture native channels instead and route only
  // the channel(s) that actually carry signal.
  private async buildChannelFixGraph(nativeChannels: number): Promise<void> {
    this.splitter = this.ctx!.createChannelSplitter(nativeChannels);
    this.source!.connect(this.splitter);

    const levels = await measureChannelLevels(this.ctx!, this.splitter, nativeChannels);
    const live = levels
      .map((rms, i) => ({ i, rms }))
      .filter((c) => c.rms > CHANNEL_LIVE_RMS_THRESHOLD);
    console.log("[recorder] channel levels (rms):", levels, "live:", live.map((c) => c.i));

    const merger = this.ctx!.createChannelMerger(1);
    this.merger = merger;

    if (live.length === 0) {
      for (let i = 0; i < nativeChannels; i++) {
        const g = this.ctx!.createGain();
        g.gain.value = 1 / nativeChannels;
        this.splitter!.connect(g, i);
        g.connect(merger, 0, 0);
        this.gains.push(g);
      }
    } else if (live.length === 1) {
      const g = this.ctx!.createGain();
      g.gain.value = 1.0;
      this.splitter!.connect(g, live[0].i);
      g.connect(merger, 0, 0);
      this.gains.push(g);
    } else {
      const makeup = nativeChannels / live.length;
      for (const c of live) {
        const g = this.ctx!.createGain();
        g.gain.value = makeup / nativeChannels;
        this.splitter!.connect(g, c.i);
        g.connect(merger, 0, 0);
        this.gains.push(g);
      }
    }

    merger.connect(this.dest!);
  }

  start(): void {
    if (!this.dest) throw new Error("Recorder not initialized — call init() first");

    // Pick the best supported mimeType — WebView2 may not support opus
    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

    this.chunks = [];
    this.recorder = new MediaRecorder(this.dest.stream, mimeType ? { mimeType } : {});
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onerror = (e) => {
      console.error("[recorder] MediaRecorder error:", e);
      this._isRecording = false;
    };
    this.recorder.start(100);
    this._isRecording = true;
    console.log("[recorder] started with mimeType:", this.recorder.mimeType);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.recorder || this.recorder.state !== "recording") {
        reject(new Error(`Not recording (state: ${this.recorder?.state ?? "no recorder"})`));
        return;
      }
      const mimeType = this.recorder.mimeType;
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        this._isRecording = false;
        resolve(blob);
      };
      this.recorder.stop();
    });
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  getProcessedStream(): MediaStream | null {
    return this.dest?.stream ?? null;
  }

  // Stop mic tracks to release the OS audio session (restores Windows default device).
  // Call this after stop() resolves, before restoring audio output routing.
  releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private teardownGraph(): void {
    this.gains.forEach((g) => g.disconnect());
    this.gains = [];
    this.merger?.disconnect();
    this.merger = null;
    this.splitter?.disconnect();
    this.splitter = null;
    this.source?.disconnect();
    this.source = null;
    this.dest?.disconnect();
    this.dest = null;
    if (this.ctx && this.ctx.state !== "closed") {
      this.ctx.close().catch((e) => console.warn("[recorder] AudioContext close:", e));
    }
    this.ctx = null;
  }

  dispose(): void {
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.stop();
    }
    this.releaseStream();
    this.teardownGraph();
    this.recorder = null;
    this._isRecording = false;
  }
}
