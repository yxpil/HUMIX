// ============ 钢琴卷帘 v3(认真版,参考 SynthV/ACE 交互) ============
// 编辑能力:添加/拖移/缩放音符 · 多选(Shift 点选/框选)· 复制粘贴 · 撤销重做
//         双击原位编辑歌词 · 橡皮擦除 · 参数曲线(气息/明亮度/颤音/力度/音高)
//         换气标记(右键空白切换)· 平移(空白拖动)· 中心缩放(滚轮)
// 持久化:localStorage 自动保存

import { AudioEngine } from "../core/AudioEngine";
import { VoiceEngine, NoteParams } from "../core/VoiceEngine";
import { Sequence, Note, ParamKey, ParamPoint } from "../seq/Sequence";
import { parseSyllable } from "../pinyin/PinyinParser";
import { HANZI } from "../pinyin/hanziMap";
import { parseSmf } from "../seq/SmfParser";
import { SAMPLE_SONG } from "../seq/sampleSong";
import { invoke } from "@tauri-apps/api/core";
import { KeyboardView } from "./KeyboardView";

const LOW_MIDI = 48;
const HIGH_MIDI = 84;
const PX_PER_KEY = 16;     // 行高(放大,卷帘可上下滚动)
const KEY_LABEL_W = 64;
const RULER_H = 26;
const PARAM_H = 72;
const MIN_BEAT = 0.25;
const BLACK = new Set([1, 3, 6, 8, 10]);

const PARAM_NAMES: Record<ParamKey, string> = {
  breath: "气息", bright: "明亮度", vib: "颤音", vel: "力度", pitch: "音高弯曲",
};

interface DragState {
  noteIds: number[];
  dx0: number;
  dy0: number;
  oStart: Map<number, number>;
  oMidi: Map<number, number>;
  oDur: Map<number, number>;
  mode: "move" | "resize";
  moved: boolean;
}

interface PanState {
  x: number;
  y: number;
  sl: number;
  st: number;
  pendingNote: Note | null;
}

export class PianoRollView {
  private engine: AudioEngine;
  private voice: VoiceEngine;
  private keyboard: KeyboardView;
  private seq = new Sequence();
  private canvas: HTMLCanvasElement;
  private wrap: HTMLElement;
  private lyricInput: HTMLInputElement;
  private g: CanvasRenderingContext2D;
  private pxPerBeat = 60;   // 默认缩放:1 拍 60px(放大,不用放大镜)
  private bpm = 120;
  private selectedIds = new Set<number>();
  private drag: DragState | null = null;
  private pan: PanState | null = null;
  private rubber: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private paramDrag: { key: ParamKey; idx: number } | null = null;
  private currentParam: ParamKey = "breath";
  private tool: "pencil" | "eraser" = "pencil";
  private playing = false;
  private playT0 = 0;
  private playHead = -1;
  private raf = 0;
  private lastW = 0;
  private lastH = 0;
  private clip: { midi: number; start: number; dur: number; lyric: string }[] = [];
  private lyricOverlay: HTMLInputElement | null = null;

  // ---------- 撤销/重做 ----------
  private history: string[] = [];
  private historyIdx = -1;
  private saveTimer = 0;

  constructor(engine: AudioEngine, voice: VoiceEngine, keyboard: KeyboardView) {
    this.engine = engine;
    this.voice = voice;
    this.keyboard = keyboard;
    this.canvas = document.getElementById("roll-canvas") as HTMLCanvasElement;
    this.wrap = this.canvas.parentElement as HTMLElement;
    this.lyricInput = document.getElementById("roll-lyric") as HTMLInputElement;
    this.g = this.canvas.getContext("2d")!;
    this.bindToolbar();
    this.bindCanvas();
    this.bindKeys();
    new ResizeObserver(() => { this.resize(); this.draw(); }).observe(this.wrap);
    this.loadProject();
    this.resize();
    this.draw();
  }

  // ---------- 坐标 ----------
  private xToBeat(x: number) { return (x - KEY_LABEL_W) / this.pxPerBeat; }
  private beatToX(b: number) { return KEY_LABEL_W + b * this.pxPerBeat; }
  private midiToY(m: number) { return RULER_H + (HIGH_MIDI - 1 - m) * PX_PER_KEY; }
  private yToMidi(y: number) {
    const row = Math.floor((y - RULER_H) / PX_PER_KEY);
    return Math.max(LOW_MIDI, Math.min(HIGH_MIDI - 1, HIGH_MIDI - 1 - row));
  }
  private get contentH() { return RULER_H + (HIGH_MIDI - LOW_MIDI) * PX_PER_KEY; }
  private paramY(v: number) { return this.contentH + PARAM_H - 6 - v * (PARAM_H - 12); }
  private vFromY(y: number) {
    return Math.max(0, Math.min(1, (this.contentH + PARAM_H - 6 - y) / (PARAM_H - 12)));
  }

