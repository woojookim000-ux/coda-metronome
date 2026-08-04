/**
 * 서버와의 시계 오프셋 추정. NTP와 같은 방식이다.
 *
 *   t0 = 보낸 시각(로컬)  ts = 서버가 답한 시각(서버)  t3 = 받은 시각(로컬)
 *   왕복이 대칭이라 가정하면 서버가 답한 순간의 로컬 시각은 (t0+t3)/2 이므로
 *   offset = ts - (t0+t3)/2   →   서버시각 ≈ 로컬시각 + offset
 *
 * 왕복이 대칭이 아닐수록 오차가 커지므로, 왕복시간이 짧았던 샘플만 골라
 * 중앙값을 쓴다. 느린 샘플일수록 비대칭일 가능성이 크기 때문이다.
 */

/** 벽시계 시각(ms). performance 기반이라 NTP 보정으로 갑자기 튀지 않는다. */
export const now = () => performance.timeOrigin + performance.now();

type Sample = { rtt: number; offset: number };

export class Clock {
  private samples: Sample[] = [];
  /** 서버시각 = 로컬시각 + offset */
  offset = 0;
  /** 추정 오차(ms). 채택한 샘플의 왕복시간 절반. */
  uncertainty = Infinity;
  ready = false;

  addSample(t0: number, ts: number, t3: number) {
    const rtt = t3 - t0;
    if (rtt < 0 || rtt > 2000) return; // 명백한 이상치
    this.samples.push({ rtt, offset: ts - (t0 + t3) / 2 });
    if (this.samples.length > 40) this.samples.shift();
    this.recompute();
  }

  private recompute() {
    const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const keep = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length * 0.3)));
    const offsets = keep.map((s) => s.offset).sort((a, b) => a - b);

    this.offset = offsets[Math.floor(offsets.length / 2)];
    this.uncertainty = keep[keep.length - 1].rtt / 2;
    this.ready = this.samples.length >= 5;
  }

  reset() {
    this.samples = [];
    this.offset = 0;
    this.uncertainty = Infinity;
    this.ready = false;
  }

  serverNow() {
    return now() + this.offset;
  }

  /** 서버시각 → 로컬시각 */
  toLocal(serverTime: number) {
    return serverTime - this.offset;
  }
}
