/** 곡의 한 구간. "후렴 8마디"처럼 이름과 길이만 갖는다. */
export type Section = {
  id: string;
  name: string;
  bars: number;
};

export type Song = {
  id: string;
  title: string;
  bpm: number;
  beatsPerBar: number;
  sections: Section[];
};

/** 서버가 관리하는 방 상태. 모든 멤버가 동일한 값을 본다. */
export type RoomState = {
  bpm: number;
  beatsPerBar: number;
  running: boolean;
  /** 서버시각(ms). 이 순간에 anchorBeat번째 박이 울린다. */
  anchor: number;
  /** anchor에 대응하는 논리 박 번호. 음수면 카운트인 구간. */
  anchorBeat: number;
  countInEnabled: boolean;
  countInBars: number;
  setlist: Song[];
  currentSong: number;
};

export type Member = {
  id: string;
  name: string;
  soundOn: boolean;
  isHost: boolean;
};

/** 기기마다 다른 설정. 서버로 올라가지 않는다(soundOn 표시용 제외). */
export type LocalPrefs = {
  soundOn: boolean;
  volume: number;
  /** 오디오 출력 지연 보정(ms). 양수 = 내 소리가 늦게 들림 → 그만큼 일찍 예약. */
  latencyMs: number;
  accent: boolean;
  flash: boolean;
  name: string;
  /** 호스트일 때, 마지막 구간이 끝나면 자동으로 정지 */
  autoStop: boolean;
};

export const DEFAULT_PREFS: LocalPrefs = {
  soundOn: true,
  volume: 0.8,
  latencyMs: 0,
  accent: true,
  flash: true,
  name: '',
  autoStop: true,
};

export type SectionAt = {
  index: number;
  section: Section;
  /** 이 구간에서 몇 번째 마디인가 (0부터) */
  barInSection: number;
  /** 구간이 바뀌기까지 남은 마디 수. 마지막 마디에서 1. */
  barsLeft: number;
  next: Section | null;
};

export function totalBars(sections: Section[]) {
  return sections.reduce((sum, s) => sum + s.bars, 0);
}

/** 몇 번째 마디(0부터)가 어느 구간에 속하는지. 곡이 끝났으면 null. */
export function sectionAt(sections: Section[], barIndex: number): SectionAt | null {
  let start = 0;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (barIndex < start + section.bars) {
      return {
        index: i,
        section,
        barInSection: barIndex - start,
        barsLeft: start + section.bars - barIndex,
        next: sections[i + 1] ?? null,
      };
    }
    start += section.bars;
  }
  return null;
}

/** 논리 박 번호 → 마디/박 위치 */
export function beatPosition(logicalBeat: number, beatsPerBar: number) {
  const inBar = ((logicalBeat % beatsPerBar) + beatsPerBar) % beatsPerBar;
  return {
    isCountIn: logicalBeat < 0,
    bar: Math.floor(logicalBeat / beatsPerBar) + 1,
    beat: inBar + 1,
    isAccent: inBar === 0,
  };
}
