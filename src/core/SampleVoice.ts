// ============ 素材语音库:OK/ 420 单音节 wav 按拼音播放 ============
// 歌词拼音 → SYLLABLE_FILES 找素材 → 从语音起点播放(裁静音)→ 变速变调匹配音高
// 相邻音符靠包络(快起 + 尾 fade)自然衔接,避免拼接生硬
// 懒加载 + 缓存;Tauri 环境可用,浏览器环境自动降级(返回 false 由合成兜底)

import { invoke } from "@tauri-apps/api/core";
import { SYLLABLE_FILES } from "../pinyin/syllableFiles";
import { VOICE } from "./VoiceData";
import type { Phoneme } from "../pinyin/PinyinParser";
import type { AudioEngine } from "./AudioEngine";

export const OK_DIR = "C:/Users/Admin/OneDrive/Desktop/HUMIX/OK_TTS";

export class SampleVoice {
  private engine: AudioEngine;
  private cache = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  available = false;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    this.init();
  }

  private async init() {
    try {
      const files = await invoke<string[]>("list_wavs", { path: OK_DIR });
      this.available = files.length > 100;
    } catch {
      this.available = false;
    }
  }

  // 歌词音素 → 素材:完整声调 → 平调 → 韵母平调
  private findFile(ph: Phoneme) {
    const syl = (ph.initial ?? "") + ph.final;
    return (
      SYLLABLE_FILES[syl + ph.tone] ??
      SYLLABLE_FILES[syl + "1"] ??
      (ph.initial ? SYLLABLE_FILES[ph.final + "1"] ?? null : null)
    );
  }

  private load(name: string): Promise<AudioBuffer | null> {
    const hit = this.cache.get(name);
    if (hit) return Promise.resolve(hit);
    const pending = this.loading.get(name);
    if (pending) return pending;
    const p = (async () => {
      try {
        const b64 = await invoke<string>("read_file_b64", { path: OK_DIR + "/" + name });
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const copy = new Uint8Array(bytes);
        const buf = await this.engine.ctx.decodeAudioData(copy.buffer);
        this.cache.set(name, buf);
        return buf;
      } catch {
        return null;
      } finally {
        this.loading.delete(name);
      }
    })();
    this.loading.set(name, p);
    return p;
  }

  // 播放一个音节素材(变速变调匹配 midi 音高);返回是否真的用素材发声
  // 加载来不及(距 start < 90ms)时返回 false,由调用方走合成兜底
  async play(ph: Phoneme, freq: number, start: number, dur: number, vel = 1, pitchSemi = 0): Promise<boolean> {
    if (!this.available) return false;
    const s = this.findFile(ph);
    if (!s) return false;
    const buf = await this.load(s.f);
    if (!buf) return false;
    if (start - this.engine.ctx.currentTime < 0.09) return false;
    const ctx = this.engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // 变速:素材是说话音高(VOICE.f0),目标音符音高 → playbackRate
    let rate = freq / VOICE.f0;
    if (pitchSemi !== 0) rate *= Math.pow(2, pitchSemi / 12);
    src.playbackRate.value = rate;
    // 米老鼠补偿:变速会让共振峰跟着音高移动(鸭子感),用 shelf 滤波拉回
    // 高音(rate>1):抬低频/压高频;低音反向。量 = 12*log2(rate),上限 ±6dB
    const comp = Math.max(-6, Math.min(6, 12 * Math.log2(rate)));
    let node: AudioNode = src;
    if (Math.abs(comp) > 0.5) {
      const lo = ctx.createBiquadFilter();
      lo.type = "lowshelf";
      lo.frequency.value = 450;
      lo.gain.value = comp;
      const hi = ctx.createBiquadFilter();
      hi.type = "highshelf";
      hi.frequency.value = 2400;
      hi.gain.value = -comp;
      src.connect(lo);
      lo.connect(hi);
      node = hi;
    }
    // 素材语音时长(变速后)
    const sDur = s.d / rate;
    // 播放时长 = 音符时长,但不超过素材语音(素材播完自然收)
    const playDur = Math.max(0.12, Math.min(dur, sDur + 0.05));
    const amp = Math.min(1.1, 0.9 * vel);
    const g = ctx.createGain();
    const release = Math.min(0.08, playDur * 0.22);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(amp, start + 0.02);          // 快起(字头清晰)
    g.gain.linearRampToValueAtTime(amp, start + playDur - release);
    g.gain.linearRampToValueAtTime(0, start + playDur);         // 尾 fade(衔接自然)
    node.connect(g);
    g.connect(this.engine.master);
    src.start(start, s.o);
    src.stop(start + playDur + 0.02);
    return true;
  }
}