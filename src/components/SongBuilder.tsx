import { useEffect, useRef, useState } from 'react';
import { analyzeAudio, boundariesToBars, type Analysis } from '../lib/analyze';
import type { Section, Song } from '../lib/types';

/**
 * 곡 하나를 만드는 화면.
 *
 * 두 가지 방법을 같이 쓴다.
 *  1) 음원을 올리면 BPM과 구간 경계를 추정한다. BPM은 믿을 만하고 구간은 초안이다.
 *  2) 음원을 들으면서 파트가 바뀔 때마다 탭한다. 이쪽이 확실하다.
 *
 * 파일은 브라우저 안에서만 읽는다. 서버로 올라가지 않는다.
 */

const newId = () => Math.random().toString(36).slice(2);
const PRESETS = ['Intro', 'Verse', 'Pre', 'Chorus', 'Bridge', 'Solo', 'Outro'];

type Row = { id: string; name: string; bars: number };

export default function SongBuilder({
  onSave,
  onClose,
}: {
  onSave: (song: Song) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [fileName, setFileName] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [bpm, setBpm] = useState(120);
  const [meter, setMeter] = useState(4);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  // --- 재생 + 탭 -----------------------------------------------------------
  const bufferRef = useRef<AudioBuffer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const originRef = useRef(0); // 재생을 시작한 기준 시각
  const [playing, setPlaying] = useState(false);
  const [posBar, setPosBar] = useState(0);
  const [taps, setTaps] = useState<number[]>([]);

  const barSec = (60 / bpm) * meter;
  const beatOffset = analysis?.beatOffsetSec ?? 0;

  const positionSec = () => {
    if (!playing) return 0;
    if (bufferRef.current && ctxRef.current) return ctxRef.current.currentTime - originRef.current;
    return (performance.now() - originRef.current) / 1000;
  };

  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => {
      setPosBar(Math.max(0, Math.floor((positionSec() - beatOffset) / barSec) + 1));
    }, 60);
    return () => clearInterval(t);
  });

  const stop = () => {
    try {
      srcRef.current?.stop();
    } catch {
      /* 이미 끝남 */
    }
    srcRef.current = null;
    setPlaying(false);
  };

  useEffect(() => () => stop(), []);

  const play = async () => {
    setTaps([]);
    const buf = bufferRef.current;
    if (buf) {
      if (!ctxRef.current) ctxRef.current = new AudioContext();
      const ctx = ctxRef.current;
      if (ctx.state !== 'running') await ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => setPlaying(false);
      originRef.current = ctx.currentTime;
      src.start();
      srcRef.current = src;
    } else {
      // 음원이 없으면 스피커로 직접 틀어 놓고 타이머에 맞춰 탭한다
      originRef.current = performance.now();
    }
    setPlaying(true);
  };

  /** 지금 위치를 구간 경계로 찍는다. 가장 가까운 마디에 붙인다. */
  const tap = () => {
    const bar = Math.max(1, Math.round((positionSec() - beatOffset) / barSec));
    setTaps((prev) => (prev.includes(bar) ? prev : [...prev, bar].sort((a, b) => a - b)));
  };

  /** 찍어 둔 경계를 구간 목록으로 바꾼다 */
  const applyTaps = () => {
    if (taps.length === 0) return;
    const endBar = bufferRef.current
      ? Math.max(...taps, Math.round((bufferRef.current.duration - beatOffset) / barSec))
      : Math.max(...taps, Math.floor((positionSec() - beatOffset) / barSec));
    const marks = [0, ...taps, endBar].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
    const next: Row[] = [];
    for (let i = 1; i < marks.length; i++) {
      const bars = marks[i] - marks[i - 1];
      if (bars > 0) next.push({ id: newId(), name: PRESETS[Math.min(i - 1, PRESETS.length - 1)], bars });
    }
    setRows(next);
    setTaps([]);
  };

  // --- 파일 분석 -----------------------------------------------------------

  const pickFile = async (file: File) => {
    setError(null);
    setFileName(file.name);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
    setProgress(0);
    try {
      const bytes = await file.arrayBuffer();
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(bytes);
      ctx.close();
      bufferRef.current = buf;

      const result = await analyzeAudio(buf, setProgress);
      setAnalysis(result);
      setBpm(Math.round(result.bpm));
      rebuildRows(result, Math.round(result.bpm), meter);
    } catch (e) {
      setError('이 파일은 읽지 못했습니다. mp3, m4a, wav 같은 오디오 파일로 시도해 보세요.');
      bufferRef.current = null;
    } finally {
      setProgress(null);
    }
  };

  const rebuildRows = (a: Analysis, useBpm: number, useMeter: number) => {
    const bars = boundariesToBars(a.boundariesSec, a.durationSec, useBpm, useMeter, a.beatOffsetSec);
    setRows(
      bars.map((n, i) => ({
        id: newId(),
        name: PRESETS[Math.min(i, PRESETS.length - 1)],
        bars: n,
      }))
    );
  };

  const changeBpm = (next: number) => {
    const v = Math.min(300, Math.max(20, Math.round(next)));
    setBpm(v);
    if (analysis) rebuildRows(analysis, v, meter);
  };

  const changeMeter = (next: number) => {
    setMeter(next);
    if (analysis) rebuildRows(analysis, bpm, next);
  };

  // --- 구간 편집 -----------------------------------------------------------

  const patch = (id: string, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const totalBars = rows.reduce((a, r) => a + r.bars, 0);

  const save = () => {
    const t = title.trim() || fileName.replace(/\.[^.]+$/, '') || '새 곡';
    const sections: Section[] = rows
      .filter((r) => r.bars > 0)
      .map((r) => ({ id: r.id, name: r.name.trim() || '?', bars: r.bars }));
    onSave({ id: newId(), title: t, bpm, beatsPerBar: meter, sections });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal builder" onClick={(e) => e.stopPropagation()}>
        <h2>곡 만들기</h2>

        <label className="field">
          <span>곡 제목</span>
          {/* 브라우저가 예전에 입력한 값으로 멋대로 채우는 걸 막는다 */}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={40}
            autoComplete="off"
            placeholder="음원을 올리면 파일 이름이 들어갑니다"
          />
        </label>

        {/* 1단계 — 음원 분석 */}
        <div className="builder-step">
          <div className="step-title">① 음원으로 자동 분석 <small>(선택)</small></div>
          <input
            type="file"
            accept="audio/*,video/*"
            className="file-input"
            onChange={(e) => e.target.files?.[0] && pickFile(e.target.files[0])}
          />
          {progress !== null && (
            <div className="progress">
              <div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
              <span>분석 중… {Math.round(progress * 100)}%</span>
            </div>
          )}
          {error && <p className="error">{error}</p>}
          {analysis && (
            <p className="hint">
              {fileName} · 길이 {Math.round(analysis.durationSec)}초
              {analysis.confidence < 0.3 && (
                <>
                  <br />
                  <b className="warn-text">템포가 확실하지 않습니다.</b> 아래에서 ×2 / ÷2로 맞춰
                  보세요.
                </>
              )}
            </p>
          )}
          <p className="hint">
            유튜브 링크는 소리를 가져올 수 없어 안 됩니다. 파일은 이 브라우저 안에서만 읽고 서버로
            보내지 않습니다.
          </p>
        </div>

        {/* 2단계 — 템포와 박자표 */}
        <div className="builder-step">
          <div className="step-title">② 템포와 박자표</div>
          <div className="bpm-row small">
            <button className="icon" onClick={() => changeBpm(bpm - 1)}>−</button>
            <div className="bpm">
              <span className="bpm-value">{bpm}</span>
              <span className="bpm-label">BPM</span>
            </div>
            <button className="icon" onClick={() => changeBpm(bpm + 1)}>＋</button>
            <button className="chip" onClick={() => changeBpm(bpm / 2)}>÷2</button>
            <button className="chip" onClick={() => changeBpm(bpm * 2)}>×2</button>
          </div>
          <div className="meters">
            {[2, 3, 4, 5, 6, 7].map((m) => (
              <button
                key={m}
                className={meter === m ? 'chip on' : 'chip'}
                onClick={() => changeMeter(m)}
              >
                {m}/4
              </button>
            ))}
          </div>
        </div>

        {/* 3단계 — 탭으로 구간 찍기 */}
        <div className="builder-step">
          <div className="step-title">③ 들으면서 구간 찍기 <small>(가장 정확함)</small></div>
          {!playing ? (
            <button className="btn" onClick={play}>
              {bufferRef.current ? '재생하며 찍기' : '음원 없이 찍기 (스피커로 틀어놓고)'}
            </button>
          ) : (
            <>
              <button className="btn primary big tap-now" onClick={tap}>
                여기서 바뀜
                <small>{posBar}마디 지남</small>
              </button>
              <div className="tap-row">
                <button className="chip" onClick={() => setTaps((t) => t.slice(0, -1))} disabled={!taps.length}>
                  마지막 취소
                </button>
                <button className="chip" onClick={() => { stop(); applyTaps(); }}>
                  멈추고 반영
                </button>
              </div>
              {taps.length > 0 && <p className="hint">찍은 마디: {taps.join(', ')}</p>}
            </>
          )}
        </div>

        {/* 4단계 — 구간 다듬기 */}
        <div className="builder-step">
          <div className="step-title">④ 구간 다듬기</div>
          {rows.length === 0 && <p className="hint">아직 구간이 없습니다. 위에서 분석하거나 찍어 보세요.</p>}
          <ul className="sec-list">
            {rows.map((r) => (
              <li key={r.id}>
                <div className="sec-row">
                  <select
                    className="sec-name"
                    value={PRESETS.includes(r.name) ? r.name : '__custom'}
                    onChange={(e) =>
                      // 직접 입력을 고르면 프리셋에 없는 값으로 비워 둬야
                      // 아래 입력 칸이 나타난다. 그냥 무시하면 선택이 되돌아간다.
                      patch(r.id, { name: e.target.value === '__custom' ? '' : e.target.value })
                    }
                  >
                    {PRESETS.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                    <option value="__custom">직접 입력…</option>
                  </select>
                  <input
                    className="sec-bars"
                    type="number"
                    min={1}
                    value={r.bars}
                    onChange={(e) => patch(r.id, { bars: Math.max(1, Number(e.target.value) || 1) })}
                  />
                  <span className="sec-unit">마디</span>
                  <button
                    className="icon danger"
                    onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
                  >
                    ×
                  </button>
                </div>
                {!PRESETS.includes(r.name) && (
                  <input
                    className="sec-name custom"
                    value={r.name}
                    maxLength={12}
                    placeholder="구간 이름 (예: Verse 2)"
                    autoComplete="off"
                    autoFocus
                    onChange={(e) => patch(r.id, { name: e.target.value })}
                  />
                )}
              </li>
            ))}
          </ul>
          <button
            className="chip"
            onClick={() => setRows((rs) => [...rs, { id: newId(), name: 'Chorus', bars: 8 }])}
          >
            + 구간 추가
          </button>
          {rows.length > 0 && (
            <p className="hint">
              전체 <b>{totalBars}마디</b> · 약 {Math.round((totalBars * meter * 60) / bpm)}초
            </p>
          )}
        </div>

        <button className="btn primary big" onClick={save} disabled={rows.length === 0}>
          셋리스트에 추가
        </button>
        <button className="btn ghost" onClick={onClose}>닫기</button>
      </div>
    </div>
  );
}
