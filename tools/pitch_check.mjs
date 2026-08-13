// 音高检测:播放单个音符,从 master analyser 采样时域 → 过零测实际输出频率
// 验证演唱引擎的变调是否正确(合成延音 + 素材字头)
const WS = globalThis.WebSocket;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://localhost:1421/";
const PORT = 9223;
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
const pending = new Map();
let msgId = 0;
function cdp(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

async function main() {
  // 启动 headless Chrome
  const userData = `C:/Users/Admin/AppData/Local/Temp/humix-pitch-${Date.now()}`;
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--mute-audio", `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`, "--autoplay-policy=no-user-gesture-required", URL,
  ], { stdio: "ignore" });
  // 等 CDP
  let targets = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      if (targets.length) break;
    } catch { /* 还没起 */ }
  }
  const page = targets.find((t) => t.type === "page");
  ws = new WS(page.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
  };
  await cdp("Runtime.enable");
  await sleep(1500);
  console.log("页面已连接");

  // 清空 → 添加 C4 音符(beat 0,4 拍,歌词 a1)
  await evalJs(`(() => {
    const d = { bpm: 120, notes: [{ id: 1, midi: 60, start: 0, dur: 4, lyric: "a1" }], params: {}, breaths: [] };
    localStorage.setItem('humix-project', JSON.stringify(d));
    location.reload();
    return true;
  })()`);
  await sleep(2500);

  // 播放
  await evalJs("document.querySelector('#roll-play').click()");
  await sleep(600);

  // 从 master analyser 采样,自相关测基频(谐波稳健,async 多帧)
  const sample = `(async () => {
    const an = window.__engine.analyser;
    const ctx = window.__engine.ctx;
    const sr = ctx.sampleRate;
    const buf = new Uint8Array(an.fftSize);
    const x = new Float64Array(an.fftSize);
    const autoCorrF0 = () => {
      let mean = 0;
      for (const v of buf) mean += v / 128 - 1;
      mean /= buf.length;
      for (let i = 0; i < buf.length; i++) x[i] = buf[i] / 128 - 1 - mean;
      let bestLag = 0, bestR = -1;
      for (let lag = Math.floor(sr / 900); lag < Math.floor(sr / 50); lag++) {
        let r = 0;
        for (let i = 0; i < buf.length - lag; i++) r += x[i] * x[i + lag];
        if (r > bestR) { bestR = r; bestLag = lag; }
      }
      return sr / bestLag;
    };
    let best = 0;
    for (let k = 0; k < 8; k++) {
      an.getByteTimeDomainData(buf);
      const f0 = autoCorrF0();
      if (f0 > 40 && f0 < 1500) best = f0;
      await new Promise(r => setTimeout(r, 150));
    }
    return Math.round(best);
  })()`;
  const f = await evalJs(sample);
  console.log("C4(期望 261.6Hz)实际输出:", f, "Hz", Math.abs(f - 261.6) < 15 ? "✓" : "✗");

  // D4(62=293.7)验证
  await evalJs(`(() => {
    const d = { bpm: 120, notes: [{ id: 1, midi: 62, start: 0, dur: 4, lyric: "a1" }], params: {}, breaths: [] };
    localStorage.setItem('humix-project', JSON.stringify(d));
    location.reload();
    return true;
  })()`);
  await sleep(2500);
  await evalJs("document.querySelector('#roll-play').click()");
  await sleep(600);
  const f2 = await evalJs(`(async () => {
    const an = window.__engine.analyser;
    const ctx = window.__engine.ctx;
    const sr = ctx.sampleRate;
    const buf = new Uint8Array(an.fftSize);
    const x = new Float64Array(an.fftSize);
    const autoCorrF0 = () => {
      let mean = 0;
      for (const v of buf) mean += v / 128 - 1;
      mean /= buf.length;
      for (let i = 0; i < buf.length; i++) x[i] = buf[i] / 128 - 1 - mean;
      let bestLag = 0, bestR = -1;
      for (let lag = Math.floor(sr / 900); lag < Math.floor(sr / 50); lag++) {
        let r = 0;
        for (let i = 0; i < buf.length - lag; i++) r += x[i] * x[i + lag];
        if (r > bestR) { bestR = r; bestLag = lag; }
      }
      return sr / bestLag;
    };
    let best = 0;
    for (let k = 0; k < 8; k++) {
      an.getByteTimeDomainData(buf);
      const f0 = autoCorrF0();
      if (f0 > 40 && f0 < 1500) best = f0;
      await new Promise(r => setTimeout(r, 150));
    }
    return Math.round(best);
  })()`);
  console.log("D4(期望 293.7Hz)实际输出:", f2, "Hz", Math.abs(f2 - 293.7) < 15 ? "✓" : "✗");

  // G4(67=392.0)验证:示例歌最高音,素材变速幅度最大
  await evalJs(`(() => {
    const d = { bpm: 120, notes: [{ id: 1, midi: 67, start: 0, dur: 4, lyric: "a1" }], params: {}, breaths: [] };
    localStorage.setItem('humix-project', JSON.stringify(d));
    location.reload();
    return true;
  })()`);
  await sleep(2500);
  await evalJs("document.querySelector('#roll-play').click()");
  await sleep(600);
  const f3 = await evalJs(`(async () => {
    const an = window.__engine.analyser;
    const ctx = window.__engine.ctx;
    const sr = ctx.sampleRate;
    const buf = new Uint8Array(an.fftSize);
    const x = new Float64Array(an.fftSize);
    const autoCorrF0 = () => {
      let mean = 0;
      for (const v of buf) mean += v / 128 - 1;
      mean /= buf.length;
      for (let i = 0; i < buf.length; i++) x[i] = buf[i] / 128 - 1 - mean;
      let bestLag = 0, bestR = -1;
      for (let lag = Math.floor(sr / 900); lag < Math.floor(sr / 50); lag++) {
        let r = 0;
        for (let i = 0; i < buf.length - lag; i++) r += x[i] * x[i + lag];
        if (r > bestR) { bestR = r; bestLag = lag; }
      }
      return sr / bestLag;
    };
    let best = 0;
    for (let k = 0; k < 8; k++) {
      an.getByteTimeDomainData(buf);
      const f0 = autoCorrF0();
      if (f0 > 40 && f0 < 1500) best = f0;
      await new Promise(r => setTimeout(r, 150));
    }
    return Math.round(best);
  })()`);
  console.log("G4(期望 392.0Hz)实际输出:", f3, "Hz", Math.abs(f3 - 392.0) < 15 ? "✓" : "✗");

  ws.close();
  chrome.kill();
}
main().catch((e) => { console.error(e); process.exit(1); });
