import type { Section } from './types';

/**
 * 곡 타임라인.
 *
 * 구간마다 템포와 박자표가 다를 수 있으므로 "anchor + n × 간격"으로는 박 시각을
 * 구할 수 없다. 대신 구간을 이어붙인 구간 목록(segment)을 만들고, 박 번호와
 * 경과 시간을 이 목록을 훑어서 변환한다.
 *
 * 박 번호(논리 박)는 곡의 첫 박이 0이고, 카운트인은 음수다.
 * 시간은 전부 타임라인 시작(= anchor)으로부터의 경과 ms다.
 */

export type Segment = {
  /** 섹션 번호. -1이면 카운트인, -2면 셋리스트 없이 도는 무한 구간 */
  sectionIndex: number;
  /** 구간 이름. 음성 안내에 쓴다. 카운트인·무한 구간은 빈 문자열. */
  name: string;
  startBeat: number;
  /** 무한 구간이면 Infinity */
  beats: number;
  /** 한 박의 길이(ms) */
  interval: number;
  beatsPerBar: number;
  bpm: number;
  startTimeMs: number;
  /** 곡 기준 0-based 마디 번호 */
  startBar: number;
};

export type Timeline = {
  segments: Segment[];
  countInBeats: number;
  /** 타임라인의 첫 박 번호 (카운트인이 있으면 음수) */
  firstBeat: number;
  /** 곡 전체 박 수. 섹션이 없으면 null(무한) */
  totalBeats: number | null;
  totalBars: number;
  /** 곡 전체 길이(ms). 섹션이 없으면 null */
  durationMs: number | null;
};

export type BeatInfo = {
  isCountIn: boolean;
  /** 마지막 구간까지 다 지났는가 */
  ended: boolean;
  bpm: number;
  beatsPerBar: number;
  /** 마디 안에서 0-based */
  beatInBar: number;
  isAccent: boolean;
  /** 곡 기준 1-based 마디. 카운트인이면 카운트인 안에서의 마디 */
  bar: number;
  sectionIndex: number;
  /** 구간 안에서 0-based 마디 */
  barInSection: number;
  /** 구간이 바뀌기까지 남은 마디 수 (마지막 마디에서 1) */
  barsLeft: number;
  /** 지금 구간 이름 */
  name: string;
  /** 다음 구간 이름. 이번이 마지막 구간이면 null. */
  nextName: string | null;
};

export function buildTimeline(opts: {
  sections: Section[];
  baseBpm: number;
  baseBeatsPerBar: number;
  /** 0이면 카운트인 없음 */
  countInBars: number;
}): Timeline {
  const { sections, baseBpm, baseBeatsPerBar, countInBars } = opts;
  const segments: Segment[] = [];

  // 카운트인은 첫 구간의 템포·박자로 센다. 들어갈 곡의 속도로 세는 게 맞다.
  const first = sections[0];
  const firstBpm = first?.bpm ?? baseBpm;
  const firstMeter = first?.beatsPerBar ?? baseBeatsPerBar;

  const countInBeats = countInBars > 0 ? countInBars * firstMeter : 0;
  let time = 0;

  if (countInBeats > 0) {
    segments.push({
      sectionIndex: -1,
      name: '',
      startBeat: -countInBeats,
      beats: countInBeats,
      interval: 60000 / firstBpm,
      beatsPerBar: firstMeter,
      bpm: firstBpm,
      startTimeMs: 0,
      startBar: 0,
    });
    time += countInBeats * (60000 / firstBpm);
  }

  let beat = 0;
  let bar = 0;

  if (sections.length === 0) {
    segments.push({
      sectionIndex: -2,
      name: '',
      startBeat: 0,
      beats: Infinity,
      interval: 60000 / baseBpm,
      beatsPerBar: baseBeatsPerBar,
      bpm: baseBpm,
      startTimeMs: time,
      startBar: 0,
    });
    return {
      segments,
      countInBeats,
      firstBeat: -countInBeats,
      totalBeats: null,
      totalBars: 0,
      durationMs: null,
    };
  }

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const bpm = s.bpm ?? baseBpm;
    const beatsPerBar = s.beatsPerBar ?? baseBeatsPerBar;
    const beats = s.bars * beatsPerBar;
    const interval = 60000 / bpm;

    segments.push({
      sectionIndex: i,
      name: s.name,
      startBeat: beat,
      beats,
      interval,
      beatsPerBar,
      bpm,
      startTimeMs: time,
      startBar: bar,
    });

    beat += beats;
    time += beats * interval;
    bar += s.bars;
  }

  return {
    segments,
    countInBeats,
    firstBeat: -countInBeats,
    totalBeats: beat,
    totalBars: bar,
    durationMs: time - (countInBeats > 0 ? countInBeats * (60000 / firstBpm) : 0),
  };
}

