export class VocalRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private _isRecording = false;

  async init(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  start(): void {
    if (!this.stream) throw new Error("Recorder not initialized — call init() first");
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: "audio/webm;codecs=opus" });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(100);
    this._isRecording = true;
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.recorder || this.recorder.state !== "recording") {
        reject(new Error("Not recording"));
        return;
      }
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: "audio/webm;codecs=opus" });
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

  dispose(): void {
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.stop();
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this._isRecording = false;
  }
}
