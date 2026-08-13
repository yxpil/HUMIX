// ============ 人声引擎:声带声源 + 共振峰滤波 ============
// 发声模型:声带脉冲(锯齿+低通)→ 4 个共振峰带通滤波器(声道共鸣)→ 输出
// 阶段 1:实时哼鸣(MIDI/琴键)+ 元音切换 + 颤音
// 阶段 2:拼音朗读 speak() —— 辅音噪声段(实测频带)+ 响音鼻化起始
//         + 声调轮廓 + 实测共振峰轨迹(阶段 2 数据驱动)

import { AudioEngine } from "./AudioEngine";
import { formantAt, FormantSet } from "./FormantTable";
import { VOICE, ConsonantData } from "./VoiceData";
import { SampleVoice } from "./SampleVoice";
import type { Phoneme } from "../pinyin/PinyinParser";

interface Voice {
  oscs: OscillatorNode[];       // 声带声源(多振荡器叠声带脉冲感)
  filters: BiquadFilterNode[];  // 4 个共振峰滤波器
  gain: GainNode;               // 振幅包络
  noise: AudioBufferSourceNode | null;
  noiseGain: GainNode | null;
  stopAt: number;
}

export interface SpeakOpts {
  base?: number;             // 基准音高 Hz(默认 VOICE.f0)
  rate?: number;             // 语速倍率(1 = 原速;>1 快)
  when?: number;             // 起始时间(默认 now + 40ms)
  pauses?: { at: number; dur: number }[];   // 停顿点:phonemes[at] 之后停顿 dur 秒(含换气)
}

// 每音符发音参数(卷帘曲线 0-1 值;缺省用全局滑块)
export interface NoteParams {
  breath?: number;   // 气息噪声量
  bright?: number;   // 明亮度
  vib?: number;      // 颤音深度
  vel?: number;      // 力度
  pitch?: number;    // 音高弯曲(0-1 → ±1 半音)
}

// 鼻化起始共振峰(m/n/l/r/y/w 的浊音段)
const MURMUR: FormantSet = {
  f: [280, 950, 2200, 3500],
  bw: [130, 210, 260, 420],
};

export class VoiceEngine {
  private engine: AudioEngine;
  private active = new Map<number, Voice>();
  private speechNodes: AudioScheduledSourceNode[] = [];
  private noiseBuf: AudioBuffer | null = null;
  private outGain: GainNode;          // 人声总输出(增益补偿,声音偏小问题)
  samples: SampleVoice;               // 素材语音库(OK/ 420 单音节)

  // 音色参数
  breathiness = 0.03;      // 哼鸣持续气息噪声(默认极小)
  brightness = 1.0;        // 明亮度(高次共振峰增益;卷帘曲线未画时的默认值)
  attack = 0.03;
  release = 0.15;
  currentVowel = "a";      // 当前元音(哼鸣用)
  transpose = 0;           // 全局移调(半音,影响哼鸣与卷帘播放)

  constructor(engine: AudioEngine) {
    this.engine = engine;
    this.outGain = engine.ctx.createGain();
    this.outGain.gain.value = 1.6;   // 共振峰链串联损耗补偿
    this.outGain.connect(engine.master);
    this.samples = new SampleVoice(engine);
  }

  // 真实声门源波形(从 OK/ 样本 LPC 逆滤波残差周期平均提取,PeriodicWave 缓存)
  private srcWaveCache: PeriodicWave | null = null;
  private getSrcWave(): PeriodicWave | null {
    if (!this.srcWaveCache && VOICE.srcWave) {
      const ctx = this.engine.ctx;
      this.srcWaveCache = ctx.createPeriodicWave(
        new Float32Array(VOICE.srcWave.real),
        new Float32Array(VOICE.srcWave.imag),
      );
    }
    return this.srcWaveCache;
  }

  // 韵母谐波包络波形缓存(共振峰直接刻进波形)
  // key = 韵母|音高:按音符频率动态计算包络 → 共振峰锁定,高音不"鸭子"
  private specWaves = new Map<string, PeriodicWave>();