/** 이 박을 담고 있는 구간의 인덱스. 끝을 넘어가면 마지막 구간으로 연장한다. */
function segmentIndexForBeat(tl: Timeline, beat: number): number {
  let idx = 0;
  for (let i = 0; i < tl.segments.length; i++) {
    if (beat >= tl.segments[i].startBeat) idx = i;
    else break;
  }
  return idx;
}

function segmentForBeat(tl: Timeline, beat: number): Segment {
  return tl.segments[segmentIndexForBeat(tl, beat)];
}

/** 곡의 첫 구간 이름. 카운트인 중에 미리 알려줄 때 쓴다. */
export function firstSectionName(tl: Timeline): string | null {
  const seg = tl.segments.find((s) => s.sectionIndex >= 0);
  return seg && seg.name ? seg.name : null;
}

/** 논리 박 → 타임라인 시작으로부터의 경과 ms */
export function timeOfBeat(tl: Timeline, beat: number): number {
  const seg = segmentForBeat(tl, beat);
  return seg.startTimeMs + (beat - seg.startBeat) * seg.interval;
}

/** 경과 ms 시점 이후에 오는 첫 논리 박 */
export function beatAtOrAfter(tl: Timeline, ms: number): number {
  let seg = tl.segments[0];
  for (const s of tl.segments) {
    if (ms >= s.startTimeMs) seg = s;
    else break;
  }
  // 부동소수점 때문에 정확히 박 위에 있을 때 다음 박으로 튀어 한 박을 건너뛸 수 있다
  const k = Math.ceil((ms - seg.startTimeMs) / seg.interval - 1e-9);
  return Math.max(tl.firstBeat, seg.startBeat + k);
}

export function beatInfo(tl: Timeline, beat: number): BeatInfo {
  const segIdx = segmentIndexForBeat(tl, beat);
  const seg = tl.segments[segIdx];
  const next = tl.segments[segIdx + 1];
  const inSeg = beat - seg.startBeat;
  const beatInBar = ((inSeg % seg.beatsPerBar) + seg.beatsPerBar) % seg.beatsPerBar;
  const barInSection = Math.floor(inSeg / seg.beatsPerBar);
  const isCountIn = beat < 0;
  const ended = tl.totalBeats != null && beat >= tl.totalBeats;

  return {
    isCountIn,
    ended,
    bpm: seg.bpm,
    beatsPerBar: seg.beatsPerBar,
    beatInBar,
    isAccent: beatInBar === 0,
    bar: isCountIn ? barInSection + 1 : seg.startBar + barInSection + 1,
    sectionIndex: seg.sectionIndex,
    barInSection,
    barsLeft: Number.isFinite(seg.beats)
      ? Math.floor(seg.beats / seg.beatsPerBar) - barInSection
      : Infinity,
    name: seg.name,
    nextName: next && next.name ? next.name : null,
  };
}

/**
 * 재생 중에 템포·박자표·곡을 바꿀 때 쓸 새 anchor.
 *
 * 바뀌기 직전 타임라인에서 "다음에 올 박"을 찾고, 새 타임라인에서도 그 박이
 * 같은 시각에 오도록 anchor를 옮긴다. 이렇게 해야 박이 겹치거나 빠지지 않는다.
 */
export function reanchor(
  oldTl: Timeline,
  newTl: Timeline,
  anchor: number,
  serverNow: number
): number {
  const nextBeat = beatAtOrAfter(oldTl, serverNow - anchor);
  const nextTime = anchor + timeOfBeat(oldTl, nextBeat);
  return nextTime - timeOfBeat(newTl, nextBeat);
}
