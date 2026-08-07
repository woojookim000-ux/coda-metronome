/**
 * 구간 이름 음성 안내.
 *
 * 브라우저 내장 음성합성(Web Speech API)을 쓴다. 파일을 받아둘 필요가 없고
 * 구간 이름을 사용자가 아무렇게나 지어도 그대로 읽어준다.
 *
 * 이 소리는 클릭과 달리 AudioContext를 거치지 않는다. 즉 오디오 클럭에
 * 예약할 수 없고 지연 보정도 적용되지 않는다. 말이 시작되는 시점이 수십 ms
 * 흔들린다는 뜻인데, 안내 음성에는 그 정도면 충분하다. 대신 한 마디 미리
 * 말해서 여유를 준다.
 */

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

/** 구간 이름이 한글인지 영문인지 보고 읽을 언어를 정한다 */
export function langOf(text: string) {
  return HANGUL.test(text) ? 'ko-KR' : 'en-US';
}

/**
 * 그 언어에 맞는 음성을 고른다.
 *
 * 구간 이름은 Intro/Chorus처럼 영어일 수도, 인트로/후렴처럼 한글일 수도 있다.
 * 한국어 음성으로 "Chorus"를 읽히면 "초루스"가 되므로 이름마다 따로 고른다.
 * 맞는 음성이 없으면 voice를 비워 두고 lang만 넘겨 브라우저가 고르게 한다.
 */
function pickVoice(lang: string) {
  const synth = window.speechSynthesis;
  if (!synth) return null;
  const voices = synth.getVoices();
  if (voices.length === 0) return null; // 아직 로딩 중

  const prefix = lang.slice(0, 2).toLowerCase();
  return (
    voices.find((v) => v.lang.toLowerCase().replace('_', '-') === lang.toLowerCase()) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ??
    null
  );
}

export function supportsSpeech() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
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
    // 음성 목록은 비동기로 채워지는 브라우저가 있다. 미리 한 번 훑어 둔다.
    window.speechSynthesis.getVoices();
  } catch {
    /* 미지원 */
  }
}

let lastText = '';
let lastAt = 0;

export function say(text: string, volume: number) {
  if (!supportsSpeech() || !text) return;
  const t = performance.now();
  // 재예약 등으로 같은 안내가 두 번 나가지 않도록
  if (text === lastText && t - lastAt < 800) return;
  lastText = text;
  lastAt = t;

  try {
    const synth = window.speechSynthesis;
    synth.cancel(); // 이전 안내가 남아 있으면 겹치지 않게 끊는다
    const u = new SpeechSynthesisUtterance(text);
    const lang = langOf(text);
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.lang = lang;
    u.rate = 1.15; // 한 마디 안에 끝나도록 살짝 빠르게
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
