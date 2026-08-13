// ============ 共振峰表(实测数据驱动) ============
// 数据来源:VoiceData.ts(tools/analyze_voice.py 分析 OK/ 420 单音节,统一音色)
// formantAt(vowel, t):5 点轨迹分段插值(t 为元音段进度 0..1,发音过程:起→过渡→稳定→过渡→收尾)
// 轨迹点来自真实录音,单元音三近相同,复合韵母呈现真实滑移

import { VOICE } from "./VoiceData";

export interface FormantSet {
  f: number[];   // F1-F4 频率 Hz
  bw: number[];  // 对应带宽 Hz
}

function lerpSet(a: FormantSet, b: FormantSet, k: number): FormantSet {
  return {
    f: [
      a.f[0] + (b.f[0] - a.f[0]) * k,
      a.f[1] + (b.f[1] - a.f[1]) * k,
      a.f[2] + (b.f[2] - a.f[2]) * k,
      a.f[3] + (b.f[3] - a.f[3]) * k,
    ],
    bw: [
      a.bw[0] + (b.bw[0] - a.bw[0]) * k,
      a.bw[1] + (b.bw[1] - a.bw[1]) * k,
      a.bw[2] + (b.bw[2] - a.bw[2]) * k,
      a.bw[3] + (b.bw[3] - a.bw[3]) * k,
    ],
  };
}

export function formantAt(vowel: string, t: number): FormantSet {
  const v = VOICE.vowels[vowel] ?? VOICE.vowels["a"];  // 未知韵母兜底 a
  const tr = v.traj;
  // 5 个锚点,每段端点 = 锚点本身;t 线性插值相邻锚点
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  const seg = tt * (tr.length - 1);          // 0..4 连续
  const i = Math.min(tr.length - 2, Math.floor(seg));
  return lerpSet(tr[i], tr[i + 1], seg - i);
}

// 可用元音列表(舌尖元音 ii 不单独展示)
export const VOWEL_NAMES = Object.keys(VOICE.vowels).filter((k) => k !== "ii");
