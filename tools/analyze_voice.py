# -*- coding: utf-8 -*-
"""
HUMIX 语音数据分析:从 OK/ 的 420 个单音节样本提取真实发音特征
- 每个样本:f0 轨迹 + LPC 共振峰(F1-F4)+ 辅音起始段(时长/频谱质心/浊音标志)
- 聚合:
  vowels: 每个韵母 → 3 点共振峰轨迹 [start, mid, end](直接可插值)
  consonants: 每个声母 → {dur, centroid, ratio, voiced}
  tones: ma1-4 → 归一化 f0 轮廓(16 点)
  f0: 全库中位数音高(说话基准)
输出:tools/voice_data.json + src/core/VoiceData.ts
"""
import os, re, json, sys, math
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly, lfilter
from pypinyin import lazy_pinyin, Style

OK_DIR = r"C:/Users/Admin/OneDrive/Desktop/HUMIX/OK_TTS"
SR = 16000
WIN, HOP = 400, 160  # 25ms / 10ms @16k
F0_MIN, F0_MAX = 60.0, 420.0
LPC_ORDER = 16

# ---------------- 样本 → (声母, 韵母, 声调) 映射 ----------------
# 001-043 专用韵母样本(由脚本朗读顺序确定,文件名为汉字不代表拼音)
FINAL_SAMPLES = {
    1: "a", 2: "o", 3: "e", 4: "i", 5: "u", 6: "ü",
    7: "ai", 8: "ei", 9: "ao", 10: "ou", 11: "ia", 12: "ie",
    13: "ua", 14: "uo", 15: "üe",
    37: "an", 38: "en", 39: "ang", 40: "eng", 41: "ong", 42: "in", 43: "ing",
}
# 016-036 声母样本(辅音 + 元音 a/i)
INIT_SAMPLES = {
    16: ("b", "a"), 17: ("p", "a"), 18: ("m", "a"), 19: ("f", "a"),
    20: ("d", "a"), 21: ("t", "a"), 22: ("n", "a"), 23: ("l", "a"),
    24: ("g", "a"), 25: ("k", "a"), 26: ("h", "a"),
    27: ("j", "i"), 28: ("q", "i"), 29: ("x", "i"),
    30: ("zh", "a"), 31: ("ch", "a"), 32: ("sh", "a"), 33: ("r", "i"),
    34: ("z", "a"), 35: ("c", "a"), 36: ("s", "a"),
}
TONE_SAMPLES = {44: 1, 45: 2, 46: 3, 47: 4}   # 妈 麻 马 骂 = ma1-4
SKIP_IDX = {48, 49, 50}                        # 句子样本:跳过

INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l",
            "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"]
APICAL = {"zh", "ch", "sh", "r", "z", "c", "s"}
SONORANTS = {"m", "n", "l", "r", "y", "w"}   # 响音:浊音起始(鼻音/边音/半元音)
# pypinyin 个别误读/一字多音修正(按文件序号)
PY_OVERRIDE = {109: "dei", 144: "tuan"}  # 109 得→dei(对);144 团(tuan)保险

# ---------------- 基础信号处理 ----------------

def load_wav(path):
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        data = data.astype(np.float64) / 32768.0
    if sr != SR:
        data = resample_poly(data, SR, sr)
    return data.astype(np.float64)

def trim_voice(x):
    """静音裁切:返回 (有声段, 起始采样索引);无声返回 None"""
    n = len(x)
    if n < WIN:
        return None
    idxs = np.arange(0, n - WIN + 1, HOP)
    rms = np.sqrt(np.mean(x[np.newaxis, :WIN] ** 2, axis=1)) if False else \
          np.array([np.sqrt(np.mean(x[i:i + WIN] ** 2)) for i in idxs])
    thr = max(0.003, 0.08 * np.max(rms))
    on = rms > thr
    if not on.any():
        return None
    i0 = int(np.argmax(on)); i1 = int(len(on) - 1 - np.argmax(on[::-1]))
    i0 = max(0, i0 - 2); i1 = min(len(on) - 1, i1 + 2)
    a = idxs[i0]; b = min(n, idxs[i1] + WIN)
    return x[a:b], a

def preemph(x, k=0.97):
    return x - k * np.concatenate(([x[0]], x[:-1]))

