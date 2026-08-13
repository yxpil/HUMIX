// ============ 琴键视图:鼠标 + 电脑键盘输入 ============
// 数据:白键 MIDI 号列表;黑键在相邻白键之间

import { VoiceEngine } from "../core/VoiceEngine";

// 电脑键盘映射(数字行黑键 + QWERTY 白键),基准 C3-C5
const KEYMAP: Record<string, number> = {
  // 白键:C3(48) 起
  KeyA: 48, KeyS: 50, KeyD: 52, KeyF: 53, KeyG: 55, KeyH: 57, KeyJ: 59,
  KeyK: 60, KeyL: 62, Semicolon: 64, Quote: 65,
  // 黑键:数字行
  Digit1: 49, Digit2: 51, Digit3: 54, Digit4: 56, Digit5: 58,
  Digit6: 61, Digit7: 63, Digit8: 66, Digit9: 68, Digit0: 70,
};

const WHITE_MIDI = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83]; // C3-C6
const BLACK_MIDI = [49, 51, 54, 56, 58, 61, 63, 66, 68, 70, 73, 75, 78, 80, 82];

export class KeyboardView {
  private voice: VoiceEngine;
  private held = new Map<number, boolean>();   // midi → 按住中
  private keyEls = new Map<number, HTMLElement>();
  /** 录制钩子:任何输入(鼠标/电脑键盘/MIDI)按下/松开都会回调(down=true 按下) */
  onNoteEvent: ((midi: number, down: boolean) => void) | null = null;

  constructor(voice: VoiceEngine) {
    this.voice = voice;
    this.build();
    this.bindInput();
  }

  private build() {
    const kb = document.getElementById("keyboard") as HTMLElement;
    kb.innerHTML = "";
    const n = WHITE_MIDI.length;
    const whiteW = 100 / n;
    // 白键
    WHITE_MIDI.forEach((midi, i) => {
      const el = document.createElement("div");
      el.className = "key white";
      el.style.left = i * whiteW + "%";
      el.style.width = whiteW + "%";
      el.dataset.midi = String(midi);
      this.bindKey(el, midi);
      kb.appendChild(el);
      this.keyEls.set(midi, el);
    });
    // 黑键:骑跨在两个白键交界(音符在相邻白键之间)
    BLACK_MIDI.forEach((midi) => {
      const left = WHITE_MIDI.indexOf(midi - 1);   // 左侧白键索引
      if (left < 0) return;
      const el = document.createElement("div");
      el.className = "key black";
      el.style.left = (left + 1) * whiteW - whiteW * 0.31 + "%";
      el.style.width = whiteW * 0.62 + "%";
      el.dataset.midi = String(midi);
      this.bindKey(el, midi);
      kb.appendChild(el);
      this.keyEls.set(midi, el);
    });
  }

  private bindKey(el: HTMLElement, midi: number) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.press(midi);
    });
    el.addEventListener("pointerup", () => this.release(midi));
    el.addEventListener("pointerleave", () => this.release(midi));
  }

  private bindInput() {
    // 电脑键盘
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.repeat) return;
      const midi = KEYMAP[e.code];
      if (midi === undefined) return;
      e.preventDefault();
      if (!this.held.has(midi)) {
        this.held.set(midi, true);
        this.press(midi);
      }
    });
    window.addEventListener("keyup", (e) => {
      const midi = KEYMAP[e.code];
      if (midi === undefined) return;
      if (this.held.delete(midi)) this.release(midi);
    });
    window.addEventListener("blur", () => {
      for (const m of [...this.held.keys()]) this.release(m);
      this.held.clear();
    });
  }

  // 供 MIDI 输入/钢琴卷帘调用(与鼠标/键盘输入同一路径)
  press(midi: number, velocity = 0.8) {
    this.voice.noteOn(midi, velocity);
    this.keyEls.get(midi)?.classList.add("active");
    const led = document.getElementById("in-led");
    if (led) { led.classList.add("on"); setTimeout(() => led.classList.remove("on"), 80); }
    this.onNoteEvent?.(midi, true);
  }

  release(midi: number) {
    this.voice.noteOff(midi);
    this.keyEls.get(midi)?.classList.remove("active");
    this.onNoteEvent?.(midi, false);
  }

  // 供钢琴卷帘/MIDI 模块调用
  get voiceEngine() { return this.voice; }
}