  // ---------- 尺寸 ----------
  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(320, this.beatToX(Math.max(8, this.seq.length)) + 80);
    const ch = this.contentH + PARAM_H;
    const w = Math.max(cw, this.wrap.clientWidth);
    const h = Math.max(ch, this.wrap.clientHeight);
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- 渲染 ----------
  private draw() {
    const g = this.g;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    const contentH = this.contentH;
    g.fillStyle = "#0f241a";
    g.fillRect(0, 0, w, h);
    // 半音行:C 行微亮,黑键行深
    for (let m = LOW_MIDI; m < HIGH_MIDI; m++) {
      if (BLACK.has(m % 12)) {
        g.fillStyle = "rgba(27, 67, 50, 0.5)";
        g.fillRect(KEY_LABEL_W, this.midiToY(m), w - KEY_LABEL_W, PX_PER_KEY);
      } else if (m % 12 === 0) {
        g.fillStyle = "rgba(64, 145, 108, 0.10)";
        g.fillRect(KEY_LABEL_W, this.midiToY(m), w - KEY_LABEL_W, PX_PER_KEY);
      }
    }
    // 网格三层:16分 / 拍 / 小节
    const beats = Math.max(8, this.seq.length) + 2;
    for (let b = 0; b <= beats * 4; b++) {
      const x = Math.round(KEY_LABEL_W + b * 0.25 * this.pxPerBeat) + 0.5;
      if (b % 4 === 0) continue;   // 拍线下面画
      g.strokeStyle = "rgba(107,144,128,0.07)";
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, contentH); g.stroke();
    }
    for (let b = 0; b <= beats; b++) {
      const x = Math.round(this.beatToX(b)) + 0.5;
      const isBar = b % 4 === 0;
      g.strokeStyle = isBar ? "rgba(107,144,128,0.45)" : "rgba(107,144,128,0.16)";
      g.lineWidth = isBar ? 1.3 : 1;
      g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, contentH); g.stroke();
    }
    // 标尺
    g.fillStyle = "#1b4332";
    g.fillRect(0, 0, w, RULER_H);
    g.fillStyle = "#8fa89a";
    g.font = "10px Segoe UI";
    for (let b = 0; b <= beats; b++) {
      g.fillText(String(b % 4 === 0 ? b / 4 + 1 : b), this.beatToX(b) + 3, RULER_H - 6);
    }
    // 音高标签区
    g.fillStyle = "#0f241a";
    g.fillRect(0, RULER_H, KEY_LABEL_W, contentH - RULER_H);
    g.textAlign = "right";
    for (let m = LOW_MIDI; m < HIGH_MIDI; m += 12) {
      g.fillStyle = "#95d5b2";
      g.font = "10px Segoe UI";
      g.fillText(`C${Math.floor(m / 12) - 1}`, KEY_LABEL_W - 6, this.midiToY(m) + PX_PER_KEY * 0.65);
    }
    g.textAlign = "left";
    // 音符块(第一遍:全部块,文字最后统一画在最上层)
    const playingNote = this.noteAt(this.playHead);
    for (const n of this.seq.sorted()) {
      const x = this.beatToX(n.start);
      const y = this.midiToY(n.midi);
      const nw = Math.max(8, n.dur * this.pxPerBeat - 2);
      const isSel = this.selectedIds.has(n.id);
      const isPlay = playingNote?.id === n.id;
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.beginPath(); g.roundRect(x + 1, y + 2, nw, PX_PER_KEY - 3, 5); g.fill();
      const grad = g.createLinearGradient(0, y, 0, y + PX_PER_KEY);
      if (isSel) {
        grad.addColorStop(0, "#b7e6c9"); grad.addColorStop(1, "#7bc49c");
      } else {
        grad.addColorStop(0, "#4fae85"); grad.addColorStop(1, "#2d6a4f");
      }
      g.fillStyle = grad;
      g.beginPath(); g.roundRect(x, y + 1, nw, PX_PER_KEY - 3, 5); g.fill();
      if (isPlay) {
        g.strokeStyle = "#d62828";
        g.lineWidth = 2;
        g.beginPath(); g.roundRect(x - 1, y, nw + 2, PX_PER_KEY - 1, 6); g.stroke();
      }
    }
    // 歌词文字(第二遍:永远在最上层,深色描边保证清晰)
    g.font = "13px Segoe UI";
    g.textBaseline = "middle";
    for (const n of this.seq.sorted()) {
      if (!n.lyric) continue;
      const x = this.beatToX(n.start);
      const y = this.midiToY(n.midi);
      const nw = Math.max(8, n.dur * this.pxPerBeat - 2);
      const isSel = this.selectedIds.has(n.id);
      const label = n.lyric.length > 8 ? n.lyric.slice(0, 8) : n.lyric;
      const tx = x + 4;
      const ty = y + PX_PER_KEY / 2;
      g.lineWidth = 3;
      g.strokeStyle = "rgba(10, 26, 19, 0.85)";
      g.strokeText(label, tx, ty, Math.max(12, nw - 8));
      g.fillStyle = isSel ? "#0a1a13" : "#f0faf3";
      g.fillText(label, tx, ty, Math.max(12, nw - 8));
    }
    g.textBaseline = "alphabetic";
    // 框选矩形
    if (this.rubber) {
      const rx = Math.min(this.rubber.x0, this.rubber.x1);
      const ry = Math.min(this.rubber.y0, this.rubber.y1);
      const rw = Math.abs(this.rubber.x1 - this.rubber.x0);
      const rh = Math.abs(this.rubber.y1 - this.rubber.y0);
      g.fillStyle = "rgba(149, 213, 178, 0.15)";
      g.fillRect(rx, ry, rw, rh);
      g.strokeStyle = "rgba(149, 213, 178, 0.6)";
      g.lineWidth = 1;
      g.strokeRect(rx, ry, rw, rh);
    }
    // 参数区
    this.drawParams(g, w, contentH);
    // 播放头
    if (this.playing && this.playHead >= 0) {
      const x = Math.round(this.beatToX(this.playHead)) + 0.5;
      g.strokeStyle = "#d62828";
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
  }

  private drawParams(g: CanvasRenderingContext2D, w: number, contentH: number) {
    const key = this.currentParam;
    const pts = this.seq.params[key];
    g.fillStyle = "#0d2119";
    g.fillRect(0, contentH, w, PARAM_H);
    g.strokeStyle = "rgba(107,144,128,0.3)";
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, contentH + 0.5); g.lineTo(w, contentH + 0.5); g.stroke();
    g.strokeStyle = "rgba(107,144,128,0.22)";
    g.setLineDash([2, 4]);
    g.beginPath(); g.moveTo(0, this.paramY(0.5)); g.lineTo(w, this.paramY(0.5)); g.stroke();
    g.setLineDash([]);
    if (pts.length) {
      g.strokeStyle = "#95d5b2";
      g.lineWidth = 1.6;
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = this.beatToX(pts[i].t);
        const y = this.paramY(pts[i].v);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      for (const p of pts) {
        g.fillStyle = "#95d5b2";
        g.beginPath(); g.arc(this.beatToX(p.t), this.paramY(p.v), 4, 0, Math.PI * 2); g.fill();
      }
    }
    g.fillStyle = "#8fa89a";
    g.font = "11px Segoe UI";
    g.fillText(`曲线:${PARAM_NAMES[key]} (点击加点/拖节点/双击删)`, 8, contentH + 14);
    const v = this.seq.paramAt(key, Math.max(0, this.playHead));
    g.fillStyle = "#95d5b2";
    g.fillText(`值 ${v === null ? "默认" : Math.round(v * 100) + "%"}`, 8, contentH + PARAM_H - 6);
  }

  // ---------- 选中 ----------
  private get selected(): Note | null {
    for (const n of this.seq.notes) if (this.selectedIds.has(n.id)) return n;
    return null;
  }

  private selectNote(note: Note | null, additive = false) {
    if (additive && note) {
      if (this.selectedIds.has(note.id)) this.selectedIds.delete(note.id);
      else this.selectedIds.add(note.id);
    } else {
      this.selectedIds.clear();
      if (note) this.selectedIds.add(note.id);
    }
    this.updateInfo();
    this.draw();
  }

  private updateInfo() {
    const info = document.getElementById("note-info");
    const n = this.selected;
    if (n && info) {
      info.textContent = `${this.noteName(n.midi)} · 第 ${n.start} 拍起 · 长 ${n.dur} 拍${n.lyric ? ` · 歌词 ${n.lyric}` : ""}${this.selectedIds.size > 1 ? ` · 已选 ${this.selectedIds.size} 个` : ""}`;
    } else if (info) {
      info.textContent = "";
    }
    if (n && this.lyricInput !== document.activeElement) {
      this.lyricInput.value = n.lyric;
    } else if (!n) {
      this.lyricInput.value = "";
    }
  }

  private noteName(midi: number): string {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    return names[midi % 12] + (Math.floor(midi / 12) - 1);
  }

  // 点击歌词文字判定(音符块内文字区域)
  private hitLyricText(x: number, y: number, note: Note): boolean {
    if (!note.lyric) return false;
    const ny = this.midiToY(note.midi);
    if (y < ny || y > ny + PX_PER_KEY) return false;
    const g = this.g;
    g.font = "13px Segoe UI";
    const label = note.lyric.length > 8 ? note.lyric.slice(0, 8) : note.lyric;
    const tw = g.measureText(label).width;
    const tx = this.beatToX(note.start) + 4;
    return x >= tx && x <= tx + tw + 4;
  }

  // 单音轨道:删除与 [start, start+dur) 重叠的旧音符(保留先开始的)
  private clearOverlap(start: number, dur: number) {
    for (const n of [...this.seq.notes]) {
      if (n.start + n.dur > start && n.start < start + dur) {
        this.seq.remove(n.id);
        this.selectedIds.delete(n.id);
      }
    }
  }

  // 双击音符:在音符位置弹出输入框直接标字(边打边显示在音符上)
  private editLyric(note: Note) {
    this.lyricOverlay?.remove();
    const input = document.createElement("input");
    input.className = "lyric-overlay";
    input.value = note.lyric;
    input.style.left = Math.max(KEY_LABEL_W + 2, this.beatToX(note.start) + 2) + "px";
    input.style.top = this.midiToY(note.midi) + 2 + "px";
    input.style.width = Math.max(48, Math.min(200, note.dur * this.pxPerBeat - 6)) + "px";
    input.style.height = (PX_PER_KEY - 4) + "px";
    const commit = () => {
      if (!input.parentElement) return;
      note.lyric = input.value.trim();
      input.remove();
      this.lyricOverlay = null;
      this.updateInfo();
      this.snapshot();
      this.draw();
      this.scheduleSave();
    };
    // 输入中实时写回并重绘(歌词即时出现在音符上)
    input.addEventListener("input", () => {
      note.lyric = input.value;
      this.draw();
    });
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") {
        input.remove();
        this.lyricOverlay = null;
        this.draw();
      }
    });
    input.addEventListener("blur", commit);
    this.wrap.appendChild(input);
    this.lyricOverlay = input;
    input.focus();
    input.select();
  }

  // ---------- 参数曲线 ----------
  private paramsAt(beat: number): NoteParams {
    const p: NoteParams = {};
    const b = this.seq.paramAt("breath", beat);
    if (b !== null) p.breath = b;
    const br = this.seq.paramAt("bright", beat);
    if (br !== null) p.bright = br;
    const vi = this.seq.paramAt("vib", beat);
    if (vi !== null) p.vib = vi;
    const ve = this.seq.paramAt("vel", beat);
    if (ve !== null) p.vel = ve;
    const pi = this.seq.paramAt("pitch", beat);
    if (pi !== null) p.pitch = pi;
    return p;
  }

  // ---------- 播放(单音:同一时刻只唱一个音,重叠的后音跳过) ----------
  // 播放按钮 = 卷帘演唱(中文歌词转拼音发音);TTS 由顶栏"TTS 歌曲"按钮单独触发
  play() {
    if (this.playing) return;
    this.engine.resume();
    this.voice.stopSpeech();
    const secPerBeat = 60 / this.bpm;
    const t0 = this.engine.ctx.currentTime + 0.15;
    const all = this.seq.sorted();
    let lastEnd = -1;
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (n.start < lastEnd - 0.01) continue;   // 与前一音符重叠 → 跳过(单音轨)
      lastEnd = n.start + n.dur;
      const next = all[i + 1];
      const ph = this.syllableOf(n.lyric);
      this.voice.playNote(
        n.midi,
        ph?.final ?? this.voice.currentVowel,
        ph?.initial ?? null,
        t0 + n.start * secPerBeat,
        n.dur * secPerBeat,
        this.paramsAt(n.start),
        next ? 440 * Math.pow(2, (next.midi + this.voice.transpose - 69) / 12) : undefined,
      );
    }
    this.playing = true;
    this.playT0 = t0;
    this.playHead = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.voice.stopSpeech();
    this.playHead = -1;
    this.draw();
  }

  private tick = () => {
    const secPerBeat = 60 / this.bpm;
    this.playHead = (this.engine.ctx.currentTime - this.playT0) / secPerBeat;
    if (this.playHead > this.seq.length + 0.6) {
      this.stop();
      return;
    }
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  // 歌词 → 音素:汉字自动转拼音(示例歌曲/用户输入中文都能唱)
  private syllableOf(lyric: string) {
    if (!lyric) return null;
    if (/[\u4e00-\u9fff]/.test(lyric)) {
      const pinyin = [...lyric].map((ch) => HANZI[ch] ?? "").join("");
      return parseSyllable(pinyin);
    }
    return parseSyllable(lyric);
  }

  private noteAt(beat: number): Note | null {
    if (beat < 0) return null;
    for (const n of this.seq.notes) {
      if (beat >= n.start && beat < n.start + n.dur) return n;
    }
    return null;
  }

  private preview(n: Note) {
    const ph = this.syllableOf(n.lyric);
    const now = this.engine.ctx.currentTime;
    this.voice.playNote(
      n.midi,
      ph?.final ?? this.voice.currentVowel,
      ph?.initial ?? null,
      now + 0.02,
      0.5,
      this.paramsAt(n.start),
    );
  }

  // ---------- 撤销/重做/持久化 ----------
  private serialize() {
    return { bpm: this.bpm, notes: this.seq.notes, breaths: this.seq.breaths, params: this.seq.params };
  }

  private snapshot() {
    this.history = this.history.slice(0, this.historyIdx + 1);
    this.history.push(JSON.stringify(this.serialize()));
    if (this.history.length > 80) this.history.shift();
    this.historyIdx = this.history.length - 1;
  }

  private applyState(s: string) {
    const d = JSON.parse(s) as { bpm?: number; notes?: Note[]; breaths?: number[]; params?: Record<string, ParamPoint[]> };
    this.seq.restore(d.notes ?? [], d.breaths ?? [], d.params ?? {});
    if (d.bpm) {
      this.bpm = d.bpm;
      const bpmEl = document.getElementById("roll-bpm") as HTMLInputElement;
      bpmEl.value = String(d.bpm);
      document.getElementById("roll-bpm-val")!.textContent = String(d.bpm);
    }
    this.selectedIds.clear();
    this.updateInfo();
    this.resize();
    this.draw();
    this.scheduleSave();
  }

  private undo() {
    if (this.historyIdx > 0) {
      this.historyIdx--;
      this.applyState(this.history[this.historyIdx]);
    }
  }

  private redo() {
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.applyState(this.history[this.historyIdx]);
    }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem("humix-project", JSON.stringify(this.serialize()));
      } catch { /* 忽略 */ }
    }, 300);
  }

  private loadProject() {
    try {
      const raw = localStorage.getItem("humix-project");
      if (!raw) return;
      this.applyState(raw);
    } catch { /* 损坏则忽略 */ }
  }

  // ---------- 录制(MIDI 键盘/电脑键盘/琴键实时录音符) ----------
  private recording = false;
  private recT0 = 0;
  private recNotes = new Map<number, number>();   // midi → 起拍

  private handleRecNote = (midi: number, down: boolean) => {
    if (!this.recording) return;
    const beat = ((performance.now() - this.recT0) / 1000) * (this.bpm / 60);
    if (down) {
      if (!this.recNotes.has(midi)) this.recNotes.set(midi, beat);
    } else {
      const start = this.recNotes.get(midi);
      if (start === undefined) return;
      this.recNotes.delete(midi);
      const dur = Math.max(MIN_BEAT, Math.round((beat - start) / MIN_BEAT) * MIN_BEAT);
      this.clearOverlap(start, dur);
      this.seq.add(midi, this.snapBeat(start), dur, "");
      this.snapshot();
      this.resize();
      this.draw();
      this.scheduleSave();
    }
  };

  private toggleRecording() {
    const btn = document.getElementById("roll-record") as HTMLButtonElement;
    if (this.recording) {
      // 停止:未松开的音符补一个默认时长
      for (const [midi, start] of this.recNotes) {
        this.clearOverlap(start, 1);
        this.seq.add(midi, this.snapBeat(start), 1, "");
      }
      this.recNotes.clear();
      this.recording = false;
      this.keyboard.onNoteEvent = null;
      btn.classList.remove("recording");
      btn.textContent = "录制";
      this.snapshot();
      this.resize();
      this.draw();
      this.scheduleSave();
    } else {
      this.stop();
      this.recording = true;
      this.recT0 = performance.now();
      this.recNotes.clear();
      this.keyboard.onNoteEvent = this.handleRecNote;
      btn.classList.add("recording");
      btn.textContent = "停止录制";
    }
  }

  // ---------- 全部歌词面板 ----------
  private openLyricPanel() {
    const panel = document.getElementById("lyric-panel") as HTMLElement;
    const ta = document.getElementById("lp-text") as HTMLTextAreaElement;
    const sorted = this.seq.sorted();
    ta.value = sorted.map((n) => `${n.start}\t${n.lyric}`).join("\n");
    panel.hidden = false;
    ta.focus();
  }

  private applyLyricPanel() {
    const ta = document.getElementById("lp-text") as HTMLTextAreaElement;
    this.snapshot();
    for (const line of ta.value.split("\n")) {
      const m = line.trim().match(/^([\d.]+)\s+(.*)$/);
      if (!m) continue;
      const beat = parseFloat(m[1]);
      const lyric = m[2].trim();
      const n = this.seq.notes.find((nn) => Math.abs(nn.start - beat) < 0.01);
      if (n) n.lyric = lyric;
    }
    document.getElementById("lyric-panel")!.hidden = true;
    this.updateInfo();
    this.draw();
    this.scheduleSave();
  }

  // 载入内置示例歌曲(两只老虎)
  private loadSampleSong() {
    this.stop();
    this.snapshot();
    this.seq.clear();
    SAMPLE_SONG.notes.forEach((n) => {
      this.seq.add(n.midi, n.start, n.dur, n.lyric);
    });
    this.bpm = SAMPLE_SONG.bpm;
    const bpmEl = document.getElementById("roll-bpm") as HTMLInputElement;
    bpmEl.value = String(SAMPLE_SONG.bpm);
    document.getElementById("roll-bpm-val")!.textContent = String(SAMPLE_SONG.bpm);
    this.selectedIds.clear();
    this.updateInfo();
    this.resize();
    this.draw();
    this.scheduleSave();
  }

  // ---------- 交互 ----------
  private bindCanvas() {
    this.canvas.addEventListener("pointerdown", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const contentH = this.contentH;
      // 参数区
      if (y >= contentH) {
        const key = this.currentParam;
        const pts = this.seq.params[key];
        for (let i = 0; i < pts.length; i++) {
          if (Math.hypot(this.beatToX(pts[i].t) - x, this.paramY(pts[i].v) - y) < 7) {
            this.paramDrag = { key, idx: i };
            return;
          }
        }
        const pt: ParamPoint = { t: this.snapBeat(this.xToBeat(x)), v: this.vFromY(y) };
        pts.push(pt);
        pts.sort((a, b) => a.t - b.t);
        this.paramDrag = { key, idx: pts.indexOf(pt) };
        this.snapshot();
        this.draw();
        return;
      }
      if (y < RULER_H) return;
      // 橡皮
      if (this.tool === "eraser") {
        const note = this.hitNote(x, y);
        if (note) {
          this.seq.remove(note.id);
          this.selectedIds.delete(note.id);
          this.snapshot();
          this.updateInfo();
        } else {
          const beat = this.xToBeat(x);
          const bi = this.seq.breaths.findIndex((b) => Math.abs(b - beat) < 0.15);
          if (bi >= 0) { this.seq.breaths.splice(bi, 1); this.snapshot(); }
        }
        this.resize();
        this.draw();
        return;
      }
      const note = this.hitNote(x, y);
      if (note) {
        // 点击歌词文字 → 直接编辑发音
        if (this.hitLyricText(x, y, note)) {
          this.selectNote(note);
          this.editLyric(note);
          return;
        }
        // 音符:Shift = 增减多选;否则单选
        this.selectNote(note, e.shiftKey);
        if (this.selectedIds.has(note.id) && this.selectedIds.size === 1) this.preview(note);
        const ids = [...this.selectedIds];
        this.drag = {
          noteIds: ids,
          dx0: x, dy0: y,
          oStart: new Map(ids.map((id) => [id, this.seq.notes.find((nn) => nn.id === id)!.start])),
          oMidi: new Map(ids.map((id) => [id, this.seq.notes.find((nn) => nn.id === id)!.midi])),
          oDur: new Map(ids.map((id) => [id, this.seq.notes.find((nn) => nn.id === id)!.dur])),
          mode: x > this.beatToX(note.start + note.dur) - 8 ? "resize" : "move",
          moved: false,
        };
      } else {
        if (e.shiftKey) {
          // Shift + 空白 = 框选
          this.rubber = { x0: x, y0: y, x1: x, y1: y };
          return;
        }
        // 铅笔:添加音符(单音轨道,重叠的旧音符被顶掉;可拖动微调,移动 >6px 转平移)
        const beat = this.snapBeat(this.xToBeat(x));
        const midi = this.yToMidi(y);
        this.clearOverlap(beat, 1);
        const n = this.seq.add(midi, beat, 1, "");
        this.selectNote(n);
        this.preview(n);
        this.snapshot();
        this.pan = { x, y, sl: this.wrap.scrollLeft, st: this.wrap.scrollTop, pendingNote: n };
      }
      this.draw();
    });
    this.canvas.addEventListener("pointermove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (this.paramDrag) {
        const { key, idx } = this.paramDrag;
        const pts = this.seq.params[key];
        const pt = pts[idx];
        if (!pt) return;
        pt.t = Math.max(0, this.snapBeat(this.xToBeat(x)));
        pt.v = this.vFromY(y);
        pts.sort((a, b) => a.t - b.t);
        this.paramDrag.idx = pts.indexOf(pt);
        this.draw();
        return;
      }
      if (this.rubber) {
        this.rubber.x1 = x;
        this.rubber.y1 = y;
        // 实时框选
        this.selectedIds.clear();
        const b0 = Math.min(this.xToBeat(this.rubber.x0), this.xToBeat(x));
        const b1 = Math.max(this.xToBeat(this.rubber.x0), this.xToBeat(x));
        const m0 = Math.min(this.yToMidi(this.rubber.y0), this.yToMidi(y));
        const m1 = Math.max(this.yToMidi(this.rubber.y0), this.yToMidi(y));
        for (const n of this.seq.notes) {
          if (n.start < b1 && n.start + n.dur > b0 && n.midi >= m0 && n.midi <= m1) {
            this.selectedIds.add(n.id);
          }
        }
        this.updateInfo();
        this.draw();
        return;
      }
      if (this.drag) {
        const d = this.drag;
        const dx = x - d.dx0;
        const dy = y - d.dy0;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
        if (d.mode === "move") {
          const dStart = Math.round(dx / this.pxPerBeat / MIN_BEAT) * MIN_BEAT;
          const dMidi = -Math.round(dy / PX_PER_KEY);
          for (const id of d.noteIds) {
            const n = this.seq.notes.find((nn) => nn.id === id);
            if (!n) continue;
            n.start = Math.max(0, this.snapBeat(d.oStart.get(id)! + dStart));
            n.midi = Math.max(LOW_MIDI, Math.min(HIGH_MIDI - 1, d.oMidi.get(id)! + dMidi));
          }
        } else {
          const dDur = Math.round(dx / this.pxPerBeat / MIN_BEAT) * MIN_BEAT;
          for (const id of d.noteIds) {
            const n = this.seq.notes.find((nn) => nn.id === id);
            if (!n) continue;
            n.dur = Math.max(MIN_BEAT, this.snapBeat(d.oDur.get(id)! + dDur));
          }
        }
        this.draw();
        return;
      }
      if (this.pan) {
        const dx = x - this.pan.x;
        const dy = y - this.pan.y;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          if (this.pan.pendingNote) {
            this.seq.remove(this.pan.pendingNote.id);
            this.selectedIds.delete(this.pan.pendingNote.id);
            this.pan.pendingNote = null;
            this.updateInfo();
          }
          this.wrap.scrollLeft = this.pan.sl - dx;
          this.wrap.scrollTop = this.pan.st - dy;
          this.draw();
        }
      }
    });
    this.canvas.addEventListener("pointerup", () => {
      if (this.drag?.moved) {
        // 拖动后清理重叠(单音轨道,保留起始拍早的音符)
        const keep = new Set<number>();
        for (const n of this.seq.sorted()) {
          let clash = false;
          for (const id of keep) {
            const o = this.seq.notes.find((nn) => nn.id === id);
            if (o && n.start < o.start + o.dur && n.start + n.dur > o.start) {
              clash = true;
              break;
            }
          }
          if (clash) {
            this.seq.remove(n.id);
            this.selectedIds.delete(n.id);
          } else {
            keep.add(n.id);
          }
        }
        this.snapshot();
      }
      this.drag = null;
      this.pan = null;
      this.paramDrag = null;
      this.rubber = null;
      this.scheduleSave();
      this.draw();
    });
    this.canvas.addEventListener("dblclick", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (y >= this.contentH) {
        const pts = this.seq.params[this.currentParam];
        if (pts.length) {
          const beat = this.xToBeat(x);
          let best = 0;
          let bestD = Infinity;
          for (let i = 0; i < pts.length; i++) {
            const d = Math.abs(pts[i].t - beat);
            if (d < bestD) { bestD = d; best = i; }
          }
          if (bestD < 1) { pts.splice(best, 1); this.snapshot(); }
        }
        this.draw();
        return;
      }
      const note = this.hitNote(x, y);
      if (note) {
        this.selectNote(note);
        this.editLyric(note);
      }
    });
    // 右键:删除音符
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (y < RULER_H || y >= this.contentH) return;
      const note = this.hitNote(x, y);
      if (note) {
        this.seq.remove(note.id);
        this.selectedIds.delete(note.id);
        this.updateInfo();
        this.snapshot();
        this.resize();
        this.draw();
        this.scheduleSave();
      }
    });
    // 中心缩放(保持鼠标下的拍位置不动)
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const oldPx = this.pxPerBeat;
      this.pxPerBeat = Math.max(14, Math.min(90, this.pxPerBeat + (e.deltaY > 0 ? -4 : 4)));
      const k = this.pxPerBeat / oldPx;
      this.wrap.scrollLeft = (this.wrap.scrollLeft + mx - KEY_LABEL_W) * k - (mx - KEY_LABEL_W);
      this.resize();
      this.draw();
    }, { passive: false });
  }

  private bindToolbar() {
    document.getElementById("roll-play")!.addEventListener("click", () => this.play());
    document.getElementById("roll-stop")!.addEventListener("click", () => this.stop());
    document.getElementById("roll-record")!.addEventListener("click", () => this.toggleRecording());
    document.getElementById("roll-lyrics")!.addEventListener("click", () => this.openLyricPanel());
    document.getElementById("roll-sample")!.addEventListener("click", () => this.loadSampleSong());
    document.getElementById("lp-apply")!.addEventListener("click", () => this.applyLyricPanel());
    document.getElementById("lp-close")!.addEventListener("click", () => {
      document.getElementById("lyric-panel")!.hidden = true;
    });
    document.getElementById("roll-import")!.addEventListener("click", () => this.importMidi());
    document.getElementById("roll-clear")!.addEventListener("click", () => {
      this.stop();
      this.snapshot();
      this.seq.clear();
      this.selectedIds.clear();
      this.updateInfo();
      this.resize();
      this.draw();
      this.scheduleSave();
    });
    document.getElementById("roll-clear-param")!.addEventListener("click", () => {
      if (this.seq.params[this.currentParam].length) {
        this.snapshot();
        this.seq.params[this.currentParam] = [];
        this.draw();
      }
    });
    document.querySelectorAll<HTMLButtonElement>(".tool-btn").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".tool-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.tool = b.dataset.tool as "pencil" | "eraser";
        this.canvas.style.cursor = this.tool === "eraser" ? "crosshair" : "default";
      });
    });
    const bpm = document.getElementById("roll-bpm") as HTMLInputElement;
    bpm.addEventListener("input", () => {
      this.bpm = Number(bpm.value);
      document.getElementById("roll-bpm-val")!.textContent = bpm.value;
      this.scheduleSave();
    });
    document.querySelectorAll<HTMLButtonElement>(".param-tab").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".param-tab").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.currentParam = b.dataset.param as ParamKey;
        this.draw();
      });
    });
    this.lyricInput.addEventListener("input", () => {
      if (this.selected) {
        this.selected.lyric = this.lyricInput.value.trim();
        this.updateInfo();
      }
      this.draw();
    });
    this.lyricInput.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        // 多选时:歌词按空格/逗号分割,依次分配到选中的音符(按拍序)
        if (this.selectedIds.size > 1) {
          const words = this.lyricInput.value.trim().split(/[\s,，]+/).filter(Boolean);
          if (words.length) {
            const notes = [...this.selectedIds]
              .map((id) => this.seq.notes.find((n) => n.id === id)!)
              .filter(Boolean)
              .sort((a, b) => a.start - b.start);
            this.snapshot();
            notes.forEach((n, i) => {
              if (words[i] !== undefined) n.lyric = words[i];
            });
            this.updateInfo();
            this.scheduleSave();
          }
        }
        this.lyricInput.blur();
      }
    });
  }

  private bindKeys() {
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        this.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        if (!this.selectedIds.size) return;
        const first = this.selected;
        if (!first) return;
        this.clip = [...this.seq.notes]
          .filter((n) => this.selectedIds.has(n.id))
          .map((n) => ({ midi: n.midi, start: n.start - first.start, dur: n.dur, lyric: n.lyric }));
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        if (!this.clip.length) return;
        e.preventDefault();
        const first = this.selected;
        const pasteAt = first ? first.start : 0;
        this.snapshot();
        for (const c of this.clip) {
          this.clearOverlap(pasteAt + c.start, c.dur);
          this.seq.add(c.midi, pasteAt + c.start, c.dur, c.lyric);
        }
        this.resize();
        this.draw();
        this.scheduleSave();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        for (const n of this.seq.notes) this.selectedIds.add(n.id);
        this.updateInfo();
        this.draw();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (this.selectedIds.size) {
          this.snapshot();
          for (const id of [...this.selectedIds]) this.seq.remove(id);
          this.selectedIds.clear();
          this.updateInfo();
          this.resize();
          this.draw();
          this.scheduleSave();
        }
      }
      if (e.key === " ") {
        e.preventDefault();
        if (this.playing) this.stop();
        else this.play();
      }
    });
  }

  private importMidi() {
    invoke<[string, string]>("open_midi")
      .then(([b64, name]) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const smf = parseSmf(bytes, name);
        if (!smf) {
          document.getElementById("roll-bpm-val")!.textContent = "格式不支持";
          return;
        }
        this.stop();
        this.snapshot();
        this.seq.clear();
        for (const n of smf.notes) {
          this.seq.add(n.midi, n.start, Math.max(0.25, n.dur), n.lyric);
        }
        if (smf.bpm) {
          this.bpm = smf.bpm;
          const bpmEl = document.getElementById("roll-bpm") as HTMLInputElement;
          bpmEl.value = String(smf.bpm);
          document.getElementById("roll-bpm-val")!.textContent = String(smf.bpm);
        }
        this.selectedIds.clear();
        this.updateInfo();
        this.resize();
        this.draw();
        this.scheduleSave();
      })
      .catch(() => { /* 取消或浏览器环境 */ });
  }

  private hitNote(x: number, y: number): Note | null {
    const beat = this.xToBeat(x);
    const midi = this.yToMidi(y);
    return this.seq.at(beat, midi);
  }

  private snapBeat(b: number) {
    return Math.round(b / MIN_BEAT) * MIN_BEAT;
  }
}
