// ============ TTS 整句合成视图 ============
// 示例歌曲歌词 → edge-tts 整句合成 → 本地缓存(cache/tts/)→ 播放
// 说话人可选;合成结果按 说话人+文本 缓存,重复播放直接读缓存

import { invoke } from "@tauri-apps/api/core";
import { AudioEngine } from "../core/AudioEngine";

const SONG_TEXT = "两只老虎 两只老虎 跑得快 跑得快 一只没有眼睛 一只没有尾巴 真奇怪 真奇怪";

export class TtsView {
  private engine: AudioEngine;
  private voice: HTMLSelectElement;
  private btn: HTMLButtonElement;
  private status: HTMLElement;
  private playing: AudioBufferSourceNode | null = null;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    this.voice = document.getElementById("tts-voice") as HTMLSelectElement;
    this.btn = document.getElementById("tts-song") as HTMLButtonElement;
    this.status = document.getElementById("tts-status") as HTMLElement;
    this.btn.addEventListener("click", () => this.playSong());
    // 浏览器环境(无 Tauri)提示
    if (!("__TAURI_INTERNALS__" in window)) {
      this.status.textContent = "TTS 需桌面应用";
    }
  }

  private async playSong() {
    const voice = this.voice.value;
    this.btn.disabled = true;
    this.status.textContent = "合成中…";
    try {
      const bytes = await invoke<number[]>("tts_synthesize", {
        text: SONG_TEXT,
        voice,
        ratePercent: -10,
      });
      const arr = new Uint8Array(bytes);
      const buf = await this.engine.ctx.decodeAudioData(arr.buffer.slice(0));
      // 停止旧的 TTS 播放
      try { this.playing?.stop(); } catch { /* 已结束 */ }
      const src = this.engine.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.engine.ctx.createGain();
      g.gain.value = 0.9;
      src.connect(g);
      g.connect(this.engine.master);
      src.start();
      this.playing = src;
      this.status.textContent = `播放中 ${buf.duration.toFixed(1)}s · 已缓存,下次秒开`;
    } catch (e) {
      this.status.textContent = "失败: " + String(e);
    } finally {
      this.btn.disabled = false;
    }
  }
}
