// ============ HUMIX 入口:模块装配 ============
// core(音频/人声引擎)→ ui(琴键/控件)→ 装配

import { AudioEngine } from "./core/AudioEngine";
import { VoiceEngine } from "./core/VoiceEngine";
import { KeyboardView } from "./ui/KeyboardView";
import { ControlsView } from "./ui/ControlsView";
import { TtsView } from "./ui/TtsView";
import { MidiView } from "./ui/MidiView";
import { PianoRollView } from "./ui/PianoRollView";

// ---------- 核心 ----------
export const audio = new AudioEngine();
(window as any).__engine = audio;   // 调试/自动化测试钩子
export const voice = new VoiceEngine(audio);

// ---------- 视图 ----------
const keyboard = new KeyboardView(voice);
new PianoRollView(audio, voice, keyboard);
new ControlsView(audio, voice);
new MidiView(keyboard);
new TtsView(audio);

// 输出电平表
const vuFill = document.getElementById("vu-fill") as HTMLElement;
const vuNum = document.getElementById("vu-num") as HTMLElement;
function vuLoop() {
  const lvl = audio.readLevel();
  const pct = Math.min(100, Math.round(Math.pow(lvl, 0.55) * 100));
  vuFill.style.width = pct + "%";
  vuNum.textContent = pct + "%";
  requestAnimationFrame(vuLoop);
}
vuLoop();

// 窗口控制(自绘标题栏)
async function initWindow() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    document.getElementById("tb-min")?.addEventListener("click", () => win.minimize());
    document.getElementById("tb-max")?.addEventListener("click", async () => {
      if (await win.isMaximized()) await win.unmaximize();
      else await win.maximize();
    });
    document.getElementById("tb-close")?.addEventListener("click", () => win.close());
  } catch {
    // 浏览器环境:无窗口控制
  }
}
initWindow();
