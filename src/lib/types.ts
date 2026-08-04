/**
 * 곡의 한 구간. "후렴 8마디"처럼 이름과 길이를 갖는다.
 * bpm과 beatsPerBar는 지정하지 않으면 곡의 기본값을 따른다.
 * 곡 중간에 박자가 바뀌는 곡은 해당 구간에만 값을 넣으면 된다.
 */
export type Section = {
  id: string;
  name: string;
  bars: number;
  bpm?: number;
  beatsPerBar?: number;
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
  /**
   * 서버시각(ms). 타임라인의 첫 박이 울리는 순간.
   * 카운트인이 켜져 있으면 카운트인의 첫 박, 아니면 곡의 첫 박이다.
   */
  anchor: number;
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

export function totalBars(sections: Section[]) {
  return sections.reduce((sum, s) => sum + s.bars, 0);
}

/** 구간 목록의 총 길이(초). 구간마다 템포가 다를 수 있으므로 각각 계산한다. */
export function totalSeconds(song: Song) {
  return song.sections.reduce((sum, s) => {
    const bpm = s.bpm ?? song.bpm;
    const beatsPerBar = s.beatsPerBar ?? song.beatsPerBar;
    return sum + (s.bars * beatsPerBar * 60) / bpm;
  }, 0);
}
