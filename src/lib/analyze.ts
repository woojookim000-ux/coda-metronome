/**
 * 음원에서 템포와 구간 경계를 추정한다.
 *
 * 전부 브라우저 안에서 돈다. 파일이 서버로 올라가지 않는다.
 *
 * 신뢰도를 미리 밝혀 두면:
 *  - BPM은 템포가 일정한 곡이면 꽤 잘 맞는다. 다만 2배/절반으로 잡는 실수가
 *    가끔 있어서 화면에서 한 번에 고칠 수 있게 해 두었다.
 *  - 구간 경계는 어디까지나 초안이다. 소리가 크게 바뀌는 지점을 찾는 것이라
 *    악곡 구조와 항상 일치하지는 않는다. 손으로 고치는 걸 전제로 한다.
 *  - 구간 "이름"은 추정하지 않는다. 그건 사람이 붙이는 게 훨씬 정확하다.
 */

// ---------------------------------------------------------------- FFT

/** 제자리 radix-2 FFT */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < half; j++) {
        const ar = re[i + j];
        const ai = im[i + j];
        const br = re[i + j + half] * cr - im[i + j + half] * ci;
        const bi = re[i + j + half] * ci + im[i + j + half] * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + half] = ar - br;
        im[i + j + half] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// ---------------------------------------------------------------- 타입

export type Analysis = {
  bpm: number;
  /** 첫 박이 놓인 시각(초) */
  beatOffsetSec: number;
  /** 구간이 바뀐다고 본 지점(초) */
  boundariesSec: number[];
  durationSec: number;
  /** 0~1. 자동 결과를 얼마나 믿을 만한지 대략의 눈금. */
  confidence: number;
};

const FRAME = 1024;
const HOP = 256;

// ---------------------------------------------------------------- 전처리

function toMono(buffer: AudioBuffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  const scale = 1 / Math.max(1, buffer.numberOfChannels);
  for (let i = 0; i < n; i++) out[i] *= scale;
  return out;
}

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- 스펙트럼

/**
 * 프레임마다 스펙트럼을 구해서 두 가지를 뽑는다.
 *  - onset: 직전 프레임보다 커진 성분의 합. 소리가 새로 시작하는 지점에서 튄다.
 *  - bands: 대역별 에너지. 나중에 구간 나눌 때 음색이 비슷한지 재는 데 쓴다.
 */
async function spectralFeatures(
  mono: Float32Array,
  sampleRate: number,
  onProgress?: (p: number) => void
) {
  const frames = Math.max(1, Math.floor((mono.length - FRAME) / HOP));
  const bins = FRAME >> 1;
  const BANDS = 24;

  // 60Hz~8kHz를 로그 간격으로 나눈 대역 경계
  const edges: number[] = [];
  for (let i = 0; i <= BANDS; i++) {
    const f = 60 * Math.pow(8000 / 60, i / BANDS);
    edges.push(Math.min(bins - 1, Math.max(1, Math.round((f / sampleRate) * FRAME))));
  }

  const win = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

  const onset = new Float32Array(frames);
  const bands = new Float32Array(frames * BANDS);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  let prev = new Float32Array(bins);
  let mag = new Float32Array(bins);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = mono[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);

    let flux = 0;
    for (let k = 1; k < bins; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag[k] = m;
      const d = m - prev[k];
      if (d > 0) flux += d;
    }
    onset[f] = flux;

    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) sum += mag[k] * mag[k];
      bands[f * BANDS + b] = Math.log(1 + sum * 1000);
    }

    const swap = prev;
    prev = mag;
    mag = swap;

    if ((f & 511) === 0) {
      onProgress?.(f / frames);
      await yieldToUi();
    }
  }

  return { onset, bands, bandCount: BANDS, frames, fps: sampleRate / HOP };
}

/** 느린 흐름을 빼서 순간적인 튐만 남긴다 */
function sharpen(x: Float32Array, span: number) {
  const out = new Float32Array(x.length);
  let sum = 0;
  const q: number[] = [];
  for (let i = 0; i < x.length; i++) {
    q.push(x[i]);
    sum += x[i];
    if (q.length > span) sum -= q.shift() as number;
    out[i] = Math.max(0, x[i] - sum / q.length);
  }
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}

