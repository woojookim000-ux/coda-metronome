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
  /**
   * 채택한 샘플들의 오프셋이 얼마나 흩어져 있는가(ms).
   *
   * 왕복시간의 절반을 오차로 쓰면 서버가 멀 때 수십 ms로 나오는데, 그건
   * 실제로 기기끼리 어긋나는 정도가 아니다. 같은 망에서 같은 서버를 보는
   * 기기들은 경로 비대칭이 서로 비슷해서 그 성분이 상쇄되기 때문이다.
   * 남는 것은 추정값의 흔들림이고, 그게 기기 간 차이를 더 잘 예측한다.
   */
  dispersion = Infinity;
  /** 왕복시간(ms). 참고용. */
  rtt = Infinity;
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
    this.dispersion = offsets.length > 1 ? offsets[offsets.length - 1] - offsets[0] : Infinity;
    this.rtt = keep[0].rtt;
    this.ready = this.samples.length >= 5;
  }

  reset() {
    this.samples = [];
    this.offset = 0;
    this.dispersion = Infinity;
    this.rtt = Infinity;
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