def lpc(x, order):
    n = len(x)
    r = np.correlate(x, x, "full")[n - 1:] / n
    r = r[:order + 1]
    a = np.zeros(order + 1); a[0] = 1.0
    e = r[0]
    if e <= 0:
        return None
    for i in range(1, order + 1):
        acc = r[i] + np.dot(a[1:i], r[i - 1:0:-1])
        k = -acc / e
        a[1:i] += k * a[i - 1:0:-1]
        a[i] = k
        e *= 1 - k * k
        if e <= 1e-12:
            return None
    return a

def frame_f0(x):
    """自相关 f0;返回 f0 或 None"""
    n = len(x)
    ac = np.correlate(x, x, "full")[n - 1:]
    lo = int(SR / F0_MAX); hi = min(int(SR / F0_MIN), n - 1)
    if hi <= lo or ac[0] <= 0:
        return None
    seg = ac[lo:hi + 1] / ac[0]
    k = int(np.argmax(seg)) + lo
    if seg[k - lo] < 0.45:
        return None
    return SR / k

def frame_formants(x):
    """LPC 共振峰;返回 (fs4, bws4) 或 None"""
    a = lpc(x, LPC_ORDER)
    if a is None:
        return None
    roots = np.roots(a)
    fs, bws = [], []
    for r in roots:
        if abs(r) < 1e-6:
            continue
        f = np.angle(r) * SR / (2 * np.pi)
        bw = -np.log(abs(r)) * SR / np.pi
        if 150 < f < 5200 and 20 < bw < 700:
            fs.append(f); bws.append(bw)
    if len(fs) < 4:
        return None
    idx = np.argsort(fs)
    return np.array(fs)[idx][:4], np.array(bws)[idx][:4]

def lpc_coeffs(x, order=LPC_ORDER):
    """返回 LPC 系数 a([1, a1..ap]) 或 None(逆滤波用)"""
    return lpc(x, order)

def frame_centroid(x):
    """频谱质心(Hz)"""
    X = np.fft.rfft(x)
    p = np.abs(X) ** 2
    s = p.sum()
    if s <= 0:
        return 0.0
    f = np.fft.rfftfreq(len(x), 1.0 / SR)
    return float((f * p).sum() / s)

def analyze_file(path):
    """返回 {t_frac, f0, fs, bw, rms, cent, resid} 帧列表 + 语音起点索引"""
    t = trim_voice(load_wav(path))
    if t is None:
        return None
    x = t[0]
    if len(x) < WIN * 2:
        return None
    frames = []
    n = len(x)
    for i in range(0, n - WIN + 1, HOP):
        raw = x[i:i + WIN]
        rms = np.sqrt(np.mean(raw ** 2))
        pe = preemph(raw * np.hanning(WIN))
        a = lpc_coeffs(pe)
        f0 = frame_f0(pe)
        fr = frame_formants(pe)
        cent = frame_centroid(pe) if f0 is None else None
        resid = None
        if a is not None:
            resid = lfilter(a, [1.0], pe)   # LPC 逆滤波:声门源残差
        frames.append({
            "t": i / HOP, "f0": f0, "fs": None if fr is None else fr[0],
            "bw": None if fr is None else fr[1], "rms": rms, "cent": cent,
            "resid": resid,
        })
    return frames

def med_fs(frames, lo, hi):
    """帧区间 [lo,hi)(t 单位=帧号)的共振峰中位数;不足则 None"""
    sel = [fr for fr in frames if lo <= fr["t"] < hi and fr["fs"] is not None]
    if len(sel) < 2:
        return None
    fs = np.median([fr["fs"] for fr in sel], axis=0)
    bw = np.median([fr["bw"] for fr in sel], axis=0)
    return fs.tolist(), bw.tolist()

def med_f0(frames, lo, hi):
    sel = [fr["f0"] for fr in frames if lo <= fr["t"] < hi and fr["f0"]]
    return float(np.median(sel)) if sel else None

# ---------------- 主流程 ----------------

