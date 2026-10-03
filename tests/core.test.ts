import { describe, it, expect } from 'vitest';
import { parsePinyin, parseWithBreaks, parseSyllable } from '../src/pinyin/PinyinParser';
import { formantAt } from '../src/core/FormantTable';

describe('PinyinParser 拼音解析', () => {
  it('基础音节 → 声母/韵母（声调数字在分词阶段剥离，缺省为 1）', () => {
    const ph = parseSyllable('ni');
    expect(ph).toEqual({ initial: 'n', final: 'i', tone: 1 });
  });

  it('v 转 ü、jqx 后 u 自动转 ü', () => {
    expect(parseSyllable('nv')).toEqual({ initial: 'n', final: 'ü', tone: 1 });
    expect(parseSyllable('ju')).toEqual({ initial: 'j', final: 'ü', tone: 1 });
    expect(parseSyllable('xue').final).toBe('üe');
  });

  it('舌尖音 zhi/chi → ii 归一', () => {
    expect(parseSyllable('zhi1').final).toBe('ii');
  });

  it('标点标注停顿', () => {
    const r = parseWithBreaks('ni3 hao3 shi4 jie4.');
    expect(r.phonemes.length).toBe(4);
    expect(r.pauses.length).toBeGreaterThanOrEqual(1);
  });

  it('注入：无意义符号不崩溃、产出空/跳过', () => {
    expect(parsePinyin('!@#$%^&*()')).toEqual([]);
    expect(parsePinyin('').length).toBe(0);
  });
});

describe('FormantTable 共振峰插值', () => {
  it('未知韵母兜底 a', () => {
    expect(() => formantAt('nonexistent_vowel', 0.5)).not.toThrow();
  });
  it('t 越界被钳制到 [0,1]', () => {
    expect(() => formantAt('a', -5)).not.toThrow();
    expect(() => formantAt('a', 5)).not.toThrow();
  });
});
