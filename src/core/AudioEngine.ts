// ============ 音频引擎:AudioContext 管理、主混音、混响、输出电平 ============

export class AudioEngine {
  ctx: AudioContext;
  master: GainNode;
  analyser: AnalyserNode;
  private _volume = 0.8;
  private _vibrato = 0;    // 全局颤音深度(0-1)
  private _vibratoRate = 5.5;
  private reverbNode: ConvolverNode;
  private wet: GainNode;
  private dry: GainNode;
  private _reverb = 0;     // 混响量 0-1

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this._volume;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);
    // 混响:生成指数衰减噪声脉冲响应,干/湿并行进 destination
    this.reverbNode = this.ctx.createConvolver();
    this.reverbNode.buffer = this.buildIR(1.6, 3.2);
    this.wet = this.ctx.createGain();
    this.wet.gain.value = 0;
    this.dry = this.ctx.createGain();
    this.dry.gain.value = 1;
    this.master.connect(this.reverbNode);
    this.reverbNode.connect(this.wet);
    this.master.connect(this.dry);
    this.wet.connect(this.ctx.destination);
    this.dry.connect(this.ctx.destination);
  }

  // 指数衰减噪声脉冲响应(简单房间混响)
  private buildIR(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  get volume() { return this._volume; }
  set volume(v: number) {
    this._volume = v;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  get vibrato() { return this._vibrato; }
  set vibrato(v: number) { this._vibrato = v; }
  get vibratoRate() { return this._vibratoRate; }
  set vibratoRate(v: number) { this._vibratoRate = v; }

  get reverb() { return this._reverb; }
  set reverb(v: number) {
    this._reverb = v;
    const t = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(v * 0.85, t, 0.05);
    this.dry.gain.setTargetAtTime(1 - v * 0.45, t, 0.05);
  }

  async resume() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  // 读输出电平(0-1 RMS,供 VU 表)
  readLevel(): number {
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const d = v - 128; sum += d * d; }
    return Math.sqrt(sum / buf.length) / 128;
  }
}