def main():
    files = sorted(os.listdir(OK_DIR))
    wavs = {}
    for f in files:
        m = re.match(r"^(\d+)_", f)
        if m and f.endswith(".wav"):
            wavs[int(m.group(1))] = os.path.join(OK_DIR, f)

    # 每个文件的 (initial, final, tone)
    meta = {}
    for idx in sorted(wavs):
        if idx in FINAL_SAMPLES:
            meta[idx] = (None, FINAL_SAMPLES[idx], 1)
        elif idx in INIT_SAMPLES:
            meta[idx] = INIT_SAMPLES[idx] + (1,)
        elif idx in TONE_SAMPLES:
            meta[idx] = ("m", "a", TONE_SAMPLES[idx])
        elif idx in SKIP_IDX:
            continue
        else:
            stem = os.path.splitext(os.path.basename(wavs[idx]))[0].split("_", 1)[1]
            py = PY_OVERRIDE.get(idx) or lazy_pinyin(stem, style=Style.NORMAL)[0]
            ini, fin = None, py
            for it in sorted(INITIALS, key=len, reverse=True):
                if py.startswith(it):
                    ini, fin = it, py[len(it):]
                    break
            # 正字法归一:v → ü(pypinyin 用 v 表 ü;nǚ/lǜ/虐/略 等)
            fin = fin.replace("v", "ü").replace("V", "ü")
            # y/j/q/x + u → ü 系列(ju/qu/xu/yu/yue/yuan/yun…)
            if fin == "u" and (ini == "y" or ini in "jqx"):
                fin = "ü"
            elif fin == "un" and (ini == "y" or ini in "jqx"):
                fin = "ün"
            elif fin == "ue" and (ini == "y" or ini in "jqx"):
                fin = "üe"
            elif fin == "uan" and ini == "y":
                fin = "üan"
            if fin == "i" and ini in APICAL:
                fin = "ii"   # 舌尖元音(zi/ci/si/zhi/chi/shi/ri)
            meta[idx] = (ini, fin, 1)

    # 逐文件分析
    vowel_frames = {}   # final -> list of 3-seg traj medians
    cons_frames = {}    # initial -> list of onset stats
    f0_all = []
    analyzed = 0
    for idx in sorted(meta):
        path = wavs[idx]
        frames = analyze_file(path)
        if frames is None:
            print(f"  [skip] {idx} {os.path.basename(path)}: 分析失败", file=sys.stderr)
            continue
        analyzed += 1
        ini, fin, tone = meta[idx]
        nfr = len(frames)
        voiced = [fr for fr in frames if fr["f0"]]
        for fr in voiced:
            f0_all.append(fr["f0"])
        if not voiced:
            continue
        # 5 段轨迹(发音过程细分:起→过渡→稳定→过渡→收尾)
        t_lo = frames[0]["t"]; t_hi = frames[-1]["t"] + 1
        span = max(t_hi - t_lo, 1)
        segs = []
        for (s0, s1) in [(0.06, 0.22), (0.22, 0.38), (0.38, 0.54), (0.54, 0.70), (0.70, 0.88)]:
            segs.append(med_fs(frames, t_lo + s0 * span, t_lo + s1 * span))
        # 段缺失时用邻近段补齐(短韵母/快速滑移韵母常有段内帧不足)
        valid = [s for s in segs if s is not None]
        if len(valid) >= 2:
            for i in range(5):
                if segs[i] is None:
                    left = next((s for s in segs[i - 1::-1] if s is not None), None)
                    right = next((s for s in segs[i + 1:] if s is not None), None)
                    segs[i] = left or right
            vowel_frames.setdefault(fin, []).append(segs)
        # 辅音起始特征
        if ini:
            first_v = min((fr["t"] for fr in voiced), default=None)
            if first_v is not None:
                onset_t = max(0, first_v - t_lo)   # 帧数
                onset_dur = onset_t * HOP / SR
                onset_frames = [fr for fr in frames if fr["t"] < first_v]
                cent = [fr["cent"] for fr in onset_frames if fr["cent"]]
                rms_on = [fr["rms"] for fr in onset_frames]
                v_rms = [fr["rms"] for fr in frames if fr["f0"]]
                # 浊音标志:响音(m n l r y w)为浊音起始,其余为噪声起始
                # (f0 自动判别不可靠:爆音与鼻音的基频起始帧几乎同时)
                voiced = ini in SONORANTS
                cons_frames.setdefault(ini, []).append({
                    "dur": onset_dur,
                    "cent": float(np.median(cent)) if cent else 2000.0,
                    "ratio": (np.mean(rms_on) / np.mean(v_rms)) if rms_on and v_rms else 0.3,
                    "voiced": voiced,
                })
        # 声调轮廓:实测样本被读平,声调改标准调值(见下方),这里不采集

    print(f"分析完成 {analyzed}/{len(meta)} 个样本")

    # ----- 聚合 vowels -----
    def formant_envelope(fs4, bw4, f0=242.4, n=64):
        """每个韵母的谐波幅度包络:4 共振峰(峰值归一化,宽带宽)× 声门谱倾斜
        峰值归一化 → F1 不再独大(去"喊"感);带宽展宽 → 峰更圆润(去管乐尖峰)"""
        spec = []
        for k in range(1, n + 1):
            f = f0 * k
            if f > 18000:
                break
            h = 1.0
            for i in range(4):
                F = fs4[i]
                B = max(bw4[i], 40) * 1.6          # 展宽带宽,更圆润
                if F <= 0:
                    continue
                d = (1 - (f / F) ** 2) ** 2 + (B * f / (F * F)) ** 2
                h *= (B / F) / math.sqrt(d + 1e-6)  # 峰处 ≈ 1(峰值归一化)
            h /= (1.0 + (f / 2200.0) ** 2.4)       # 声门谱倾斜(更柔,弱化"喊")
            h *= math.exp(-f / 12000.0)
            spec.append(h)
        m = max(spec) if spec else 1.0
        return [round(x / m, 6) for x in spec]

    vowels = {}
    for fin, samples in sorted(vowel_frames.items()):
        arr = np.array(samples)          # (N,5,2,4)
        traj = []
        for s in range(5):
            fs = np.median(arr[:, s, 0, :], axis=0).round(0).tolist()
            bw = np.median(arr[:, s, 1, :], axis=0).round(0).tolist()
            traj.append({"f": fs, "bw": bw})
        # 稳定段(第 3 段)的共振峰包络 → 谐波幅度谱(元音音色直接刻进波形)
        spec = formant_envelope(traj[2]["f"], traj[2]["bw"])
        vowels[fin] = {"traj": traj, "spec": spec}
        print(f"  韵母 {fin:>3}: F1 {'/'.join(str(t['f'][0]) for t in traj)} "
              f"F2 {'/'.join(str(t['f'][1]) for t in traj)} "
              f"F3 {traj[2]['f'][2]:.0f} F4 {traj[2]['f'][3]:.0f} (n={len(samples)})")

    # ----- 聚合 consonants -----
    consonants = {}
    for ini, samples in sorted(cons_frames.items()):
        d = {k: np.median([s[k] for s in samples]) for k in ("dur", "cent", "ratio")}
        voiced = np.mean([s["voiced"] for s in samples]) > 0.5
        consonants[ini] = {
            "dur": round(float(d["dur"]), 3),
            "lo": int(max(300, d["cent"] * 0.45)),
            "hi": int(min(9000, d["cent"] * 1.9)),
            "ratio": round(float(min(1.0, d["ratio"] * 1.2)), 3),
            "voiced": bool(voiced),
        }
        print(f"  声母 {ini:>3}: dur {consonants[ini]['dur']:.3f}s band "
              f"{consonants[ini]['lo']}-{consonants[ini]['hi']}Hz "
              f"ratio {consonants[ini]['ratio']} voiced={voiced} (n={len(samples)})")

    # ----- 声调 -----
    # 实测四声样本被 edge-tts 读平(无音高轮廓),改用标准五度调值:
    # 1 一声 55 平, 2 二声 35 升, 3 三声 214 凹折, 4 四声 51 降, 5 轻声 短低
    x = np.linspace(0, 1, 16)
    t1 = np.ones(16)
    t2 = 0.97 + 0.27 * x ** 1.3                      # 0.97 → 1.24 上升
    t3 = np.where(x < 0.45, 1.06 - 0.30 * (x / 0.45), 0.76 + 0.40 * ((x - 0.45) / 0.55))  # 214
    t4 = 1.22 - 0.50 * x ** 0.85                     # 1.22 → 0.72 陡降
    t5 = 0.86 - 0.10 * x                             # 轻声:短而低
    tones = {str(k): np.round(v, 3).tolist() for k, v in
             {1: t1, 2: t2, 3: t3, 4: t4, 5: t5}.items()}
    for t in sorted(tones):
        print(f"  声调 {t}: {' '.join(f'{v:.2f}' for v in tones[t][::4])} (标准调值)")

    # ----- 声门源波形:全库浊音帧的残差周期同步平均 -----
    cycles = []
    for idx in sorted(meta):
        path = wavs[idx]
        frames = analyze_file(path)
        if frames is None:
            continue
        for fr in frames:
            if not fr["f0"] or fr["resid"] is None:
                continue
            period = int(SR / fr["f0"])
            if period < 20 or period > 320:
                continue
            resid = fr["resid"]
            cc = WIN // 2   # 帧内中心(残差是 400 样本帧窗口)
            lo = max(0, cc - period)
            hi = min(len(resid), cc + period)
            seg = resid[lo:hi]
            if len(seg) < period * 0.6:
                continue
            pk = int(np.argmax(np.abs(seg)))
            start = lo + pk - period // 3
            if start < 0 or start + period > len(resid):
                continue
            cycle = resid[start:start + period]
            if np.max(np.abs(cycle)) < 1e-6:
                continue
            cycle = resample_poly(cycle, 256, period)
            cycles.append(cycle - cycle.mean())
    src_wave = None
    if len(cycles) >= 200:
        avg = np.mean(np.array(cycles), axis=0)
        avg /= (np.max(np.abs(avg)) + 1e-9)
        rfft = np.fft.rfft(avg)
        N = 64   # 谐波系数数(64×f0≈15kHz,达奈奎斯特)
        src_wave = {
            "real": np.round(rfft.real[:N], 5).tolist(),
            "imag": np.round(rfft.imag[:N], 5).tolist(),
        }
        print(f"声门源波形: {len(cycles)} 周期片段平均,谐波系数 {N} 组")

    base_f0 = round(float(np.median(f0_all)), 1) if f0_all else 200.0
    print(f"基准 f0: {base_f0} Hz (样本 {len(f0_all)})")

    data = {"f0": base_f0, "srcWave": src_wave, "vowels": vowels, "consonants": consonants, "tones": tones}
    os.makedirs("tools", exist_ok=True)
    with open("tools/voice_data.json", "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=1)

    # ----- 生成 TS 模块 -----
    def j(v):
        return json.dumps(v, ensure_ascii=False)
    lines = [
        "// ============ 实测语音数据(自动生成,勿手改) ============",
        "// 来源:tools/analyze_voice.py 分析 OK/ 420 个单音节样本(so-vits 音色)",
        "// 结构:vowels[final].traj = 5 点共振峰轨迹(发音过程:起→过渡→稳定→过渡→收尾);",
        "//       consonants[initial] = {dur 起始时长, lo/hi 噪声频带, ratio 相对增益, voiced};",
        "//       tones[tone] = 归一化 f0 轮廓(16 点,相对音高); f0 = 说话基准频率",
        "export interface FormantPts { f: number[]; bw: number[] }",
        "export interface VowelData { traj: [FormantPts, FormantPts, FormantPts, FormantPts, FormantPts]; spec: number[] }",
        "export interface ConsonantData { dur: number; lo: number; hi: number; ratio: number; voiced: boolean }",
        "export interface VoiceData {",
        "  f0: number;",
        "  srcWave: { real: number[]; imag: number[] } | null;   // 声门源谐波系数(LPC 逆滤波残差周期平均)",
        "  vowels: Record<string, VowelData>;",
        "  consonants: Record<string, ConsonantData>;",
        "  tones: Record<string, number[]>;",
        "}",
        "",
        "export const VOICE: VoiceData = {",
        f"  f0: {base_f0},",
        f"  srcWave: {j(src_wave)},",
        "  vowels: {",
    ]
    for fin, v in sorted(vowels.items()):
        all_pts = ", ".join(j(x) for x in v["traj"])
        lines.append(f'    {json.dumps(fin)}: {{ traj: [{all_pts}], spec: {j(v["spec"])} }},')
    lines.append("  },")
    lines.append("  consonants: {")
    for ini, c in sorted(consonants.items()):
        lines.append(f"    {json.dumps(ini)}: {j(c)},")
    lines.append("  },")
    lines.append("  tones: {")
    for t in sorted(tones):
        lines.append(f"    {j(t)}: {j(tones[t])},")
    lines.append("  },")
    lines.append("};")
    lines.append("")
    lines.append("export type VowelKey = keyof typeof VOICE.vowels;")
    lines.append("export type ConsonantKey = keyof typeof VOICE.consonants;")
    ts_path = "src/core/VoiceData.ts"
    with open(ts_path, "w", encoding="utf-8") as fp:
        fp.write("\n".join(lines))
    print(f"已写出 tools/voice_data.json + {ts_path}")

if __name__ == "__main__":
    main()
