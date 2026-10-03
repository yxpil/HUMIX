# HUMIX 测试说明
- 测试完成：是（2026-10-04）
- 测试日期：2026-10-04
- 测试内容：单元：PinyinParser 拼音→音素链（声母/韵母、v→ü、jqx 后 u→ü、舌尖音归一、标点停顿）、FormantTable 共振峰插值（未知韵母兜底、t 越界钳制）；注入：无意义符号不崩溃
- 运行命令：cd builder 不存在，仓库根目录 `npm test`
- 测试框架：Vitest
- 模型：豆包（Doubao）生成

HUMIX 是 Tauri + Vite 的歌声合成器。测试覆盖 `src/core` 与 `src/pinyin` 的纯逻辑层。

## 运行方式

```bash
npm install
npm test
```

## 测了什么

测试目录：`tests/`
- `core.test.ts`：
  - **单元**：`parsePinyin`/`parseSyllable` 解析（n-i、nv→ü、ju→ü、xue→üe、zhi→ii、标点停顿）。
  - **注入**：`!@#$%^&*()`、空串等不可信输入产出空音素数组，不抛错。
  - `formantAt`：未知韵母兜底为 `a`，进度 `t` 被钳制到 [0,1]。

## 原有测试覆盖
- 原仓库无自动化测试（0）。

## 预期结果

```
Test Files  1 passed (1)
     Tests  7 passed (7)
```

> 音频引擎（AudioEngine/VoiceEngine）依赖 Web Audio API 与录音样本，未起浏览器；纯逻辑已直接单测。
