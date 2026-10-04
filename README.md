# HUMIX

一个由于没有算力而创造的奇怪音频合成器…… QWQ 好难受…… 不开心…… 有模型我就直接训练嘛…… 逼得我这样。

## 这是什么

浏览器 + Tauri 的人声合成器:钢琴卷帘里摆音符、填歌词(中文/拼音),播放时按旋律"唱"出来。

- 钢琴卷帘:音符编辑、多选/复制粘贴、参数曲线、录制(MIDI/电脑键盘)、歌词面板
- 演唱引擎:自研共振峰合成(声门源波形 + 韵母 5 段轨迹)+ edge-tts 单字素材字头 + 滑音连唱
- 自研相位声码器变调(重采样 + STFT 相位累加,手写 FFT)
- TTS 整句合成(edge-tts,多说话人,本地缓存)
- MIDI 输入/输出、SMF 导入导出、混响/移调/音量

## 运行

```bash
npm install
npx tauri dev     # 桌面应用(素材路径 OK_TTS/ 需要桌面环境)
# 或
npm run dev       # 纯浏览器(素材降级为合成)
```

- `tools/analyze_voice.py` — 素材分析(共振峰轨迹/声门源),依赖 `.analyze-venv`
- `tools/gen_tts_samples.py` — 用 edge-tts 重新生成 OK_TTS/ 素材
- `tools/browser_smoke.mjs` — 冒烟测试(需 dev 服务 1421)

## 构建

```bash
npm run build
```

---

<div align="center">

<a href="https://github.com/yxpil/HUMIX">
  <img width="100%" src="https://alittlecatgirlpanel.yxp.hk/card?repo=yxpil/HUMIX" alt="gh-card · yxpil/HUMIX" />
</a>

<sub>Powered by <a href="https://alittlecatgirlpanel.yxp.hk"><b>gh-card</b></a> · 粉色手写体 README 仓库名片</sub>

</div>
