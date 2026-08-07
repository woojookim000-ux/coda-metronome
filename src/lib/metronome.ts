import { Clock, now } from './clock';
import { langOf, primeSpeech, say, stopSpeaking } from './speech';
import { beatAtOrAfter, beatInfo, firstSectionName, timeOfBeat, type Timeline } from './timeline';
import { DEFAULT_PREFS, type LocalPrefs, type RoomState } from './types';

/**
 * 메트로놈 엔진.
 *
 * setInterval로 소리를 내면 브라우저 타이머 오차(수십 ms)가 그대로 들린다.
 * 그래서 여기서는 setInterval을 "앞으로 몇백 ms 안에 울릴 박을 미리 예약"하는
 * 용도로만 쓰고, 실제 발음 시각은 AudioContext의 오디오 클럭에 맡긴다.
 * (Web Audio의 표준 패턴 — "A Tale of Two Clocks")
 *
 * 예약할 시각은 서버시각 기준으로 계산한 뒤 Clock.offset으로 로컬 시각으로
 * 옮기므로, 모든 기기가 같은 순간에 소리를 낸다.
 */

const TICK_MS = 25; // 스케줄러가 도는 주기
const LOOKAHEAD_MS = 250; // 얼마나 앞까지 미리 예약할지
// 화면이 가려지면 브라우저가 setInterval을 1초 단위로 늦춘다. 오디오 스레드는
// 그대로 돌기 때문에, 미리 넉넉히 예약해 두면 알림창이 떠도 박이 끊기지 않는다.
const HIDDEN_LOOKAHEAD_MS = 3000;

/**
 * 오디오 클럭과 벽시계 사이의 대응 관계.
 *
 *   벽시계로 wall일 때 귀에 들리는 샘플의 컨텍스트 시각 t  →  wall = k + t*1000
 *
 * 이걸 매 박마다 그때그때 재보면 ctx.currentTime의 계단 단위(렌더 퀀텀)와
 * 두 시계를 읽는 시점 차이가 박마다 다른 오차로 실린다. 실제로 500ms 간격이
 * ±5ms씩 흔들렸다. 그래서 k를 한 번 잡고 천천히만 보정한다. 오디오 카드와
 * 시스템 시계의 드리프트는 아주 느리므로(보통 <50ppm) 이 정도면 충분하다.
 */
class AudioClockMap {
  /** 벽시계 = k + 컨텍스트시각*1000 */
  k = 0;
  private n = 0;

  reset() {
    this.n = 0;
  }

  get settled() {
    return this.n >= 20;
  }

  /** @returns 매핑이 크게 어긋나 다시 잡았으면 true */
  update(ctx: AudioContext): boolean {
    const ts = ctx.getOutputTimestamp?.();
    let ctxHeard: number;
    let wall: number;

    if (ts && ts.contextTime != null && ts.performanceTime != null && ts.contextTime > 0) {
      // 이 쌍은 "지금 스피커로 나가는 샘플"을 가리키므로 출력 지연이 이미 반영돼 있다
      ctxHeard = ts.contextTime;
      wall = performance.timeOrigin + ts.performanceTime;
    } else {
      // 폴백: currentTime은 들리는 지점보다 출력 지연만큼 앞서 있다
      const outLatency = (ctx as any).outputLatency ?? ctx.baseLatency ?? 0;
      ctxHeard = ctx.currentTime - outLatency;
      wall = now();
    }

    const sample = wall - ctxHeard * 1000;

    // 화면이 꺼지거나 다른 앱으로 갔다 오면 오디오 컨텍스트가 멈췄다 재개되고,
    // 그동안 ctx.currentTime이 서 있었으므로 매핑이 통째로 어긋난다.
    // 느린 보정으로 따라가면 몇 초 동안 박이 틀리므로 즉시 다시 잡는다.
    if (this.n > 0 && Math.abs(sample - this.k) > 50) {
      this.k = sample;
      this.n = 1;
      return true;
    }

    this.n++;
    // 초반에는 단순 평균으로 빠르게 수렴시키고, 자리를 잡으면 느린 보정으로
    // 넘어간다. 처음부터 느린 보정만 쓰면 첫 몇 초 동안 박이 흔들린다.
    const alpha = Math.max(0.02, 1 / this.n);
    this.k += (sample - this.k) * alpha;
    return false;
  }

  /** 이 벽시계 시각에 "들리도록" 하려면 몇 초에 예약해야 하는가 */
  toCtxTime(wallMs: number) {
    return (wallMs - this.k) / 1000;
  }
}

