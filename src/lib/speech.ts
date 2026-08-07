/**
 * 구간 이름 음성 안내.
 *
 * 브라우저 내장 음성합성(Web Speech API)을 쓴다. 구간 이름을 사용자가 아무렇게나
 * 지어도 그대로 읽어준다.
 *
 * 주의할 점 두 가지.
 *
 * 1) utterance.voice를 비워 두면 브라우저 "기본 음성"이 읽는다. 그 기본값이
 *    영어라는 보장이 전혀 없다 — 실제로 크롬에서 기본값이 Google Deutsch라
 *    Chorus를 독일어 발음으로 읽었다. 그래서 반드시 음성을 명시한다.
 *
 * 2) getVoices()는 처음엔 빈 배열이고 voiceschanged 이후에 채워진다. 안내가
 *    나갈 때까지 기다려 주지 않으므로 모듈을 불러오는 시점부터 미리 채워 둔다.
 *
 * 이 소리는 AudioContext를 거치지 않는다. 오디오 클럭에 예약할 수 없고 지연
 * 보정도 받지 않는다는 뜻인데, 안내 음성에는 그 정도 오차면 충분하다.
 */

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

/** 영어 음성이 하나도 없을 때, 최소한 알아들을 수 있게 한글로 읽는다 */
const ROMAN_TO_HANGUL: Record<string, string> = {
  intro: '인트로',
  verse: '벌스',
  pre: '프리',
  chorus: '코러스',
  bridge: '브릿지',
  solo: '솔로',
  outro: '아웃트로',
  end: '끝',
  interlude: '간주',
  hook: '훅',
  drop: '드롭',
};

/** 구간 이름이 한글인지 영문인지 보고 읽을 언어를 정한다 */
export function langOf(text: string) {
  return HANGUL.test(text) ? 'ko-KR' : 'en-US';
}

let cachedVoices: SpeechSynthesisVoice[] = [];

function refreshVoices() {
  if (!supportsSpeech()) return;
  const v = window.speechSynthesis.getVoices();
  if (v.length) cachedVoices = v;
}

export function supportsSpeech() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// 목록이 늦게 채워지는 브라우저가 있어 최대한 일찍, 여러 번 시도한다
if (supportsSpeech()) {
  refreshVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
  for (const delay of [100, 400, 1200, 3000]) setTimeout(refreshVoices, delay);
}

export function listVoices() {
  refreshVoices();
  return cachedVoices;
}

/** 영어 음성 중 알아듣기 좋은 것부터 점수를 매긴다 */
const GOOD_EN = [
  'google us english',
  'samantha',
  'aria',
  'jenny',
  'guy',
  'zira',
  'david',
  'google uk english female',
  'google uk english male',
  'daniel',
  'alex',
];

function scoreEnglish(v: SpeechSynthesisVoice) {
  const name = v.name.toLowerCase();
  const lang = v.lang.toLowerCase().replace('_', '-');
  let score = 0;
  if (lang === 'en-us') score += 40;
  else if (lang.startsWith('en')) score += 25;
  const known = GOOD_EN.findIndex((g) => name.includes(g));
  if (known >= 0) score += 30 - known; // 앞쪽일수록 가산점
  if (name.includes('natural') || name.includes('enhanced') || name.includes('premium')) score += 8;
  return score;
}

/**
 * 그 언어에 맞는 음성. 없으면 null.
 * @param preferredName 사용자가 직접 고른 음성 이름 (영어에만 적용)
 */
export function pickVoice(lang: string, preferredName?: string) {
  refreshVoices();
  if (cachedVoices.length === 0) return null;

  const prefix = lang.slice(0, 2).toLowerCase();

  if (preferredName) {
    const chosen = cachedVoices.find((v) => v.name === preferredName);
    if (chosen && chosen.lang.toLowerCase().startsWith(prefix)) return chosen;
  }

  if (prefix === 'en') {
    const en = cachedVoices.filter((v) => v.lang.toLowerCase().startsWith('en'));
    if (en.length === 0) return null;
    return en.slice().sort((a, b) => scoreEnglish(b) - scoreEnglish(a))[0];
  }

  return (
    cachedVoices.find((v) => v.lang.toLowerCase().replace('_', '-') === lang.toLowerCase()) ??
    cachedVoices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ??
    null
  );
}

/** 지금 영어를 제대로 읽어줄 음성이 있는가 */
export function hasEnglishVoice() {
  return pickVoice('en-US') !== null;
}

/**
 * iOS는 사용자 제스처 안에서 한 번 speak를 호출해 두지 않으면
 * 이후 호출이 조용히 무시된다. 소리 켜기 버튼에서 같이 불러 준다.
 */
export function primeSpeech() {
  if (!supportsSpeech()) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
    refreshVoices();
  } catch {
    /* 미지원 */
  }
}

let lastText = '';
let lastAt = 0;

export function say(text: string, volume: number, preferredName?: string) {
  if (!supportsSpeech() || !text) return;
  const t = performance.now();
  // 재예약 등으로 같은 안내가 두 번 나가지 않도록
  if (text === lastText && t - lastAt < 800) return;
  lastText = text;
  lastAt = t;

  try {
    const synth = window.speechSynthesis;
    synth.cancel(); // 이전 안내가 남아 있으면 겹치지 않게 끊는다

    let spoken = text;
    let lang = langOf(text);
    let voice = pickVoice(lang, lang === 'en-US' ? preferredName : undefined);

    // 영어 음성이 아예 없으면 기본 음성이 엉뚱한 언어로 읽는다.
    // 차라리 한글로 옮겨 적어 또박또박 들리게 한다.
    if (lang === 'en-US' && !voice) {
      const mapped = ROMAN_TO_HANGUL[text.trim().toLowerCase()];
      if (mapped) {
        spoken = mapped;
        lang = 'ko-KR';
        voice = pickVoice('ko-KR');
      }
    }

    const u = new SpeechSynthesisUtterance(spoken);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? lang;
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = Math.min(1, Math.max(0, volume));
    synth.speak(u);
  } catch {
    /* 미지원 */
  }
}

export function stopSpeaking() {
  if (!supportsSpeech()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* 미지원 */
  }
}
