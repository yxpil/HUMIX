# -*- coding: utf-8 -*-
# 用 edge-tts 重新生成全部单音节素材 → OK_TTS/
# 用法:python tools/gen_tts_samples.py [--test]  (--test 只生成前 5 个)
# 依赖:edge-tts CLI(hermes venv)+ ffmpeg
import os, sys, re, subprocess, shutil
from concurrent.futures import ThreadPoolExecutor, as_completed

OK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "OK")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "OK_TTS")
FFMPEG = "C:/Users/Admin/AppData/Local/PIL Player/_up_/ffmpeg/ffmpeg.exe"
VOICE = "zh-CN-XiaoxiaoNeural"   # 女声,温暖标准(与原 so-vits 女声一致)

files = sorted(f for f in os.listdir(OK) if f.endswith(".wav"))
print(f"素材数: {len(files)} → 输出 {OUT}")

if "--test" in sys.argv:
    files = files[:5]
    print("测试模式:前 5 个")

os.makedirs(OUT, exist_ok=True)

def gen_one(fname):
    """生成单个字:edge-tts → mp3 → wav(44.1k mono 16bit)"""
    stem = fname[:-4]
    han = stem.split("_", 1)[1]          # 序号_汉字 → 汉字(可能多字)
    mp3 = os.path.join(OUT, stem + ".mp3")
    wav = os.path.join(OUT, fname)
    try:
        subprocess.run(
            ["edge-tts", "--voice", VOICE, "--text", han, "--write-media", mp3],
            check=True, capture_output=True, timeout=60,
        )
        subprocess.run(
            [FFMPEG, "-y", "-i", mp3, "-ar", "44100", "-ac", "1", "-sample_fmt", "s16", wav],
            check=True, capture_output=True, timeout=60,
        )
        os.remove(mp3)
        return (fname, True, None)
    except Exception as e:
        return (fname, False, str(e)[:120])

ok = fail = 0
with ThreadPoolExecutor(max_workers=8) as ex:
    futs = {ex.submit(gen_one, f): f for f in files}
    for i, fut in enumerate(as_completed(futs), 1):
        fname, good, err = fut.result()
        if good:
            ok += 1
        else:
            fail += 1
            print(f"  [FAIL] {fname}: {err}", flush=True)
        if i % 50 == 0 or i == len(files):
            print(f"  进度 {i}/{len(files)} 成功 {ok} 失败 {fail}", flush=True)

print(f"完成:成功 {ok} 失败 {fail} → {OUT}")