// ---------------------------------------------------------------- 템포

function autocorr(env: Float32Array, lag: number) {
  const base = Math.floor(lag);
  const frac = lag - base;
  const n = env.length - base - 1;
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = env[i + base];
    const b = env[i + base + 1];
    sum += env[i] * (a + (b - a) * frac);
  }
  return sum / n;
}

/**
 * 박 간격을 찾는다.
 *
 * 자기상관은 2배·절반 간격에서도 크게 나온다. 그래서 사람이 실제로 박으로
 * 느끼는 범위에 가중치를 줘서 고른다.
 */
function detectTempo(env: Float32Array, fps: number) {
  const score = (bpm: number) => {
    const lag = (fps * 60) / bpm;
    if (lag < 2 || lag * 4 >= env.length) return 0;
    // 박 간격과 그 배수에서 함께 커야 진짜 박이다
    const s = autocorr(env, lag) + 0.6 * autocorr(env, lag * 2) + 0.35 * autocorr(env, lag * 4);
    const bias = Math.exp(-0.5 * Math.pow(Math.log(bpm / 120) / 0.55, 2));
    return s * bias;
  };

  let best = 120;
  let bestScore = -1;
  for (let bpm = 55; bpm <= 210; bpm += 0.25) {
    const s = score(bpm);
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  for (let bpm = best - 0.5; bpm <= best + 0.5; bpm += 0.01) {
    const s = score(bpm);
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }

  const raw = score(best);
  const rival = Math.max(score(best / 2), score(best * 2));
  const confidence = raw > 0 ? Math.max(0, Math.min(1, 1 - rival / raw)) : 0;
  return { bpm: best, confidence };
}

/** 박이 어느 위치에서 시작하는지 (첫 박 오프셋) */
function detectPhase(env: Float32Array, fps: number, bpm: number) {
  const period = (fps * 60) / bpm;
  let bestOff = 0;
  let bestScore = -1;
  for (let off = 0; off < period; off += 0.25) {
    let sum = 0;
    for (let k = 0; ; k++) {
      const i = Math.round(off + k * period);
      if (i >= env.length) break;
      sum += env[i];
    }
    if (sum > bestScore) {
      bestScore = sum;
      bestOff = off;
    }
  }
  return bestOff / fps;
}

// ---------------------------------------------------------------- 구간 경계

/**
 * 구간 경계 찾기.
 *
 * 곡을 짧은 토막으로 잘라 음색이 얼마나 비슷한지 서로 비교한다. 앞뒤가 각각
 * 서로 닮았지만 앞과 뒤끼리는 안 닮은 지점이 구간이 바뀌는 자리다.
 */
function detectBoundaries(
  bands: Float32Array,
  bandCount: number,
  frames: number,
  fps: number,
  durationSec: number
) {
  const BLOCK_SEC = 0.5;
  const framesPerBlock = Math.max(1, Math.round(BLOCK_SEC * fps));
  const blocks = Math.floor(frames / framesPerBlock);
  if (blocks < 16) return [];

  // 토막마다 대역 에너지를 평균내고 길이를 1로 맞춘다 (음량 차이를 무시하려고)
  const vec = new Float32Array(blocks * bandCount);
  for (let b = 0; b < blocks; b++) {
    for (let f = 0; f < framesPerBlock; f++) {
      const src = (b * framesPerBlock + f) * bandCount;
      for (let k = 0; k < bandCount; k++) vec[b * bandCount + k] += bands[src + k];
    }
    let norm = 0;
    for (let k = 0; k < bandCount; k++) norm += vec[b * bandCount + k] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < bandCount; k++) vec[b * bandCount + k] /= norm;
  }

  const sim = (i: number, j: number) => {
    let s = 0;
    for (let k = 0; k < bandCount; k++) s += vec[i * bandCount + k] * vec[j * bandCount + k];
    return s;
  };

  // 체커보드 커널: 앞뒤가 각각 닮고 서로는 안 닮을수록 값이 커진다
  const L = Math.max(4, Math.round(4 / BLOCK_SEC)); // 앞뒤 4초씩
  const novelty = new Float32Array(blocks);
  for (let c = L; c < blocks - L; c++) {
    let same = 0;
    let cross = 0;
    for (let i = 1; i <= L; i++) {
      for (let j = 1; j <= L; j++) {
        same += sim(c - i, c - j) + sim(c + i - 1, c + j - 1);
        cross += sim(c - i, c + j - 1);
      }
    }
    novelty[c] = same / (2 * L * L) - cross / (L * L);
  }

  let mean = 0;
  for (const v of novelty) mean += v;
  mean /= blocks;
  let sd = 0;
  for (const v of novelty) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / blocks) || 1;

  // 너무 촘촘한 경계는 곡 구조가 아니라 잔가지다
  const minGap = Math.round(6 / BLOCK_SEC);
  const picked: number[] = [];
  const order = Array.from(novelty.keys()).sort((a, b) => novelty[b] - novelty[a]);
  for (const c of order) {
    if (novelty[c] < mean + 1.0 * sd) break;
    if (picked.some((p) => Math.abs(p - c) < minGap)) continue;
    picked.push(c);
    if (picked.length >= 24) break;
  }

  // 커널 폭(앞뒤 4초)만큼은 비교할 재료가 모자라 값이 믿을 게 못 된다.
  // 특히 곡이 끝나며 조용해지는 지점이 구간 변화로 잡히곤 한다.
  const margin = L * BLOCK_SEC;
  return picked
    .map((b) => b * BLOCK_SEC)
    .filter((t) => t > margin && t < durationSec - margin)
    .sort((a, b) => a - b);
}

