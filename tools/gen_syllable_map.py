# -*- coding: utf-8 -*-
# 生成 音节(带声调)→ 素材文件名 + 语音起止(秒) 映射表
# 语音起止来自 trim_voice(裁掉首尾静音,拼接时不会带停顿)
# 输出:src/pinyin/syllableFiles.ts
import os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pypinyin import lazy_pinyin, Style
import analyze_voice as av

OK = av.OK_DIR
files = sorted(os.listdir(OK))
wavs = {}
for f in files:
    m = re.match(r"^(\d+)_", f)
    if m and f.endswith(".wav"):
        wavs[int(m.group(1))] = f

# 复用 analyze_voice 的 meta 逻辑得到 (initial, final, tone)
meta = {}
for idx in sorted(wavs):
    if idx in av.FINAL_SAMPLES:
        meta[idx] = (None, av.FINAL_SAMPLES[idx], 1)
    elif idx in av.INIT_SAMPLES:
        meta[idx] = av.INIT_SAMPLES[idx] + (1,)
    elif idx in av.TONE_SAMPLES:
        meta[idx] = ("m", "a", av.TONE_SAMPLES[idx])
    elif idx in av.SKIP_IDX:
        continue
    else:
        stem = os.path.splitext(wavs[idx])[0].split("_", 1)[1]
        py = av.PY_OVERRIDE.get(idx) or lazy_pinyin(stem, style=Style.NORMAL)[0]
        ini, fin = None, py
        for it in sorted(av.INITIALS, key=len, reverse=True):
            if py.startswith(it):
                ini, fin = it, py[len(it):]
                break
        fin = fin.replace("v", "ü")
        if fin == "u" and (ini == "y" or ini in "jqx"): fin = "ü"
        elif fin == "un" and (ini == "y" or ini in "jqx"): fin = "ün"
        elif fin == "ue" and (ini == "y" or ini in "jqx"): fin = "üe"
        elif fin == "uan" and ini == "y": fin = "üan"
        if fin == "i" and ini in av.APICAL: fin = "ii"
        meta[idx] = (ini, fin, 1)

mapping = {}
for idx in sorted(meta):
    ini, fin, tone = meta[idx]
    syl = (ini or "") + fin
    key = syl + str(tone)
    # 语音起止(秒):裁静音,带 20ms 保护边
    t = av.trim_voice(av.load_wav(OK + "/" + wavs[idx]))
    if t is None:
        continue
    seg, off = t
    o = round(off / av.SR, 3)
    d = round(len(seg) / av.SR, 3)
    mapping[key] = {"f": wavs[idx], "o": o, "d": d}

print("音节素材映射:", len(mapping))
for k in ["a1", "ba1", "ni1", "ma1", "zhong1", "guo1"]:
    print(f"  {k} -> {mapping.get(k, '?')}")

lines = [
    "// ============ 音节(带声调)→ 素材文件 + 语音起止(自动生成,勿手改) ============",
    "// 来源:tools/gen_syllable_map.py;o=语音起点(秒), d=语音时长(秒), 裁静音保证拼接连贯",
    f"// 共 {len(mapping)} 条;素材目录:OK/",
    "export interface SyllableSample { f: string; o: number; d: number }",
    "export const SYLLABLE_FILES: Record<string, SyllableSample> = {",
]
for k in sorted(mapping):
    v = mapping[k]
    lines.append(f'  "{k}": {{ f: "{v["f"]}", o: {v["o"]}, d: {v["d"]} }},')
lines.append("};")
lines.append("")
with open("src/pinyin/syllableFiles.ts", "w", encoding="utf-8") as fp:
    fp.write("\n".join(lines))
print("已写出 src/pinyin/syllableFiles.ts")
