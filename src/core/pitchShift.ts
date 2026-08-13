// ============ 变调器(自己实现):重采样变音高 + 相位声码器时间拉伸 ============
// 第一步:线性重采样 → 频率 ×pitch,时长 ÷pitch
// 第二步:相位声码器(phase vocoder)时间拉伸 → 时长 ×(pitch·stretch)
//   STFT 幅度谱保持(共振峰/音色不变)、相位按瞬时频率累加(无粒状跳变)
// 结果:音高 ×pitch,时长 ×stretch,共振峰保留 —— 变调不"鸭子"

// ---------- FFT(radix-2,就地) ----------
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n <= 1) return;
  // 位反转
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * cRe - im[i + k + len / 2] * cIm;
        const vIm = re[i + k + len / 2] * cIm + im[i + k + len / 2] * cRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const ncRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = ncRe;
      }
    }
  }
}

function ifft(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < re.length; i++) im[i] = -im[i];
  fft(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

// ---------- 相位声码器时间拉伸(音高不变) ----------
function phaseVocoderStretch(input: Float32Array, stretch: number): Float32Array {
  if (Math.abs(stretch - 1) < 0.02) return input;
  // N 自适应:输入短时用小窗(保证至少几帧),长输入用 8192(频率精度)
  let N = 8192;
  while (N > 1024 && N > input.length / 4) N >>= 1;
  const ha = N / 4;                              // 输入 hop
  const hs = Math.max(1, Math.round(ha * stretch));
  // 汉宁窗
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const outLen = Math.floor(input.length * stretch) + N;
  const out = new Float32Array(outLen);
  const gain = new Float32Array(outLen);
  const inPhasePrev = new Float32Array(N / 2 + 1);   // 输入帧相位(逐帧更新)
  const outPhase = new Float32Array(N / 2 + 1);      // 输出相位(累加)
  const frame = new Float32Array(N);
  const fftBufRe = new Float32Array(N);
  const fftBufIm = new Float32Array(N);
  const sig = new Float32Array(N);
  let frameOut = 0;
  let maxPos = 0;
  for (let frameIn = 0; frameIn + N < input.length; frameIn += ha, frameOut += hs) {
    for (let i = 0; i < N; i++) frame[i] = input[frameIn + i] * win[i];
    fftBufRe.set(frame);
    fftBufIm.fill(0);
    fft(fftBufRe, fftBufIm);
    // 逐 bin:输入相位差 → 瞬时频率 → 输出相位累加(幅度谱保持 → 共振峰不变)
    for (let b = 0; b <= N / 2; b++) {
      const mag = Math.hypot(fftBufRe[b], fftBufIm[b]);
      const ph = Math.atan2(fftBufIm[b], fftBufRe[b]);
      const dp = ph - inPhasePrev[b] - (2 * Math.PI * b * ha) / N;
      const dpc = dp - 2 * Math.PI * Math.round(dp / (2 * Math.PI));
      const freq = (2 * Math.PI * b) / N + dpc / ha;
      outPhase[b] += freq * hs;
      fftBufRe[b] = mag * Math.cos(outPhase[b]);
      fftBufIm[b] = mag * Math.sin(outPhase[b]);
      inPhasePrev[b] = ph;
    }
    ifft(fftBufRe, fftBufIm);
    for (let i = 0; i < N; i++) {
      sig[i] = fftBufRe[i] * win[i];
      if (frameOut + i < outLen) {
        out[frameOut + i] += sig[i];
        gain[frameOut + i] += win[i] * win[i];
        if (frameOut + i > maxPos) maxPos = frameOut + i;
      }
    }
  }
  for (let i = 0; i < maxPos; i++) {
    if (gain[i] > 1e-4) out[i] /= gain[i];
  }
  return out.subarray(0, maxPos);
}

// ---------- 主入口 ----------
export function grainShift(
  input: Float32Array,
  pitch: number,
  stretch: number,
  _grainSec = 0.03,
  _hopSec = 0.01,
): Float32Array {
  // 1) 重采样变音高
  const rOutLen = Math.max(2, Math.floor(input.length / pitch));
  const r = new Float32Array(rOutLen);
  for (let i = 0; i < rOutLen; i++) {
    const src = i * pitch;
    const i0 = Math.floor(src);
    if (i0 >= input.length - 1) { r[i] = input[input.length - 1]; continue; }
    const fr = src - i0;
    r[i] = input[i0] * (1 - fr) + input[i0 + 1] * fr;
  }
  // 2) 相位声码器时间拉伸恢复时长
  return phaseVocoderStretch(r, stretch * pitch);
}