  // 谐波幅度包络:4 共振峰(峰值归一化,宽带宽)× 声门谱倾斜;按实际谐波频率计算
  private formantEnvelope(freq: number, fs4: number[], bw4: number[], n: number): Float32Array {
    const spec = new Float32Array(n);
    for (let k = 1; k <= n; k++) {
      const f = freq * k;
      let h = 1;
      for (let i = 0; i < 4; i++) {
        const F = fs4[i];
        const B = Math.max(bw4[i], 40) * 1.6;
        if (F <= 0) continue;
        const d = (1 - (f / F) ** 2) ** 2 + (B * f / (F * F)) ** 2;
        h *= (B / F) / Math.sqrt(d + 1e-6);
      }
      h /= 1 + Math.pow(f / 2200, 2.4);
      h *= Math.exp(-f / 12000);
      spec[k - 1] = h;
    }
    let m = 0;
    for (const x of spec) m = Math.max(m, x);
    if (m > 0) for (let i = 0; i < n; i++) spec[i] /= m;
    return spec;
  }

  private getSpecWave(final: string, freq: number): PeriodicWave | null {
    const v = VOICE.vowels[final];
    if (!v || !v.traj) return null;
    const key = `${final}|${Math.round(freq)}`;
    let w = this.specWaves.get(key);
    if (!w) {
      const n = Math.max(8, Math.min(64, Math.floor(18000 / freq)));
      const spec = this.formantEnvelope(freq, v.traj[2].f, v.traj[2].bw, n);
      const real = new Float32Array(n + 1);
      const imag = new Float32Array(n + 1);
      for (let i = 0; i < n; i++) imag[i + 1] = spec[i];
      w = this.engine.ctx.createPeriodicWave(real, imag);
      this.specWaves.set(key, w);
    }
    return w;
  }

