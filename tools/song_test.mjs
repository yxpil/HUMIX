// 编一首《两只老虎》注入卷帘并播放验证(CDP)
const WS = globalThis.WebSocket;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://localhost:1421/";
const PORT = 9223;
import { spawn } from "child_process";
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  "--headless=new", "--disable-gpu", "--no-first-run",
  "--user-data-dir=C:/Users/Admin/AppData/Local/Temp/humix-cdp-song",
  "--autoplay-policy=no-user-gesture-required", URL,
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);
const pages = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
const page = pages.find((p) => p.type === "page");
const ws = new WS(page.webSocketDebuggerUrl);
let seq = 1;
const pending = new Map();
ws.addEventListener("message", (d) => {
  const m = JSON.parse(d.data.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const id = seq++;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((r) => ws.addEventListener("open", r));
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return "EXC: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

// 旋律:两只老虎(36 音,1 拍/音)
const M = [60, 62, 64, 60, 60, 62, 64, 60, 64, 65, 67, 67, 64, 65, 67, 67, 67, 69, 67, 65, 64, 60, 67, 69, 67, 65, 64, 60, 62, 67, 60, 60, 62, 67, 60, 60];
const LYR = "liang3 zhi1 lao3 hu3 liang3 zhi1 lao3 hu3 pao3 de2 kuai4 kuai4 pao3 de2 kuai4 kuai4 yi1 zhi1 mei2 you3 yan3 jing1 yi1 zhi1 mei2 you3 wei3 ba5 zhen1 qi2 guai4 guai4 zhen1 qi2 guai4 guai4".split(" ");
const notes = M.map((midi, i) => ({ id: i + 1, midi, start: i, dur: 1, lyric: LYR[i] ?? "" }));
const proj = { bpm: 110, notes, breaths: [], params: { breath: [], bright: [], vib: [], vel: [], pitch: [] } };
console.log("音符数:", notes.length, "| 歌词数:", LYR.length);

await evalJs(`localStorage.setItem('humix-project', ${JSON.stringify(JSON.stringify(proj))})`);
await evalJs("location.reload()");
await sleep(2600);

// 验证加载
const loaded = await evalJs(`(() => {
  const raw = localStorage.getItem('humix-project');
  const d = JSON.parse(raw || '{}');
  return { notes: (d.notes || []).length, bpm: d.bpm, first: (d.notes || [])[0] };
})()`);
console.log("加载工程:", JSON.stringify(loaded));

// 播放并采样 VU
await evalJs("document.querySelector('#roll-play').click()");
let peak = 0;
for (let i = 0; i < 60; i++) {
  const lvl = await evalJs("Number(document.querySelector('#vu-num').textContent.replace('%',''))");
  peak = Math.max(peak, lvl);
  await sleep(200);
}
console.log(`播放 VU 峰值: ${peak}% ${peak > 0 ? "✓ 歌在唱" : "✗"}`);
await evalJs("document.querySelector('#roll-stop').click()");
chrome.kill();
process.exit(0);
