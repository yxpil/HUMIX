# -*- coding: utf-8 -*-
# SMF 解析器验证:生成一个标准 MIDI 文件,用与 TS 相同的逻辑镜像解析并断言
import struct

# ---------- 生成测试 MIDI(format 0, 480 tpq, 3 音符 + tempo + 歌词) ----------
def vlq(v):
    out = [v & 0x7f]
    v >>= 7
    while v:
        out.append((v & 0x7f) | 0x80)
        v >>= 7
    return bytes(reversed(out))

def meta_ev(tick_delta, mtype, data):
    return vlq(tick_delta) + bytes([0xFF, mtype, len(data)]) + data

def ch_ev(tick_delta, status, d1, d2):
    return vlq(tick_delta) + bytes([status, d1, d2])

TRACK = b""
TRACK += meta_ev(0, 0x51, struct.pack(">I", 500000)[1:])          # tempo 120bpm
TRACK += meta_ev(0, 0x03, b"test")                                 # track name
TRACK += meta_ev(0, 0x05, "ni3".encode())                          # lyric(紧跟音符前)
TRACK += ch_ev(0, 0x90, 60, 100)                                   # C4 on @0
TRACK += ch_ev(240, 0x80, 60, 0)                                   # off @240(0.5拍)
TRACK += meta_ev(240, 0x05, "hao3".encode())                       # lyric @480
TRACK += ch_ev(0, 0x90, 64, 100)                                   # E4 on @480
TRACK += ch_ev(480, 0x80, 64, 0)
TRACK += ch_ev(0, 0x90, 67, 100)                                   # G4 on (运行状态:delta=0)
TRACK += ch_ev(480, 0x80, 67, 0)
TRACK += meta_ev(0, 0x2F, b"")                                     # end of track
MThd = b"MThd" + struct.pack(">IHHH", 6, 0, 1, 480)
MTrk = b"MTrk" + struct.pack(">I", len(TRACK)) + TRACK
smf = MThd + MTrk
open(r"C:/Users/Admin/OneDrive/Desktop/HUMIX/tools/test_song.mid", "wb").write(smf)
print(f"生成 test_song.mid ({len(smf)} 字节)")

# ---------- 镜像解析(与 src/seq/SmfParser.ts 逻辑一致) ----------
def parse(data):
    pos = 0
    def rd(n):
        nonlocal pos
        v = data[pos:pos+n]; pos += n; return v
    def u32():
        nonlocal pos
        v = struct.unpack(">I", data[pos:pos+4])[0]; pos += 4; return v
    def u16():
        nonlocal pos
        v = struct.unpack(">H", data[pos:pos+2])[0]; pos += 2; return v
    def vvlq():
        nonlocal pos
        v, b = 0, 0
        while True:
            b = data[pos]; pos += 1
            v = (v << 7) | (b & 0x7f)
            if not (b & 0x80): break
        return v
    if rd(4) != b"MThd": return None
    u32(); u16(); ntrks = u16(); division = u16()
    tpq = division
    events, lyrics, tempo = [], [], 500000
    running = 0
    for _ in range(ntrks):
        if rd(4) != b"MTrk": return None
        length = u32(); end = pos + length
        tick = 0
        active = {}
        while pos < end:
            tick += vvlq()
            sb = data[pos]
            if sb & 0x80:
                status = sb; pos += 1
            else:
                status = running
            running = status
            hi = status & 0xf0
            if hi == 0x90:
                midi = data[pos]; vel = data[pos+1]; pos += 2
                if vel > 0:
                    if midi not in active: active[midi] = tick
                else:
                    if midi in active:
                        events.append((active[midi], "on", midi)); events.append((tick, "off", midi))
                        del active[midi]
            elif hi == 0x80:
                midi = data[pos]; pos += 2
                if midi in active:
                    events.append((active[midi], "on", midi)); events.append((tick, "off", midi))
                    del active[midi]
            elif status == 0xff:
                mtype = data[pos]; pos += 1
                mlen = vvlq(); d = rd(mlen)
                if mtype == 0x51 and mlen == 3:
                    t = (d[0] << 16) | (d[1] << 8) | d[2]
                    if tempo == 500000: tempo = t
                elif mtype == 0x05:
                    txt = d.decode("utf-8", "replace").strip()
                    if txt: lyrics.append((tick, txt))
            elif hi == 0xf0 or status == 0xf7:
                pos += vvlq()
            else:
                pos += 2
        for midi, s in active.items():
            events.append((s, "on", midi)); events.append((end, "off", midi))
    events.sort()
    notes, li, cur = [], 0, ""
    pending = None
    for tk, typ, midi in events:
        while li < len(lyrics) and lyrics[li][0] <= tk:
            cur = lyrics[li][1]; li += 1
        if typ == "on":
            pending = (midi, tk)
        elif pending and pending[0] == midi:
            notes.append({"midi": midi, "start": pending[1] / tpq, "dur": max(0.1, (tk - pending[1]) / tpq), "lyric": cur})
            pending = None
    return {"bpm": round(60_000_000 / tempo), "notes": notes}

res = parse(smf)
print("BPM:", res["bpm"])
for n in res["notes"]:
    print(f"  midi={n['midi']} start={n['start']} dur={n['dur']} lyric={n['lyric']!r}")

# 断言
assert res["bpm"] == 120, "BPM 应为 120"
assert [n["midi"] for n in res["notes"]] == [60, 64, 67], "音符顺序/音高错"
assert [n["start"] for n in res["notes"]] == [0.0, 1.0, 2.0], f"起始拍错 {[n['start'] for n in res['notes']]}"
assert [n["dur"] for n in res["notes"]] == [0.5, 1.0, 1.0], "时长错"
assert [n["lyric"] for n in res["notes"]] == ["ni3", "hao3", "hao3"], "歌词分配错"
print("SMF 解析验证通过 ✓")