  // 创建声带声源:韵母谐波包络波形(按音高动态,共振峰锁定)→ 真实声门波形 → 锯齿堆
  private makeSource(final?: string, freq = 242): { oscs: OscillatorNode[]; out: AudioNode; spec?: boolean } {
    const ctx = this.engine.ctx;
    const oscs: OscillatorNode[] = [];
    const parts: AudioNode[] = [];
    const sw = final ? this.getSpecWave(final, freq) : null;
    let wave: PeriodicWave | null = sw;
    if (!wave) wave = this.getSrcWave();
    if (wave) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      parts.push(o);
      oscs.push(o);
    } else {
      const n = 3;
      for (let i = 1; i <= n; i++) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        const g = ctx.createGain();
        g.gain.value = 1 / i;
        o.connect(g);
        parts.push(g);
        oscs.push(o);
      }
    }
    const mix = ctx.createGain();
    for (const p of parts) p.connect(mix);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = sw ? 4200 : Math.min(4000, 200 * 4);
    lp.Q.value = 0.7;
    mix.connect(lp);
    return { oscs, out: lp, spec: !!sw };
  }

  // 共振峰滤波:4 个带通并联混合(人声频谱平滑,避免串联叠加的"管乐梳状感")
  private makeFormants(vowel: string, t: number, brightness = this.brightness): { filters: BiquadFilterNode[]; out: AudioNode } {
    const ctx = this.engine.ctx;
    const fs: FormantSet = formantAt(vowel, t);
    const sum = ctx.createGain();
    sum.gain.value = 1;
    const filters: BiquadFilterNode[] = [];
    for (let i = 0; i < 4; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = Math.min(7600, fs.f[i] * (1 + (brightness - 1) * 0.12));
      // Q:实测 F/BW 偏尖,放宽一点更圆润(人声感)
      bp.Q.value = Math.max(1.2, (fs.f[i] / Math.max(40, fs.bw[i])) * 0.85);
      bp.connect(sum);
      filters.push(bp);
    }
    return { filters, out: sum };
  }

  // ---------- 阶段 1:实时哼鸣 ----------

  // 实时发声:MIDI 音符 + 当前元音(应用全局移调)
  noteOn(midi: number, velocity = 1, when?: number) {
    const ctx = this.engine.ctx;
    const t = when ?? ctx.currentTime;
    const freq = 440 * Math.pow(2, (midi + this.transpose - 69) / 12);
    // 同音重触发:先杀掉旧的
    if (this.active.has(midi)) this.noteOff(midi, true, t);

    const src = this.makeSource(this.currentVowel, freq);
    const usedSpec = !!src.spec;
    const g = ctx.createGain();
    let form: { filters: BiquadFilterNode[]; out: AudioNode } | null = null;
    if (!usedSpec) {
      form = this.makeFormants(this.currentVowel, 0);
      src.out.connect(form.out);
      form.out.connect(g);
    } else {
      src.out.connect(g);
    }

    const a = Math.max(0.005, this.attack);
    const r = Math.max(0.02, this.release);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(velocity, t + a);
    g.gain.setValueAtTime(velocity * 0.9, t + a + 0.15);   // 元音稳态
    g.connect(this.outGain);

    // 气息噪声:白噪声 → 带通(中频)混入
    let noise: AudioBufferSourceNode | null = null;
    let noiseGain: GainNode | null = null;
    if (this.breathiness > 0.01) {
      const nb = this.getNoiseBuffer();
      noise = ctx.createBufferSource();
      noise.buffer = nb;
      noise.loop = true;
      const nbp = ctx.createBiquadFilter();
      nbp.type = "bandpass";
      nbp.frequency.value = 2000;
      nbp.Q.value = 0.5;
      noiseGain = ctx.createGain();
      noiseGain.gain.value = this.breathiness * velocity;
      noise.connect(nbp);
      nbp.connect(noiseGain);
      noiseGain.connect(g);
      noise.start(t);
      noise.stop(t + a + 0.15 + r + 1);
    }

    // 颤音:LFO 调制基频
    if (this.engine.vibrato > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = this.engine.vibratoRate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = freq * 0.004 * this.engine.vibrato;
      lfo.connect(lfoGain);
      for (const o of src.oscs) lfoGain.connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + a + 0.15 + r + 1);
    }

    for (const o of src.oscs) o.start(t);
    const stopAt = t + a + 0.15 + r + 0.2;
    for (const o of src.oscs) o.stop(stopAt);
    this.active.set(midi, { oscs: src.oscs, filters: form ? form.filters : [], gain: g, noise, noiseGain, stopAt });
  }

  noteOff(midi: number, fast = false, when?: number) {
    const v = this.active.get(midi);
    if (!v) return;
    const ctx = this.engine.ctx;
    const t = when ?? ctx.currentTime;
    const r = fast ? 0.03 : Math.max(0.02, this.release);
    v.gain.gain.cancelAndHoldAtTime(t);
    v.gain.gain.setTargetAtTime(0, t, r / 3);
    if (v.noiseGain) v.noiseGain.gain.setTargetAtTime(0, t, r / 3);
    this.active.delete(midi);
  }

  allOff() {
    for (const m of [...this.active.keys()]) this.noteOff(m, true);
  }

  // ---------- 阶段 2:拼音朗读 ----------

  // 渲染单个音节(辅音起始 + 元音段),供 speak/playNote 复用
  // tone 给定 → 声调曲线;tone 为 undefined → 固定音高(唱歌,可选颤音)
  // p:每音符参数覆盖(卷帘曲线)——breath 气息 / bright 明亮度 / vib 颤音深度 / vel 力度
  private renderSyllable(o: {
    t: number;                    // 音节起点(秒)
    base: number;                 // 基频 Hz
    c: ConsonantData | null;      // 辅音数据(null = 零声母)
    final: string;
    cDur: number;                 // 辅音段时长
    vDur: number;                 // 元音段时长
    amp: number;
    tone?: number;
    vibrato?: boolean;
    p?: NoteParams;
  }) {
    const ctx = this.engine.ctx;
    const { t, base, c, final, cDur, vDur } = o;
    const p = o.p ?? {};
    const amp = p.vel !== undefined ? 0.4 + 0.6 * p.vel : o.amp;
    const brightness = p.bright !== undefined ? 0.5 + 1.5 * p.bright : this.brightness;
    const sonorant = !!(c && c.voiced);
    const srcStart = sonorant ? t : t + cDur;   // 声带开始(响音从音节头开始)
    const vowelStart = t + cDur;
    const nodes: AudioScheduledSourceNode[] = [];

    // 1) 辅音噪声段(爆破/摩擦;响音不产生噪声)
    if (c && !c.voiced && cDur > 0.012) {
      nodes.push(this.makeNoise(t, c, cDur, amp));
    }

    // 2) 元音:声带(韵母谐波包络波形,按音高动态 → 共振峰锁定)
    const src = this.makeSource(final, base);
    const usedSpec = !!src.spec;

    // 包络:响音 = 鼻化弱起 → 元音;其余 = 快起 → 稳态 → 释放
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, srcStart);
    if (sonorant) {
      const murmurGain = Math.min(0.45, Math.max(0.15, (c?.ratio ?? 0.05) * 5));
      g.gain.linearRampToValueAtTime(murmurGain, srcStart + 0.006);
      g.gain.linearRampToValueAtTime(amp, vowelStart + 0.03);
    } else {
      g.gain.linearRampToValueAtTime(amp, srcStart + 0.025);
    }
    const sustainT = vowelStart + vDur - 0.03;
    if (sustainT > srcStart + 0.045) g.gain.linearRampToValueAtTime(amp * 0.92, sustainT);
    const rel = o.tone === 5 ? 0.05 : 0.09;
    g.gain.linearRampToValueAtTime(0, vowelStart + vDur + rel);
    if (usedSpec) {
      // 韵母波形已含共振峰:直连包络
      src.out.connect(g);
    } else {
      // 兜底(无 spec 的韵母):IIR 共振峰链
      const form = this.makeFormants(final, 0, brightness);
      src.out.connect(form.out);
      this.scheduleFormants(form.filters, final, srcStart, vowelStart, vDur, sonorant);
      form.out.connect(g);
    }
    g.connect(this.outGain);

    // 2.5) 音符气息噪声(卷帘气息曲线):白噪声 → 低通 3k 混入
    const breathAmt = p.breath ?? 0;
    if (breathAmt > 0.01 && vDur > 0.06) {
      const nb = ctx.createBufferSource();
      nb.buffer = this.getNoiseBuffer();
      nb.loop = true;
      const nlp = ctx.createBiquadFilter();
      nlp.type = "lowpass";
      nlp.frequency.value = 3000;
      nlp.Q.value = 0.5;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0, vowelStart + 0.03);
      ng.gain.linearRampToValueAtTime(breathAmt * 0.3 * amp, vowelStart + 0.09);
      ng.gain.linearRampToValueAtTime(0, vowelStart + vDur + rel);
      nb.connect(nlp);
      nlp.connect(ng);
      ng.connect(g);
      nb.start(vowelStart);
      nb.stop(vowelStart + vDur + rel + 0.05);
      nodes.push(nb);
    }

    // 3) 频率:声调曲线(朗读)或固定音高 + 颤音(唱歌)
    // 音高弯曲(pitch 曲线 0-1 → ±1 半音)仅作用于固定音高路径(卷帘)
    const pitchMul = o.tone === undefined && p.pitch !== undefined
      ? Math.pow(2, ((p.pitch - 0.5) * 2) / 12)
      : 1;
    if (o.tone !== undefined) {
      const ratios = VOICE.tones[String(o.tone)] ?? VOICE.tones["1"];
      src.oscs.forEach((osc, idx) => {
        const curve = new Float32Array(ratios.length);
        for (let j = 0; j < ratios.length; j++) curve[j] = base * (idx + 1) * ratios[j];
        osc.frequency.setValueAtTime(curve[0], srcStart);
        osc.frequency.setValueCurveAtTime(curve, srcStart, vDur);
      });
    } else {
      // 歌唱:起音滑入(略低→目标)、尾音下滑、自然颤音 —— 人声的"唱"感
      const slideIn = Math.min(0.085, vDur * 0.22);
      const tail = Math.min(0.07, vDur * 0.16);
      const tEnd = vowelStart + vDur;
      src.oscs.forEach((osc, idx) => {
        const f = base * (idx + 1) * pitchMul;
        osc.frequency.setValueAtTime(f * 0.965, srcStart);
        osc.frequency.linearRampToValueAtTime(f, srcStart + slideIn);
        osc.frequency.setValueAtTime(f, tEnd - tail);
        osc.frequency.linearRampToValueAtTime(f * 0.972, tEnd + rel);
      });
      // 自然颤音(唱歌):滑块调深度,保底人声感
      const vibDepth = this.engine.vibrato * 4 * (0.5 + (p.vib ?? 1) * 0.5) + 0.3;
      if (o.vibrato && vibDepth > 0) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = this.engine.vibratoRate;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = base * 0.004 * vibDepth;
        lfo.connect(lfoGain);
        for (const osc of src.oscs) lfoGain.connect(osc.frequency);
        lfo.start(srcStart);
        lfo.stop(tEnd + rel + 0.05);
        nodes.push(lfo);
      }
    }

    for (const osc of src.oscs) {
      osc.start(srcStart);
      osc.stop(vowelStart + vDur + rel + 0.05);
      nodes.push(osc);
    }
    this.speechNodes.push(...nodes);
  }

  // 朗读整句:按时间轴渲染音素链(标点处自动停顿 + 换气)
  speak(phonemes: Phoneme[], opts: SpeakOpts = {}) {
    this.stopSpeech();
    const base = opts.base ?? VOICE.f0;
    const rate = opts.rate ?? 1;
    const pauses = new Map<number, number>((opts.pauses ?? []).map((p) => [p.at, p.dur]));
    let t = (opts.when ?? this.engine.ctx.currentTime) + 0.04;
    const n = phonemes.length;

    for (let i = 0; i < n; i++) {
      const ph = phonemes[i];
      const c = ph.initial ? VOICE.consonants[ph.initial] : null;
      const last = i === n - 1;
      // 时长:元音(句末 1.35×,轻声 0.16)+ 辅音(实测)
      const vDur = ((ph.tone === 5 ? 0.16 : 0.26) * (last ? 1.35 : 1)) / rate;
      const cDur = c ? c.dur / rate : 0;
      this.renderSyllable({ t, base, c, final: ph.final, cDur, vDur, amp: 0.9, tone: ph.tone });
      t += cDur + vDur + (last ? 0.1 : 0.06) / rate;
      // 标点停顿(静默,自动断句)
      const pause = pauses.get(i);
      if (pause !== undefined) {
        t += pause;
      }
    }
  }

  // 单音符演唱(钢琴卷帘):真人素材字头 + 合成元音延音(滑向下一字音高)→ 连贯演唱
  // 素材加载不及/缺失 → 全合成兜底。nextFreq:下一音符音高(用于滑音连接)
  // p:卷帘参数曲线值(气息/明亮度/颤音/力度/音高)
  playNote(midi: number, final: string, initial: string | null, start: number, dur: number, p?: NoteParams, nextFreq?: number) {
    const freq = 440 * Math.pow(2, (midi + this.transpose - 69) / 12);
    const c = initial ? VOICE.consonants[initial] : null;
    const ph: Phoneme = { initial, final, tone: 1 };
    const pitchSemi = p?.pitch !== undefined ? (p.pitch - 0.5) * 2 : 0;
    // 字头时长:素材只露"字头"(0.16s 或音符 40%,取小)— 变速影响极小,不鸭
    // 音符主体由合成延音承载(共振峰按音高锁定,拉多长都不变音色)
    const headDur = Math.min(0.16, dur * 0.4);
    this.samples.play(ph, freq, start, headDur, p?.vel ?? 1, pitchSemi).then((used) => {
      if (used) {
        const tailT = start + headDur;
        const tailDur = dur - headDur;
        if (tailDur > 0.06) this.renderTail(final, freq, nextFreq, tailT, tailDur, p?.vib ?? 1);
        return;
      }
      const cDur = c ? Math.min(0.09, dur * 0.3) : 0;
      const vDur = Math.max(0.05, dur - cDur);
      this.renderSyllable({
        t: start, base: freq, c, final, cDur, vDur,
        amp: 0.9, vibrato: true, p,
      });
    });
  }

  // 元音延音:音符尾部填充 + 音高滑向下一字(legato)+ 唱歌颤音
  private renderTail(final: string, freq: number, nextFreq: number | undefined, t: number, dur: number, vibScale = 1) {
    const ctx = this.engine.ctx;
    const src = this.makeSource(final, freq);
    const o = src.oscs[0];
    o.frequency.setValueAtTime(freq, t);
    o.frequency.linearRampToValueAtTime(nextFreq ?? freq, t + dur * 0.88);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.68, t + 0.03);
    g.gain.linearRampToValueAtTime(0.62, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.out.connect(g);
    g.connect(this.outGain);
    // 颤音:让延音"活"起来
    const vibDepth = this.engine.vibrato * 3 * (0.5 + vibScale * 0.5) + 0.4;
    if (vibDepth > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = this.engine.vibratoRate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = freq * 0.004 * vibDepth;
      lfo.connect(lfoGain);
      lfoGain.connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.02);
      this.speechNodes.push(lfo);
    }
    o.start(t);
    o.stop(t + dur + 0.02);
    this.speechNodes.push(o);
  }

  // 停止朗读(同时停止哼鸣)
  stopSpeech() {
    this.allOff();
    for (const s of this.speechNodes) {
      try { s.stop(); } catch { /* 已停止 */ }
    }
    this.speechNodes = [];
  }

  // 共振峰频率调度:鼻化段 + 元音 5 点插值(线性渐变,无跳变)
  private scheduleFormants(
    filters: BiquadFilterNode[],
    vowel: string,
    srcStart: number,
    vowelStart: number,
    vDur: number,
    sonorant: boolean,
  ) {
    const setAll = (fs: FormantSet, tt: number) => {
      for (let i = 0; i < 4; i++) {
        filters[i].frequency.setValueAtTime(fs.f[i], tt);
        filters[i].Q.setValueAtTime(fs.f[i] / Math.max(20, fs.bw[i]), tt);
      }
    };
    if (sonorant && vowelStart > srcStart + 0.004) {
      setAll(MURMUR, srcStart);
      const fs0 = formantAt(vowel, 0);
      for (let i = 0; i < 4; i++) {
        filters[i].frequency.linearRampToValueAtTime(fs0.f[i], vowelStart - 0.002);
        filters[i].Q.linearRampToValueAtTime(fs0.f[i] / Math.max(20, fs0.bw[i]), vowelStart - 0.002);
      }
    }
    // 元音段:0/0.25/0.5/0.75/1.0 五点插值
    const fs0 = formantAt(vowel, 0);
    for (let i = 0; i < 4; i++) {
      filters[i].frequency.setValueAtTime(fs0.f[i], vowelStart);
      filters[i].Q.setValueAtTime(fs0.f[i] / Math.max(20, fs0.bw[i]), vowelStart);
    }
    for (const p of [0.25, 0.5, 0.75, 1]) {
      const fs = formantAt(vowel, p);
      for (let i = 0; i < 4; i++) {
        filters[i].frequency.linearRampToValueAtTime(fs.f[i], vowelStart + p * vDur);
        filters[i].Q.linearRampToValueAtTime(fs.f[i] / Math.max(20, fs.bw[i]), vowelStart + p * vDur);
      }
    }
  }

  // 辅音噪声爆发:白噪声 → 实测频带带通 → 短包络
  private makeNoise(t: number, c: NonNullable<typeof VOICE.consonants[string]>, dur: number, amp: number) {
    const ctx = this.engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer();
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    const center = Math.sqrt(c.lo * c.hi);
    bp.frequency.value = center;
    bp.Q.value = Math.min(2, Math.max(0.35, center / Math.max(1, c.hi - c.lo)));
    const g = ctx.createGain();
    const noiseAmp = Math.min(0.6, amp * c.ratio * 1.15);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(noiseAmp, t + 0.008);
    if (dur > 0.022) g.gain.linearRampToValueAtTime(noiseAmp, t + dur - 0.012);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.outGain);
    src.start(t);
    src.stop(t + dur + 0.03);
    return src;
  }

  // 共享白噪声缓冲(1 秒,循环使用)
  private getNoiseBuffer(): AudioBuffer {
    if (!this.noiseBuf) {
      const ctx = this.engine.ctx;
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }
}