export class MetronomeEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private mapTimer: number | null = null;

  private state: RoomState | null = null;
  private prefs: LocalPrefs = DEFAULT_PREFS;
  private audioMap = new AudioClockMap();

  private timeline: Timeline | null = null;
  /** 다음에 예약할 논리 박 (음수면 카운트인) */
  private nextBeat = 0;
  /** 지금 예약돼 있는 소리들을 계산할 때 쓴 k */
  private kUsed = Number.NaN;

  /** 예약해 둔 소리. 다시 걸 때 어느 박부터인지 알아야 해서 박 번호를 함께 갖는다. */
  private scheduledNodes: { beat: number; osc: OscillatorNode }[] = [];
  private visualTimers: number[] = [];

  /** 박이 실제로 들리는 순간 호출된다 (논리 박 번호) */
  onBeat: ((logicalBeat: number) => void) | null = null;

  constructor(private clock: Clock) {}

  get unlocked() {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * iOS/모바일 사파리는 사용자 제스처 안에서만 오디오를 시작할 수 있다.
   * 반드시 버튼 클릭 핸들러에서 직접 호출할 것.
   */
  async unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.prefs.volume;
      this.master.connect(this.ctx.destination);
      this.audioMap.reset();
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();

    // 무음 버퍼를 한 번 흘려보내야 일부 기기에서 첫 소리가 잘리지 않는다
    const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.start(0);

    // 음성도 같은 제스처 안에서 한 번 깨워 둬야 iOS에서 나온다
    primeSpeech();

    // 시작 버튼을 누르기 전부터 오디오↔벽시계 매핑을 잡아 둔다.
    // 그래야 첫 카운트인부터 정확하다.
    if (this.mapTimer === null) {
      this.mapTimer = window.setInterval(() => {
        if (this.ctx && this.ctx.state === 'running') this.audioMap.update(this.ctx);
      }, 50);

      // 모바일은 화면이 꺼지면 오디오 컨텍스트를 멈춘다. 돌아오면 되살린다.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.ctx?.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
      });
    }
  }

  setPrefs(prefs: LocalPrefs) {
    this.prefs = prefs;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(prefs.volume, this.ctx.currentTime, 0.01);
    }
  }

  setState(state: RoomState, timeline: Timeline) {
    // 타임라인은 useRoom에서 메모이즈해 넘기므로 참조 비교로 충분하다
    const changed =
      state.anchor !== this.state?.anchor ||
      state.running !== this.state?.running ||
      timeline !== this.timeline;

    this.state = state;
    this.timeline = timeline;

    if (changed) {
      this.clearScheduled();
      this.nextBeat = state.running ? this.firstBeatFromNow() : 0;
    }

    if (state.running) this.startLoop();
    else this.stopLoop();
  }

  /** 지금 이후에 오는 첫 논리 박 */
  private firstBeatFromNow() {
    const state = this.state!;
    return beatAtOrAfter(this.timeline!, this.clock.serverNow() - state.anchor);
  }

  private startLoop() {
    if (this.timer !== null) return;
    this.timer = window.setInterval(this.tick, TICK_MS);
    this.tick();
  }

  private stopLoop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearScheduled();
    // 재예약 때는 끊지 않는다. 안내가 나오는 중에 잘리면 안 되기 때문이다.
    stopSpeaking();
  }

  /**
   * 이미 예약해 둔 소리와 화면 갱신을 취소한다.
   * @returns 취소한 것 중 가장 이른 박 번호. 없으면 null.
   */
  private clearScheduled(): number | null {
    let earliest: number | null = null;
    for (const { beat, osc } of this.scheduledNodes) {
      if (earliest === null || beat < earliest) earliest = beat;
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        /* 이미 끝난 노드 */
      }
    }
    this.scheduledNodes = [];
    for (const t of this.visualTimers) clearTimeout(t);
    this.visualTimers = [];
    return earliest;
  }

  private tick = () => {
    const state = this.state;
    const tl = this.timeline;
    if (!state || !tl || !state.running || !this.ctx) return;

    const jumped = this.audioMap.update(this.ctx);

    if (jumped) {
      // 오디오가 멈췄다 재개된 경우. 예약해 둔 것들은 통째로 의미가 없으니 버리고
      // 지금 이후의 박부터 다시 센다.
      this.clearScheduled();
      this.nextBeat = this.firstBeatFromNow();
      this.kUsed = this.audioMap.k;
    } else if (!(Math.abs(this.audioMap.k - this.kUsed) <= 2)) {
      // 매핑이 아직 수렴하는 중이라 예약해 둔 박들이 몇 ms 밀려 있다.
      // 취소한 박들을 그대로 다시 걸어야 한다. 여기서 "지금 이후"로 다시 세면
      // 경계에 걸린 박이 통째로 사라진다(실제로 한 박이 빠지는 걸 확인했다).
      const earliest = this.clearScheduled();
      if (earliest !== null) this.nextBeat = earliest;
      this.kUsed = this.audioMap.k;
    }

    const lookahead = document.hidden ? HIDDEN_LOOKAHEAD_MS : LOOKAHEAD_MS;
    const horizonElapsed = this.clock.serverNow() + lookahead - state.anchor;

    // 오프셋이 갱신되며 뒤처졌을 수 있으니 지난 박은 건너뛴다
    this.nextBeat = Math.max(this.nextBeat, this.firstBeatFromNow());

    let guard = 0;
    while (timeOfBeat(tl, this.nextBeat) < horizonElapsed && guard++ < 64) {
      this.schedule(tl, this.nextBeat, state.anchor + timeOfBeat(tl, this.nextBeat));
      this.nextBeat++;
    }
  };

  private schedule(tl: Timeline, logicalBeat: number, serverTime: number) {
    const ctx = this.ctx!;
    const localTime = this.clock.toLocal(serverTime);

    // 이 벽시계 시각에 소리가 "들리도록" 예약한다. 출력 지연은 매핑에 이미
    // 들어 있고, 브라우저가 알 수 없는 블루투스 지연만 사용자 값으로 뺀다.
    const at = this.audioMap.toCtxTime(localTime) - this.prefs.latencyMs / 1000;
    const info = beatInfo(tl, logicalBeat);

    if (this.prefs.soundOn && at > ctx.currentTime) {
      this.click(logicalBeat, at, this.prefs.accent && info.isAccent, info.isCountIn);
    }

    // 구간 이름 안내. 지금 구간의 마지막 마디 첫 박에 "다음 구간"을 말해 준다.
    // 구간이 바뀌는 순간에 말하면 이미 늦어서 준비할 수 없다.
    if (this.prefs.speak) {
      let announce: string | null = null;
      if (logicalBeat === tl.firstBeat) {
        // 카운트인 시작 — 첫 구간을 미리 알려준다
        announce = firstSectionName(tl);
      } else if (info.beatInBar === 0 && info.barsLeft === 1 && !info.ended) {
        // 마지막 구간이면 끝난다는 것도 알려준다. 구간 이름을 쓰는 언어에 맞춘다.
        announce = info.nextName ?? (langOf(info.name) === 'ko-KR' ? '끝' : 'End');
      }
      if (announce) this.speakAt(localTime, announce);
    }

    // 화면은 지연 보정 없이, 소리가 귀에 닿는 시각에 맞춘다
    const visualDelay = Math.max(0, localTime - now());
    const t = window.setTimeout(() => {
      const i = this.visualTimers.indexOf(t);
      if (i >= 0) this.visualTimers.splice(i, 1);
      this.onBeat?.(logicalBeat);
    }, visualDelay);
    this.visualTimers.push(t);
  }

  /** 안내 음성은 오디오 클럭에 예약할 수 없으므로 타이머로 맞춘다 */
  private speakAt(localTime: number, text: string) {
    const delay = Math.max(0, localTime - now());
    const t = window.setTimeout(() => {
      const i = this.visualTimers.indexOf(t);
      if (i >= 0) this.visualTimers.splice(i, 1);
      say(text, this.prefs.volume);
    }, delay);
    // 정지하거나 다시 예약할 때 같이 취소되도록 화면 타이머와 함께 관리한다
    this.visualTimers.push(t);
  }

  private click(beat: number, at: number, accent: boolean, countIn: boolean) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = countIn ? 'sine' : 'square';
    osc.frequency.value = accent ? 1800 : countIn ? 1000 : 1150;

    const peak = accent ? 0.5 : countIn ? 0.22 : 0.28;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);

    osc.connect(gain).connect(this.master!);
    osc.start(at);
    osc.stop(at + 0.06);

    osc.onended = () => {
      const i = this.scheduledNodes.findIndex((s) => s.osc === osc);
      if (i >= 0) this.scheduledNodes.splice(i, 1);
      gain.disconnect();
    };
    this.scheduledNodes.push({ beat, osc });
  }

  /** 지연 보정 슬라이더를 맞출 때 쓰는 즉석 클릭 */
  testClick() {
    if (!this.ctx) return;
    this.click(Number.NaN, this.ctx.currentTime + 0.05, true, false);
  }

  dispose() {
    this.stopLoop();
    if (this.mapTimer !== null) clearInterval(this.mapTimer);
    this.mapTimer = null;
    this.ctx?.close();
    this.ctx = null;
  }
}
