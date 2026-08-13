// ============ 音符/序列模型(钢琴卷帘数据) ============
// 纯数据,不依赖音频/UI。拍为时间单位,BPM 由播放器解释。
// 参数曲线(params)与换气标记(breaths)都挂在序列上,由卷帘编辑。

export interface Note {
  id: number;
  midi: number;      // 音高(60 = C4)
  start: number;     // 起始拍
  dur: number;       // 时长(拍)
  lyric: string;     // 歌词(拼音,可带声调数字,如 "ni3")
}

export type ParamKey = "breath" | "bright" | "vib" | "vel" | "pitch";

export interface ParamPoint {
  t: number;   // 拍
  v: number;   // 0-1
}

let nextId = 1;

export class Sequence {
  notes: Note[] = [];
  breaths: number[] = [];                    // 换气标记:拍位置(升序)
  params: Record<ParamKey, ParamPoint[]> = { breath: [], bright: [], vib: [], vel: [], pitch: [] };

  add(midi: number, start: number, dur: number, lyric = ""): Note {
    const n: Note = { id: nextId++, midi, start, dur, lyric };
    this.notes.push(n);
    return n;
  }

  remove(id: number) {
    this.notes = this.notes.filter((n) => n.id !== id);
  }

  /** 按起始拍排序(播放/渲染用) */
  sorted(): Note[] {
    return [...this.notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
  }

  /** 总时长(拍):最晚音符结束;空序列给 1 拍 */
  get length(): number {
    let end = 0;
    for (const n of this.notes) end = Math.max(end, n.start + n.dur);
    return end || 1;
  }

  /** 命中指定拍/音高网格的音符 */
  at(x: number, y: number): Note | null {
    for (const n of this.notes) {
      if (x >= n.start && x < n.start + n.dur && y === n.midi) return n;
    }
    return null;
  }

  /** 添加/删除换气标记(吸附到拍),返回是否添加 */
  toggleBreath(beat: number): boolean {
    const b = Math.round(beat / 0.25) * 0.25;
    const idx = this.breaths.findIndex((x) => Math.abs(x - b) < 0.01);
    if (idx >= 0) {
      this.breaths.splice(idx, 1);
      return false;
    }
    this.breaths.push(b);
    this.breaths.sort((a, b2) => a - b2);
    return true;
  }

  /** 某拍处的参数值(线性插值;无节点返回 null → 用全局默认) */
  paramAt(key: ParamKey, beat: number): number | null {
    const pts = this.params[key];
    if (!pts.length) return null;
    if (beat <= pts[0].t) return pts[0].v;
    const last = pts[pts.length - 1];
    if (beat >= last.t) return last.v;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b2 = pts[i + 1];
      if (beat >= a.t && beat <= b2.t) {
        const k = b2.t === a.t ? 0 : (beat - a.t) / (b2.t - a.t);
        return a.v + (b2.v - a.v) * k;
      }
    }
    return last.v;
  }

  clear() {
    this.notes = [];
    this.breaths = [];
    for (const k of Object.keys(this.params) as ParamKey[]) this.params[k] = [];
  }

  /** 从持久化数据恢复(修正 id 递增,避免新音符 id 冲突) */
  restore(notes: Note[], breaths: number[], params: Record<ParamKey, ParamPoint[]>) {
    this.notes = notes;
    this.breaths = breaths;
    this.params = { breath: [], bright: [], vib: [], vel: [], pitch: [] };
    for (const k of Object.keys(params) as ParamKey[]) {
      this.params[k] = params[k] ?? [];
    }
    for (const n of notes) nextId = Math.max(nextId, n.id + 1);
  }
}