/** 소리가 실질적으로 멎는 시각. 뒤에 붙은 무음을 잘라 내려고 쓴다. */
function musicalEnd(env: Float32Array, fps: number, fallbackSec: number) {
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length || 1;
  const floor = mean * 0.25;
  for (let i = env.length - 1; i >= 0; i--) {
    if (env[i] > floor) return Math.min(fallbackSec, (i + 1) / fps);
  }
  return fallbackSec;
}

// ---------------------------------------------------------------- 진입점

export async function analyzeAudio(
  buffer: AudioBuffer,
  onProgress?: (p: number) => void
): Promise<Analysis> {
  const mono = toMono(buffer);
  const { onset, bands, bandCount, frames, fps } = await spectralFeatures(
    mono,
    buffer.sampleRate,
    (p) => onProgress?.(p * 0.8)
  );

  const env = sharpen(onset, Math.round(fps * 0.35));
  onProgress?.(0.85);
  await yieldToUi();

  const { bpm, confidence } = detectTempo(env, fps);
  const beatOffsetSec = detectPhase(env, fps, bpm);
  onProgress?.(0.92);
  await yieldToUi();

  // 음악이 실제로 끝나는 지점. 뒤에 붙은 무음이나 페이드아웃을 그대로 두면
  // 소리가 사라지는 자리를 구간이 바뀌는 것으로 오인한다.
  const endSec = musicalEnd(env, fps, buffer.duration);

  const boundariesSec = detectBoundaries(bands, bandCount, frames, fps, endSec);
  onProgress?.(1);

  return {
    bpm: Math.round(bpm * 10) / 10,
    beatOffsetSec,
    boundariesSec,
    durationSec: endSec,
    confidence,
  };
}

/** 초 단위 경계를 마디 수로 바꾼다 */
export function boundariesToBars(
  boundariesSec: number[],
  durationSec: number,
  bpm: number,
  beatsPerBar: number,
  beatOffsetSec: number
) {
  const barSec = (60 / bpm) * beatsPerBar;
  const toBar = (t: number) => Math.max(0, Math.round((t - beatOffsetSec) / barSec));

  const marks = [0, ...boundariesSec.map(toBar), toBar(durationSec)];
  const uniq = [...new Set(marks)].sort((a, b) => a - b);

  const out: number[] = [];
  for (let i = 1; i < uniq.length; i++) {
    const bars = uniq[i] - uniq[i - 1];
    if (bars > 0) out.push(bars);
  }
  return out;
}
