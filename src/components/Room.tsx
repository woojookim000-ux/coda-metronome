import { useEffect, useRef, useState } from 'react';
import type { RoomApi } from '../App';
import { beatPosition, sectionAt, totalBars } from '../lib/types';
import QrModal from './QrModal';
import Setlist from './Setlist';

const METERS = [2, 3, 4, 5, 6, 7];

export default function Room({ room }: { room: RoomApi }) {
  const { state, prefs, isHost, engine } = room;
  const [audioReady, setAudioReady] = useState(engine.unlocked);
  const [beat, setBeat] = useState<number | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [tab, setTab] = useState<'play' | 'setlist' | 'device'>('play');
  const tapsRef = useRef<number[]>([]);

  useEffect(() => {
    engine.onBeat = setBeat;
    return () => {
      engine.onBeat = null;
    };
  }, [engine]);

  useEffect(() => {
    if (!state?.running) setBeat(null);
  }, [state?.running]);

  // 마지막 구간이 끝나면 호스트가 대신 정지시킨다. 합주 중에는 아무도
  // 폰에 손을 댈 수 없으므로 이게 없으면 곡이 끝나도 클릭이 계속 돈다.
  const endedRef = useRef(false);
  useEffect(() => {
    endedRef.current = false;
  }, [state?.running, state?.currentSong]);

  useEffect(() => {
    if (!isHost || !prefs.autoStop || !state?.running || beat === null || endedRef.current) return;
    const s = state.currentSong >= 0 ? state.setlist[state.currentSong] : null;
    if (!s || s.sections.length === 0) return;
    const p = beatPosition(beat, state.beatsPerBar);
    if (p.isCountIn) return;
    if (p.bar - 1 >= totalBars(s.sections)) {
      endedRef.current = true;
      room.stop();
    }
  }, [beat, state, isHost, prefs.autoStop, room]);

  if (!state) {
    return <div className="screen center"><p className="hint">방 정보를 받는 중…</p></div>;
  }

  const pos = beat === null ? null : beatPosition(beat, state.beatsPerBar);

  const song = state.currentSong >= 0 ? state.setlist[state.currentSong] ?? null : null;
  const sections = song?.sections ?? [];
  const songBars = totalBars(sections);
  // 카운트인 동안에는 아직 1마디가 시작되지 않았다
  const barIndex = pos && !pos.isCountIn ? pos.bar - 1 : -1;
  const here = sections.length && barIndex >= 0 ? sectionAt(sections, barIndex) : null;
  const songEnded = sections.length > 0 && barIndex >= songBars;

  const enableAudio = async () => {
    await engine.unlock();
    setAudioReady(engine.unlocked);
  };

  const tapTempo = () => {
    const t = performance.now();
    const taps = tapsRef.current.filter((x) => t - x < 2500);
    taps.push(t);
    tapsRef.current = taps.slice(-5);
    if (tapsRef.current.length >= 2) {
      const gaps = tapsRef.current.slice(1).map((x, i) => x - tapsRef.current[i]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      room.setBpm(Math.round(60000 / avg));
    }
  };

  const syncLabel = !room.sync.ready
    ? '동기화 중…'
    : `동기화 ±${Math.max(1, Math.round(room.sync.uncertainty))}ms`;

  return (
    <div className={`screen room${state.running ? ' running' : ''}`}>
      {prefs.flash && pos && (
        <div key={beat} className={`flash${pos.isAccent ? ' accent' : ''}`} />
      )}

      <header className="room-head">
        <button className="room-code" onClick={() => setShowQr(true)}>
          {room.code} <span className="qr-hint">QR</span>
        </button>
        <div className="head-meta">
          <span className={`dot ${room.connection}`} />
          <span>{room.members.length}명</span>
          <span className={room.sync.ready ? 'sync ok' : 'sync'}>{syncLabel}</span>
        </div>
      </header>

      {!audioReady && (
        <button className="audio-unlock" onClick={enableAudio}>
          탭해서 소리 켜기
          <small>브라우저 정책상 한 번은 직접 눌러야 소리가 납니다</small>
        </button>
      )}

      <nav className="tabs">
        {(['play', 'setlist', 'device'] as const).map((t) => (
          <button key={t} className={tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
            {t === 'play' ? '연주' : t === 'setlist' ? '셋리스트' : '내 기기'}
          </button>
        ))}
      </nav>

      {tab === 'play' && (
        <>
          <div className="stage">
            {song && <div className="song-now">♪ {song.title}</div>}

            <div className="beats">
              {Array.from({ length: state.beatsPerBar }, (_, i) => (
                <span
                  key={i}
                  className={
                    'beat' +
                    (pos && pos.beat === i + 1 ? ' on' : '') +
                    (i === 0 ? ' accent' : '')
                  }
                />
              ))}
            </div>

            {/* 구간이 등록된 곡이면 "지금 어디인지"를 가장 크게 보여 준다.
                인이어 없이 합주할 때 정작 헤매는 건 박이 아니라 위치다. */}
            {/* pos가 아직 null인 시작 직후에는 구간을 계산할 수 없다.
                이때 구간 화면을 띄우면 "곡 끝"이 잠깐 스친다. */}
            {sections.length > 0 && state.running && pos && !pos.isCountIn ? (
              here ? (
                <div className="section-view">
                  <div className="section-now">{here.section.name}</div>
                  <div className="section-next">
                    <b className={here.barsLeft <= 2 ? 'soon' : ''}>{here.barsLeft}</b>
                    마디 뒤 {here.next ? <em>{here.next.name}</em> : <em className="end">곡 끝</em>}
                  </div>
                  <div className="section-sub">
                    {here.section.name} {here.barInSection + 1}/{here.section.bars}마디 · 전체{' '}
                    {Math.min(barIndex + 1, songBars)}/{songBars}
                  </div>
                </div>
              ) : (
                <div className="section-view">
                  <div className="section-now end">곡 끝</div>
                </div>
              )
            ) : (
              <div className="counter">
                {!state.running ? (
                  <span className="idle">정지</span>
                ) : pos?.isCountIn ? (
                  <span className="countin">카운트인 {pos.beat}</span>
                ) : (
                  <>
                    <span className="bar-no">{pos ? pos.bar : '–'}</span>
                    <span className="bar-label">마디</span>
                  </>
                )}
              </div>
            )}

            {sections.length > 0 && (
              <div className="strip">
                {sections.map((s, i) => (
                  <div
                    key={s.id}
                    className={
                      'strip-seg' +
                      (here && here.index === i ? ' on' : '') +
                      ((here && i < here.index) || songEnded ? ' done' : '')
                    }
                    style={{ flexGrow: s.bars }}
                    title={`${s.name} ${s.bars}마디`}
                  >
                    <span>{s.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bpm-block">
            <div className="bpm-row">
              <button className="icon big" onClick={() => room.setBpm(state.bpm - 1)} disabled={!isHost}>−</button>
              <div className="bpm">
                <span className="bpm-value">{state.bpm}</span>
                <span className="bpm-label">BPM</span>
              </div>
              <button className="icon big" onClick={() => room.setBpm(state.bpm + 1)} disabled={!isHost}>＋</button>
            </div>
            <input
              className="slider"
              type="range"
              min={30}
              max={260}
              value={state.bpm}
              disabled={!isHost}
              onChange={(e) => room.setBpm(Number(e.target.value))}
            />
            <button className="btn ghost small" onClick={tapTempo} disabled={!isHost}>
              탭 템포
            </button>
          </div>

          <div className="meters">
            {METERS.map((m) => (
              <button
                key={m}
                className={state.beatsPerBar === m ? 'chip on' : 'chip'}
                disabled={!isHost}
                onClick={() => room.setMeter(m)}
              >
                {m}/4
              </button>
            ))}
          </div>

          <div className="transport">
            <label className={`toggle${isHost ? '' : ' disabled'}`}>
              <input
                type="checkbox"
                checked={state.countInEnabled}
                disabled={!isHost}
                onChange={(e) => room.setCountIn(e.target.checked)}
              />
              <span>카운트인</span>
            </label>
            {state.countInEnabled && (
              <div className="countin-bars">
                {[1, 2, 4].map((n) => (
                  <button
                    key={n}
                    className={state.countInBars === n ? 'chip on' : 'chip'}
                    disabled={!isHost}
                    onClick={() => room.setCountIn(true, n)}
                  >
                    {n}마디
                  </button>
                ))}
              </div>
            )}

            {isHost && sections.length > 0 && (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={prefs.autoStop}
                  onChange={(e) => room.setPrefs({ autoStop: e.target.checked })}
                />
                <span>곡 끝나면 자동 정지</span>
              </label>
            )}

            {state.running ? (
              <button className="btn stop big" onClick={room.stop} disabled={!isHost}>
                정지
              </button>
            ) : (
              <button className="btn primary big" onClick={room.start} disabled={!isHost}>
                시작
              </button>
            )}
          </div>

          {!isHost && <p className="hint center">호스트만 템포와 시작을 조절할 수 있습니다.</p>}

          <div className="panel">
            <div className="panel-title">참여 중 ({room.members.length})</div>
            <ul className="members">
              {room.members.map((m) => (
                <li key={m.id}>
                  <span className={m.soundOn ? 'spk on' : 'spk'}>{m.soundOn ? '🔊' : '🔇'}</span>
                  <span className="mname">{m.name}{m.id === room.myId ? ' (나)' : ''}</span>
                  {m.isHost && <span className="badge">호스트</span>}
                  {isHost && !m.isHost && (
                    <button className="chip tiny" onClick={() => room.handOffHost(m.id)}>
                      호스트 넘기기
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {tab === 'setlist' && <Setlist room={room} />}

      {tab === 'device' && (
        <div className="panel device">
          <div className="panel-title">내 기기 설정</div>
          <p className="hint">여기 설정은 나에게만 적용됩니다.</p>

          <label className="toggle row">
            <input
              type="checkbox"
              checked={prefs.soundOn}
              onChange={(e) => room.setPrefs({ soundOn: e.target.checked })}
            />
            <span>이 기기에서 소리 내기</span>
          </label>

          <label className="field">
            <span>볼륨</span>
            <input
              className="slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={prefs.volume}
              onChange={(e) => room.setPrefs({ volume: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span>
              오디오 지연 보정 <b>{prefs.latencyMs}ms</b>
            </span>
            <input
              className="slider"
              type="range"
              min={-100}
              max={400}
              step={5}
              value={prefs.latencyMs}
              onChange={(e) => room.setPrefs({ latencyMs: Number(e.target.value) })}
            />
          </label>
          <p className="hint">
            내 클릭이 남들보다 <b>늦게</b> 들리면 값을 <b>올리세요</b>. 유선 이어폰·스피커는 0,
            블루투스는 보통 150~200입니다.
          </p>
          <div className="preset-row">
            {[
              { label: '유선 / 스피커', v: 0 },
              { label: '블루투스', v: 170 },
              { label: '무선 (저지연)', v: 60 },
            ].map((p) => (
              <button
                key={p.v}
                className={prefs.latencyMs === p.v ? 'chip on' : 'chip'}
                onClick={() => room.setPrefs({ latencyMs: p.v })}
              >
                {p.label}
              </button>
            ))}
            <button className="chip" onClick={() => engine.testClick()} disabled={!audioReady}>
              테스트 클릭
            </button>
          </div>

          <label className="toggle row">
            <input
              type="checkbox"
              checked={prefs.accent}
              onChange={(e) => room.setPrefs({ accent: e.target.checked })}
            />
            <span>첫 박 강세음</span>
          </label>

          <label className="toggle row">
            <input
              type="checkbox"
              checked={prefs.flash}
              onChange={(e) => room.setPrefs({ flash: e.target.checked })}
            />
            <span>화면 깜빡임</span>
          </label>

          <label className="field">
            <span>내 이름</span>
            <input
              value={prefs.name}
              maxLength={20}
              onChange={(e) => room.setPrefs({ name: e.target.value })}
            />
          </label>
        </div>
      )}

      {showQr && room.code && <QrModal code={room.code} onClose={() => setShowQr(false)} />}
    </div>
  );
}
