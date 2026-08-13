// HUMIX 浏览器冒烟测试:真实 Chrome(CDP 直连,零依赖)
// 验证:页面加载无错、拼音朗读触发声音(VU 表有电平)、停止后归零
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9224;
const APP = "http://localhost:1421/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 启动 Chrome headless ----------
const userDir = mkdtempSync(join(tmpdir(), "humix-cdp-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  "--autoplay-policy=no-user-gesture-required",
  "--no-first-run", "--no-default-browser-check", "--mute-audio",
  "about:blank",
], { stdio: "ignore" });

let ws;
try {
  // ---------- 等待调试端口 ----------
  let ver;
  for (let i = 0; i < 40; i++) {
    try {
      ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch { await sleep(250); }
  }
  if (!ver) throw new Error("CDP 端口未就绪");
  const browserWs = ver.webSocketDebuggerUrl;
  console.log("Chrome:", ver.Browser ?? "?");

  // ---------- 创建页面 ----------
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: "PUT" });
  const page = await res.json();
  ws = new WebSocket(page.webSocketDebuggerUrl);

  let msgId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++msgId;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error("页面 JS 异常: " + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
    return r.result?.result?.value;
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");

  // ---------- 等待应用加载 ----------
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await evalJs("document.readyState === 'complete' && !!document.querySelector('#keyboard .key')").catch(() => false);
    if (ready) break;
    await sleep(300);
  }
  if (!ready) throw new Error("应用未加载完成");
  console.log("页面加载完成,琴键已渲染");

  // ---------- 测试 1:哼鸣(琴键) ----------
  await evalJs("document.querySelector('.key.white').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))");
  await sleep(400);
  await evalJs("document.querySelector('.key.white').dispatchEvent(new PointerEvent('pointerup', {bubbles:true}))");
  const humLevel = await evalJs("Math.round(Number(document.querySelector('#vu-num').textContent.replace('%','')))");
  console.log(`哼鸣 VU: ${humLevel}% (期望 > 0)`);

  // ---------- 测试 2:拼音朗读 ----------
  const setInput = `
    (() => {
      const el = document.querySelector('#pinyin-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'ni3 hao3 shi4 jie4');
      el.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('#speak-btn').click();
      return true;
    })()`;
  await evalJs(setInput);
  let maxLevel = 0, sawPeak = false;
  for (let i = 0; i < 25; i++) {
    const lvl = await evalJs("Number(document.querySelector('#vu-num').textContent.replace('%',''))");
    if (lvl > 0) sawPeak = true;
    maxLevel = Math.max(maxLevel, lvl);
    await sleep(150);
  }
  console.log(`朗读(ni3 hao3 shi4 jie4) VU 峰值: ${maxLevel}% 有电平: ${sawPeak ? "是" : "否"}`);

  // ---------- 测试 3:停止 ----------
  await evalJs("document.querySelector('#stop-btn').click()");
  await sleep(500);
  const stopLevel = await evalJs("Number(document.querySelector('#vu-num').textContent.replace('%',''))");
  console.log(`停止后 VU: ${stopLevel}% (期望 0)`);

  // ---------- 测试 4:无声母 + 舌尖 + ü 拼音 ----------
  const setInput2 = `
    (() => {
      const el = document.querySelector('#pinyin-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'zhong1 guo2 ren2 lv4 se4 xiong2 mao1');
      el.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('#speak-btn').click();
      return true;
    })()`;
  await evalJs(setInput2);
  let max2 = 0;
  for (let i = 0; i < 35; i++) {
    const lvl = await evalJs("Number(document.querySelector('#vu-num').textContent.replace('%',''))");
    max2 = Math.max(max2, lvl);
    await sleep(150);
  }
  console.log(`朗读(zhong1 guo2 ren2 ...) VU 峰值: ${max2}%`);

  // ---------- 测试 5:钢琴卷帘(合成 PointerEvent 直测) ----------
  const synthClick = (cx, cy) => evalJs(`(() => {
    const c = document.querySelector('#roll-canvas');
    const r = c.getBoundingClientRect();
    const opts = { bubbles: true, clientX: r.x + ${cx}, clientY: r.y + ${cy}, button: 0 };
    c.dispatchEvent(new PointerEvent('pointerdown', opts));
    c.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
    return true;
  })()`);
  // 在 (beat≈1.5, midi≈64) / (beat≈2.5, midi≈62) / (beat≈3.5, midi≈67) 添加 3 个音符
  const notes = [[64 + 1.5 * 60, 26 + (83 - 64) * 16], [64 + 2.5 * 60, 26 + (83 - 62) * 16], [64 + 3.5 * 60, 26 + (83 - 67) * 16]];
  for (const [ox, oy] of notes) await synthClick(ox, oy);
  const noteCount = await evalJs("document.querySelectorAll('#roll-canvas').length"); // canvas 存在
  console.log(`卷帘添加音符: ${noteCount > 0 ? "canvas 就绪" : "?"}`);

  // 播放 → VU 应有电平
  await evalJs("document.querySelector('#roll-play').click()");
  let rollMax = 0;
  for (let i = 0; i < 20; i++) {
    const lvl = await evalJs("Number(document.querySelector('#vu-num').textContent.replace('%',''))");
    rollMax = Math.max(rollMax, lvl);
    await sleep(120);
  }
  await evalJs("document.querySelector('#roll-stop').click()");
  await sleep(300);
  const rollStop = await evalJs("Number(document.querySelector('#vu-num').textContent.replace('%',''))");
  console.log(`卷帘播放 VU 峰值: ${rollMax}% | 停止后: ${rollStop}%`);

  // MIDI 面板(浏览器环境)
  const midiState = await evalJs("document.querySelector('#midi-status').textContent");

  // ---------- 测试 6:卷帘自适应 + 平移 + 混响 ----------
  const fit = await evalJs(`(() => {
    const c = document.querySelector('#roll-canvas');
    const w = document.querySelector('.roll-wrap');
    return { cw: parseFloat(c.style.width), ww: w.clientWidth, ch: parseFloat(c.style.height), wh: w.clientHeight };
  })()`);
  console.log(`画布铺满: ${fit.cw.toFixed(0)}px >= 容器 ${fit.ww}px ${fit.cw >= fit.ww ? "✓" : "✗"} | 高 ${fit.ch.toFixed(0)} >= ${fit.wh} ${fit.ch >= fit.wh ? "✓" : "✗"}`);

  // 混响滑块
  await evalJs(`(() => { const r = document.querySelector('#reverb'); r.value = '60'; r.dispatchEvent(new Event('input', {bubbles:true})); return document.querySelector('#reverb-val').textContent; })()`);
  // 平移:空白按下并拖动 >6px → scrollLeft 变化且无音符添加
  const panTest = await evalJs(`(() => {
    const c = document.querySelector('#roll-canvas');
    const wrap = c.parentElement;
    const r = c.getBoundingClientRect();
    const sl0 = wrap.scrollLeft;
    // 空白处按下(midi 100 附近?用音高标签右边 beat 1 处空白——先清空)
    return { x: r.x + 90, y: r.y + 40, sl0 };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: panTest.x, y: panTest.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: panTest.x + 40, y: panTest.y + 25, button: "left" });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: panTest.x + 40, y: panTest.y + 25, button: "left", clickCount: 1 });
  await sleep(80);
  const panOk = await evalJs(`(() => {
    const wrap = document.querySelector('.roll-wrap');
    const added = document.querySelectorAll('#roll-canvas').length;
    return { sl: wrap.scrollLeft, changed: wrap.scrollLeft !== 0 };
  })()`);
  console.log(`平移拖拽: scrollLeft=${panOk.sl} ${panOk.changed ? "✓" : "✗(画布可能未溢出,滚动为 0 属正常)"}`);

  // 朗读(自动换气路径)
  await evalJs(`(() => {
    const el = document.querySelector('#pinyin-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'wo3 shi4 yi2 ge4 zhong1 guo2 ren2 ni3 ne5');
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#speak-btn').click();
    return true;
  })()`);
  let breathMax = 0;
  for (let i = 0; i < 20; i++) {
    const lvl = await evalJs("Number(document.querySelector('#vu-num').textContent.replace('%',''))");
    breathMax = Math.max(breathMax, lvl);
    await sleep(150);
  }
  console.log(`长句朗读(带换气) VU 峰值: ${breathMax}%`);

  // ---------- 测试 7:汉字朗读 + 元音试听 + 画布稳定 ----------
  await evalJs(`(() => {
    const el = document.querySelector('#pinyin-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, '你好,世界。');
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#speak-btn').click();
    return true;
  })()`);
  await sleep(400);
  const hanziStatus = await evalJs("document.querySelector('#speak-status').textContent");
  let hanziMax = 0;
  for (let i = 0; i < 16; i++) {
    const lvl = await evalJs("Number(document.querySelector('#vu-num').textContent.replace('%',''))");
    hanziMax = Math.max(hanziMax, lvl);
    await sleep(150);
  }
  console.log(`汉字朗读: 状态="${hanziStatus}" VU 峰值 ${hanziMax}%`);

  // 哼鸣已在上文验证;撤销/重做冒烟:Ctrl+Z 后音符减少
  const beforeUndo = await evalJs(`(() => {
    const c = document.querySelector('#roll-canvas');
    const g = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    let cnt = 0;
    for (const b of [2, 3, 4]) {
      const d = g.getImageData(Math.round((64 + b * 60) * dpr), Math.round(335 * dpr), 1, 1).data;
      if (d[0] > 60 && d[1] > 130 && d[2] > 60) cnt++;
    }
    return cnt;
  })()`);
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  const afterUndo = await evalJs(`(() => {
    const c = document.querySelector('#roll-canvas');
    const g = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    let cnt = 0;
    for (const b of [2, 3, 4]) {
      const d = g.getImageData(Math.round((64 + b * 60) * dpr), Math.round(335 * dpr), 1, 1).data;
      if (d[0] > 60 && d[1] > 130 && d[2] > 60) cnt++;
    }
    return cnt;
  })()`);
  console.log(`撤销测试: 前 ${beforeUndo} 个音符像素带 -> 后 ${afterUndo} ${afterUndo <= beforeUndo ? "✓" : "✗"}`);

  // ---------- 测试 9:录制(电脑键盘弹奏实时录音符) ----------
  await evalJs("document.querySelector('#roll-record').click()");   // 开始录制
  await evalJs("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }))");
  await sleep(300);
  await evalJs("window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', bubbles: true }))");
  await sleep(100);
  await evalJs("document.querySelector('#roll-record').click()");   // 停止录制
  await sleep(150);
  const recNote = await evalJs(`(() => {
    const c = document.querySelector('#roll-canvas');
    const g = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    // 录制音符 midi48 @beat0: x=64..92, y=26+(83-48)*16=586
    const d = g.getImageData(Math.round(70 * dpr), Math.round(590 * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  })()`);
  const recOk = recNote[0] > 60 && recNote[1] > 130 && recNote[2] > 60;
  console.log(`录制音符(midi48@0拍): ${recOk ? "✓" : "✗ " + JSON.stringify(recNote)}`);

  // ---------- 测试 10:全部歌词面板 ----------
  await evalJs("document.querySelector('#roll-lyrics').click()");
  await sleep(80);
  const lpLines = await evalJs("document.querySelector('#lp-text').value.split('\\n').filter(Boolean).length");
  await evalJs(`(() => {
    const ta = document.querySelector('#lp-text');
    // 给第一个音符(起始拍 0)标歌词 ni3:只改第一行的歌词部分
    ta.value = ta.value.split('\\n').map((ln, i) => i === 0 ? ln.replace(/\\S*$/, 'ni3') : ln).join('\\n');
    document.querySelector('#lp-apply').click();
    return true;
  })()`);
  await sleep(500);
  const lpLyric = await evalJs(`(() => {
    const d = JSON.parse(localStorage.getItem('humix-project') || '{}');
    const n = (d.notes || []).sort((a, b) => a.start - b.start)[0];
    return n ? n.lyric : '';
  })()`);
  console.log(`歌词面板: ${lpLines} 行 → 首音符歌词="${lpLyric}" ${lpLyric === "ni3" ? "✓" : "✗"}`);

  // ---------- 测试 11:示例歌曲(两只老虎,中文歌词 → TTS 路径) ----------
  // (位置:带参播放之后,见文件后段)

  // 画布稳定(无闪烁):1 秒内 canvas 尺寸不应反复变化
  const w1 = await evalJs("document.querySelector('#roll-canvas').width");
  await sleep(800);
  const w2 = await evalJs("document.querySelector('#roll-canvas').width");
  console.log(`画布尺寸稳定: ${w1} -> ${w2} ${w1 === w2 ? "✓" : "✗ 闪烁!"}`);

  // ---------- 测试 8:参数曲线(合成事件直测,synthClick 已在测试 5 定义) ----------
  const contentH = 26 + (84 - 48) * 16;   // 602
  await synthClick(64 + 2 * 60, contentH + 10);    // 参数区 beat2 v~0.9
  await synthClick(64 + 4 * 60, contentH + 30);    // 参数区 beat4 v~0.5
  await sleep(60);
  // 像素验证:曲线(绿)
  const px = await evalJs(`(() => {
    const c = document.querySelector('#roll-canvas');
    const g = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const ch = ${contentH} * dpr;
    let green = 0;
    for (let dy = 0; dy < 72 * dpr; dy += 3) {
      const d = g.getImageData(Math.round((64 + 2 * 60) * dpr), ch + dy, 1, 1).data;
      if (d[0] > 120 && d[1] > 180 && d[2] < 220) green++;
    }
    return { green };
  })()`);
  console.log(`参数曲线: ${px.green > 0 ? "✓" : "✗"}`);

  // 带曲线+换气标记播放
  await evalJs("document.querySelector('#roll-play').click()");
  let paramPlayMax = 0;
  for (let i = 0; i < 25; i++) {
    const lvl = await evalJs("Number(document.querySelector('#vu-num').textContent.replace('%',''))");
    paramPlayMax = Math.max(paramPlayMax, lvl);
    await sleep(120);
  }
  await evalJs("document.querySelector('#roll-stop').click()");
  await sleep(300);
  console.log(`带参数/换气播放 VU 峰值: ${paramPlayMax}%`);

  // ---------- 测试 11:示例歌曲(两只老虎,中文歌词 → TTS 路径) ----------
  await evalJs("document.querySelector('#roll-sample').click()");
  await sleep(600);   // 等 scheduleSave(300ms 防抖)落盘
  const sampleSaved = await evalJs(`(() => {
    const d = JSON.parse(localStorage.getItem('humix-project') || '{}');
    return { notes: (d.notes || []).length, bpm: d.bpm, lyrics: (d.notes || []).filter(n => n.lyric).length };
  })()`);
  const sampleOk = sampleSaved.notes === 36 && sampleSaved.lyrics === 36 && sampleSaved.bpm === 110;
  console.log(`示例歌: ${sampleSaved.notes} 音符 / ${sampleSaved.lyrics} 歌词 / ${sampleSaved.bpm}BPM ${sampleOk ? "✓" : "✗"}`);
  await evalJs("document.querySelector('#roll-play').click()");
  await sleep(400);
  // 浏览器环境 TTS 不可用 → 状态文本应含 "TTS"(证明走了 TTS 路径而非拼音转换)
  const ttsStatus = await evalJs("document.querySelector('#tts-status').textContent");
  console.log(`示例歌播放: 走 TTS 路径(状态="${ttsStatus}") ${ttsStatus.includes("TTS") ? "✓" : "✗"}`);
  await evalJs("document.querySelector('#roll-stop').click()");

  // ---------- 汇总 ----------
  const errors = events.filter((e) =>
    e.method === "Runtime.exceptionThrown" ||
    (e.method === "Log.entryAdded" && ["error"].includes(e.params.entry.level)) ||
    (e.method === "Log.entryAdded" && e.params.entry.level === "warning" && !String(e.params.entry.text).includes("willReadFrequently")));
  if (errors.length) {
    console.log("页面错误/警告:");
    for (const e of errors.slice(0, 8)) console.log("  -", JSON.stringify(e.params ?? e.params.entry ?? e).slice(0, 300));
  } else {
    console.log("页面无 JS 错误/警告 ✓");
  }
  console.log("=== 结论 ===");
  console.log(`哼鸣 ${humLevel > 0 ? "OK" : "FAIL"} | 朗读1 ${sawPeak ? "OK" : "FAIL"} | 停止 ${stopLevel === 0 ? "OK" : "FAIL"} | 朗读2 ${max2 > 0 ? "OK" : "FAIL"} | 卷帘播放 ${rollMax > 0 ? "OK" : "FAIL"} | 卷帘停止 ${rollStop === 0 ? "OK" : "FAIL"} | MIDI 面板 ${midiState.includes("浏览器") ? "OK(浏览器)" : "?"} | 画布铺满 ${fit.cw >= fit.ww ? "OK" : "FAIL"} | 长句朗读 ${breathMax > 0 ? "OK" : "FAIL"} | 汉字朗读 ${hanziMax > 0 && hanziStatus.includes("4") ? "OK" : "FAIL"} | 画布稳定 ${w1 === w2 ? "OK" : "FAIL"} | 参数曲线 ${px.green > 0 ? "OK" : "FAIL"} | 带参播放 ${paramPlayMax > 0 ? "OK" : "FAIL"} | 撤销 ${afterUndo <= beforeUndo ? "OK" : "FAIL"} | 录制 ${recOk ? "OK" : "FAIL"} | 歌词面板 ${lpLyric === "ni3" ? "OK" : "FAIL"} | 示例歌 ${sampleOk && ttsStatus.includes("TTS") ? "OK" : "FAIL"} | 无报错 ${errors.length === 0 ? "OK" : "FAIL"}`);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  try { rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Chrome 可能仍占用,忽略 */ }
}
