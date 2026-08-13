// ============ MIDI 输入视图:设备选择 + midi-in 事件 → 琴键同路径 ============
// Rust 层(midir)已注册命令:midi_list_devices / midi_start_input / midi_stop_input
// 消息以 "midi-in" 事件(载荷 number[] = [status, note, vel])发到前端

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { KeyboardView } from "./KeyboardView";

export class MidiView {
  private keyboard: KeyboardView;
  private unlisten: UnlistenFn | null = null;
  private connected = false;
  private el: HTMLSelectElement;
  private btn: HTMLButtonElement;
  private statusEl: HTMLElement;

  constructor(keyboard: KeyboardView) {
    this.keyboard = keyboard;
    this.el = document.getElementById("midi-in-select") as HTMLSelectElement;
    this.btn = document.getElementById("midi-connect") as HTMLButtonElement;
    this.statusEl = document.getElementById("midi-status") as HTMLElement;
    this.btn.addEventListener("click", () => this.toggle());
    this.init();
  }

  private async init() {
    try {
      const [inputs] = await invoke<[string[], string[]]>("midi_list_devices");
      this.el.innerHTML = "";
      if (!inputs.length) {
        this.el.innerHTML = '<option value="-1">MIDI 输入:未检测到设备</option>';
        this.statusEl.textContent = "未连接";
        return;
      }
      inputs.forEach((name, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = name;
        this.el.appendChild(opt);
      });
      this.statusEl.textContent = "已就绪,选择设备后连接";
    } catch {
      // 浏览器环境(非 Tauri 窗口):无原生 MIDI
      this.el.innerHTML = '<option value="-1">MIDI 输入:仅桌面应用可用</option>';
      this.statusEl.textContent = "浏览器环境";
      this.btn.disabled = true;
    }
  }

  private async toggle() {
    if (this.connected) {
      this.disconnect();
      return;
    }
    const port = Number(this.el.value);
    if (port < 0) return;
    try {
      const name = await invoke<string>("midi_start_input", { port });
      this.unlisten = await listen<number[]>("midi-in", (e) => this.handleMidi(e.payload));
      this.connected = true;
      this.btn.textContent = "断开";
      this.statusEl.textContent = `已连接 ${name}`;
    } catch (err) {
      this.statusEl.textContent = "连接失败: " + String(err).slice(0, 40);
    }
  }

  private disconnect() {
    this.connected = false;
    this.btn.textContent = "连接";
    this.statusEl.textContent = "未连接";
    this.unlisten?.();
    this.unlisten = null;
    invoke("midi_stop_input").catch(() => {});
  }

  // 解析 MIDI 消息:note on/off → 琴键(含 LED 与高亮)
  private handleMidi(data: number[]) {
    if (data.length < 2) return;
    const status = data[0] & 0xf0;
    const note = data[1];
    if (status === 0x90) {
      const vel = data[2] ?? 127;
      if (vel > 0) this.keyboard.press(note, Math.min(1, vel / 127));
      else this.keyboard.release(note);
    } else if (status === 0x80) {
      this.keyboard.release(note);
    }
  }
}
