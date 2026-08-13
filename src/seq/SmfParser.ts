// ============ 标准 MIDI 文件(SMF)解析器 ============
// 纯逻辑:字节 → 音符(拍)+ BPM(取首个 tempo 事件)+ 可选歌词(meta 0x05)
// 支持格式 0/1,time division 为 ticks/quarter;SMPTE 帧率格式不支持

export interface SmfNote {
  midi: number;
  start: number;   // 拍
  dur: number;     // 拍
  lyric: string;   // 该音符前的最近歌词(可能为空)
}

export interface SmfResult {
  notes: SmfNote[];
  bpm: number;
  name: string;
}

interface RawEvent {
  tick: number;
  type: "on" | "off";
  midi: number;
}

interface LyricEvent {
  tick: number;
  text: string;
}

export function parseSmf(bytes: Uint8Array, name = ""): SmfResult | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const read = (n: number) => {
    const v = bytes.subarray(pos, pos + n);
    pos += n;
    return v;
  };
  const readU32 = () => { const v = view.getUint32(pos); pos += 4; return v; };
  const readU16 = () => { const v = view.getUint16(pos); pos += 2; return v; };
  const readVLQ = (): number => {
    let v = 0, b = 0;
    do {
      b = bytes[pos++];
      v = (v << 7) | (b & 0x7f);
    } while (b & 0x80);
    return v;
  };

  // 头:MThd len=6 format ntrks division
  if (read(4).join(",") !== [77, 84, 104, 100].join(",")) return null; // "MThd"
  readU32();
  readU16();                      // format(0/1)
  const ntrks = readU16();
  const division = readU16();
  if (division & 0x8000) return null;   // SMPTE 格式不支持
  const tpq = division;
  if (tpq <= 0 || ntrks <= 0) return null;

  const events: RawEvent[] = [];
  const lyrics: LyricEvent[] = [];
  let tempo = 500000;   // 默认 120 BPM
  let running = 0;      // 运行状态字节(通道消息复用)

  for (let tr = 0; tr < ntrks; tr++) {
    if (read(4).join(",") !== [77, 84, 114, 107].join(",")) return null; // "MTrk"
    const len = readU32();
    const end = pos + len;
    let tick = 0;
    const active = new Map<number, number>();   // midi → note-on tick
    while (pos < end) {
      tick += readVLQ();
      const statusByte = bytes[pos];
      let status: number;
      if (statusByte & 0x80) {
        status = statusByte;
        pos++;
      } else {
        status = running;   // 运行状态复用
      }
      running = status;
      const hi = status & 0xf0;
      if (hi === 0x90) {           // note on
        const midi = bytes[pos++];
        const vel = bytes[pos++];
        if (vel > 0) {
          if (!active.has(midi)) active.set(midi, tick);
        } else {
          const s = active.get(midi);
          if (s !== undefined) {
            events.push({ tick: s, type: "on", midi });
            events.push({ tick, type: "off", midi });
            active.delete(midi);
          }
        }
      } else if (hi === 0x80) {    // note off
        const midi = bytes[pos++];
        pos++;   // velocity
        const s = active.get(midi);
        if (s !== undefined) {
          events.push({ tick: s, type: "on", midi });
          events.push({ tick, type: "off", midi });
          active.delete(midi);
        }
      } else if (status === 0xff) {  // meta
        const type = bytes[pos++];
        const mlen = readVLQ();
        const data = read(mlen);
        if (type === 0x51 && mlen === 3) {
          const t = (data[0] << 16) | (data[1] << 8) | data[2];
          if (tempo === 500000) tempo = t;
        } else if (type === 0x05) {  // 歌词
          const text = new TextDecoder().decode(data).trim();
          if (text) lyrics.push({ tick, text });
        }
      } else if (hi === 0xf0 || status === 0xf7) {  // sysex:跳过
        const slen = readVLQ();
        pos += slen;
      } else {                     // 通道消息:2 字节
        pos += 2;
      }
    }
    // 轨道结尾未关的音符:补 off
    for (const [midi, s] of active) {
      events.push({ tick: s, type: "on", midi });
      events.push({ tick: end, type: "off", midi });
    }
  }

  // 合并歌词 → 音符(音符起始前最近的歌词)
  events.sort((a, b) => a.tick - b.tick);
  const notes: SmfNote[] = [];
  let li = 0;
  let curLyric = "";
  let pendingOn: { midi: number; tick: number } | null = null;
  for (const ev of events) {
    while (li < lyrics.length && lyrics[li].tick <= ev.tick) {
      curLyric = lyrics[li].text;
      li++;
    }
    if (ev.type === "on") {
      pendingOn = { midi: ev.midi, tick: ev.tick };
    } else if (pendingOn && pendingOn.midi === ev.midi) {
      notes.push({
        midi: pendingOn.midi,
        start: pendingOn.tick / tpq,
        dur: Math.max(0.1, (ev.tick - pendingOn.tick) / tpq),
        lyric: curLyric,
      });
      pendingOn = null;
    }
  }

  const bpm = Math.round(60_000_000 / tempo);
  return { notes, bpm, name };
}
