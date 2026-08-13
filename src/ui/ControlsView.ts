// ============ 控制面板:元音/气息/明亮度/颤音/音量/拼音朗读 ============

import { AudioEngine } from "../core/AudioEngine";
import { VoiceEngine } from "../core/VoiceEngine";
import { parseWithBreaks } from "../pinyin/PinyinParser";
import { VOICE } from "../core/VoiceData";

export class ControlsView {
  constructor(audio: AudioEngine, voice: VoiceEngine) {
    // 明亮度
    const bright = document.getElementById("bright") as HTMLInputElement;
    bright.addEventListener("input", () => {
      voice.brightness = Number(bright.value) / 100;
      document.getElementById("bright-val")!.textContent = bright.value + "%";
    });

    // 颤音
    const vib = document.getElementById("vib") as HTMLInputElement;
    vib.addEventListener("input", () => {
      audio.vibrato = Number(vib.value) / 100;
      document.getElementById("vib-val")!.textContent = vib.value + "%";
    });

    // 音量
    const volume = document.getElementById("volume") as HTMLInputElement;
    volume.addEventListener("input", () => {
      audio.volume = Number(volume.value) / 100;
      document.getElementById("volume-val")!.textContent = volume.value + "%";
    });

    // 混响
    const reverb = document.getElementById("reverb") as HTMLInputElement;
    reverb.addEventListener("input", () => {
      audio.reverb = Number(reverb.value) / 100;
      document.getElementById("reverb-val")!.textContent = reverb.value + "%";
    });

    // 移调(哼鸣 + 卷帘播放)
    const transpose = document.getElementById("transpose") as HTMLInputElement;
    transpose.addEventListener("input", () => {
      voice.transpose = Number(transpose.value);
      document.getElementById("transpose-val")!.textContent = transpose.value;
    });

    // 首次交互解锁 AudioContext
    window.addEventListener("pointerdown", () => audio.resume(), { once: false });
    window.addEventListener("keydown", () => audio.resume(), { once: false });

    // ---------- 阶段 2:拼音朗读 ----------
    const pinyinInput = document.getElementById("pinyin-input") as HTMLInputElement;
    const speakBtn = document.getElementById("speak-btn") as HTMLButtonElement;
    const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
    const spRate = document.getElementById("sp-rate") as HTMLInputElement;
    const spPitch = document.getElementById("sp-pitch") as HTMLInputElement;

    const bindVal = (slider: HTMLInputElement, valId: string) => {
      slider.addEventListener("input", () => {
        document.getElementById(valId)!.textContent = slider.value + "%";
      });
    };
    bindVal(spRate, "sp-rate-val");
    bindVal(spPitch, "sp-pitch-val");

    const doSpeak = () => {
      const parsed = parseWithBreaks(pinyinInput.value);
      const status = document.getElementById("speak-status");
      if (!parsed.phonemes.length) {
        if (status) status.textContent = "无法识别,请输入拼音或中文";
        return;
      }
      if (status) status.textContent = `已识别 ${parsed.phonemes.length} 个音节`;
      voice.speak(parsed.phonemes, {
        rate: Number(spRate.value) / 100,
        base: VOICE.f0 * (Number(spPitch.value) / 100),
        pauses: parsed.pauses,
      });
    };
    speakBtn.addEventListener("click", async () => {
      await audio.resume();
      doSpeak();
    });
    pinyinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        audio.resume();
        doSpeak();
      }
    });
    stopBtn.addEventListener("click", () => voice.stopSpeech());
  }
}
