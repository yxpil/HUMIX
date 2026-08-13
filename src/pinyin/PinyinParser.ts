// ============ 拼音解析:文本 → 音素链(阶段 2) ============
// "ni3 hao3 shi4 jie4" → [{initial:"n", final:"i", tone:3}, ...]
// 支持汉字输入(自动查 hanziMap 转拼音)与拼音混合;标点(，。！？、;:)标注停顿/换气点
// 纯逻辑,不依赖音频/UI。ü 可用 v 代替;j/q/x/y 后的 u 自动转 ü。

import { HANZI } from "./hanziMap";

export interface Phoneme {
  initial: string | null;  // 声母(null = 零声母)
  final: string;           // 韵母(ü 系列;舌尖元音 zi/ci/si/zhi/chi/shi/ri 归一为 ii)
  tone: number;            // 1-5(5=轻声);无数字默认 1
}

export interface ParseResult {
  phonemes: Phoneme[];
  pauses: { at: number; dur: number }[];   // 在 phonemes[at] 之后停顿 dur 秒(含换气)
}

const INITIALS = [
  "zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l",
  "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w",
] as const;

const APICAL = new Set(["zh", "ch", "sh", "r", "z", "c", "s"]);

// 韵母表(按长度降序,最长匹配)。仅收录实际出现的拼写形式(ui/iu/un 等)
const FINALS = [
  "iang", "uang", "iong", "uai", "ian", "uan",
  "iao", "iu", "ui", "ing", "ong", "ang", "eng",
  "ai", "ei", "ao", "ou", "ia", "ie", "ua", "uo", "üe", "üan",
  "an", "en", "in", "un", "ü", "er",
  "a", "o", "e", "i", "u", "ue",
] as const;

const TONE_RE = /^([a-zü]+)([0-5]?)$/i;

// 解析一段拼音/中文文本;无效片段自动跳过
export function parsePinyin(text: string): Phoneme[] {
  return parseWithBreaks(text).phonemes;
}

// 解析并标注停顿点(标点 → 停顿+换气;无标点长句自动补一处)
export function parseWithBreaks(text: string): ParseResult {
  const out: Phoneme[] = [];
  const pauses: { at: number; dur: number }[] = [];
  const tokens = text.match(/[^\s]+/g) ?? [];

  for (const rawTok of tokens) {
    // 汉字 → 拼音;标点 → 停顿标记
    let pinyinStr = "";
    let sentEnd = false;   // 句号类(长停)
    let sentMid = false;   // 逗号类(短停)
    for (const ch of rawTok) {
      if (ch >= "\u4e00" && ch <= "\u9fff") {
        pinyinStr += (HANZI[ch] ?? "") + " ";
      } else if (/[a-zA-ZüÜv]/.test(ch)) {
        pinyinStr += ch;
      } else if ("。！？!?….".includes(ch)) {
        sentEnd = true;
      } else if ("，、；,;:：".includes(ch)) {
        sentMid = true;
      }
    }
    for (const syl of pinyinStr.trim().split(/\s+/)) {
      if (!syl) continue;
      const ph = parseSyllableRaw(syl);
      if (ph) out.push(ph);
    }
    // 停顿:句末长停 + 换气;逗号短停 + 换气
    if (out.length && (sentEnd || sentMid)) {
      pauses.push({ at: out.length - 1, dur: sentEnd ? 0.45 : 0.26 });
    }
  }

  // 无标点的长句:中间补一次换气(避免一口气念完)
  if (out.length > 6 && !pauses.length) {
    pauses.push({ at: Math.floor(out.length / 2) - 1, dur: 0.3 });
  }
  return { phonemes: out, pauses };
}

// 单个拼音音节 → 音素(无空格假设;失败返回 null)
function parseSyllableRaw(syl: string): Phoneme | null {
  const m = TONE_RE.exec(syl.replace(/v/g, "ü").toLowerCase());
  if (!m) return null;
  const s = m[1];
  let tone = m[2] ? Number(m[2]) : 1;
  if (tone === 0) tone = 5;

  let initial: string | null = null;
  let final = "";
  for (const f of FINALS) {
    if (!s.endsWith(f)) continue;
    const ini = s.slice(0, s.length - f.length);
    if (ini === "") { initial = null; final = f; break; }
    if ((INITIALS as readonly string[]).includes(ini)) { initial = ini; final = f; break; }
  }
  if (!final) return null;

  if (initial && APICAL.has(initial) && final === "i") final = "ii";
  if (final === "ue") final = "üe";
  if (initial === "y" || (initial && "jqx".includes(initial))) {
    if (final === "u") final = "ü";
    else if (final === "un") final = "ün";
    else if (final === "ue") final = "üe";
    else if (final === "uan") final = "üan";
  }
  return { initial, final, tone };
}

// 调试辅助:单音节解析(无效返回 null)
export function parseSyllable(syl: string): Phoneme | null {
  const phs = parsePinyin(syl);
  return phs.length === 1 ? phs[0] : null;
}
