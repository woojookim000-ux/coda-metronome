import { useEffect, useRef, useState } from 'react';
import type { RoomApi } from '../App';
import { say, supportsSpeech } from '../lib/speech';
import { beatInfo } from '../lib/timeline';
import { totalBars } from '../lib/types';
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
    if (beatInfo(room.timeline, beat).ended) {
      endedRef.current = true;
      room.stop();
    }
  }, [beat, state, isHost, prefs.autoStop, room]);

  if (!state) {
    return <div className="screen center"><p className="hint">방 정보를 받는 중…</p></div>;
  }

  const info = beat === null ? null : beatInfo(room.timeline, beat);

  const song = state.currentSong >= 0 ? state.setlist[state.currentSong] ?? null : null;
  const sections = song?.sections ?? [];
  const songBars = totalBars(sections);
  // 지금 울리고 있는 구간. 카운트인 중이거나 곡이 끝났으면 없다.
  const here = info && !info.isCountIn && !info.ended && info.sectionIndex >= 0 ? info : null;
  const hereSection = here ? sections[here.sectionIndex] : null;

  // 실제로 울리고 있는 템포·박자표. 구간이 지정했으면 그 값이다.
  const liveBpm = info && state.running ? info.bpm : state.bpm;
  const liveMeter = info && state.running ? info.beatsPerBar : state.beatsPerBar;
  const bpmOverridden = liveBpm !== state.bpm;
  const meterOverridden = liveMeter !== state.beatsPerBar;
  const hasOverrides = sections.some((s) => s.bpm != null || s.beatsPerBar != null);

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
    : `동기화 ±${Math.max(1, Math.round(room.sync.dispersion))}ms`;
  const syncTitle = room.sync.ready
    ? `서버 응답 ${Math.round(room.sync.rtt)}ms · 기기 간 예상 오차 ±${Math.max(
        1,
        Math.round(room.sync.dispersion)
      )}ms`
    : '서버와 시계를 맞추는 중';

  return (
    <div className={`screen room${state.running ? ' running' : ''}`}>
      {prefs.flash && info && (
        <div key={beat} className={`flash${info.isAccent ? ' accent' : ''}`} />
      )}

      <header className="room-head">
        <button className="room-code" onClick={() => setShowQr(true)}>
          {room.code} <span className="qr-hint">QR</span>
        </button>
        <div className="head-meta">
          <span className={`dot ${room.connection}`} />
          <span>{room.members.length}명</span>
          <span className={room.sync.ready ? 'sync ok' : 'sync'} title={syncTitle}>
            {syncLabel}
          </span>
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

            {/* 점 개수는 지금 울리는 구간의 박자표를 따른다 */}
            <div className="beats">
              {Array.from({ length: liveMeter }, (_, i) => (
                <span
                  key={i}
                  className={
                    'beat' +
                    (info && info.beatInBar === i ? ' on' : '') +
                    (i === 0 ? ' accent' : '')
                  }
                />
              ))}
            </div>

            {/* 구간이 등록된 곡이면 "지금 어디인지"를 가장 크게 보여 준다.
                인이어 없이 합주할 때 정작 헤매는 건 박이 아니라 위치다.
                info가 아직 null인 시작 직후에 구간 화면을 띄우면 "곡 끝"이 스친다. */}
            {sections.length > 0 && state.running && info && !info.isCountIn ? (
              here && hereSection ? (
                <div className="section-view">
                  <div className="section-now">{hereSection.name}</div>
                  <div className="section-next">
                    <b className={here.barsLeft <= 2 ? 'soon' : ''}>{here.barsLeft}</b>
                    마디 뒤{' '}
                    {sections[here.sectionIndex + 1] ? (
                      <em>{sections[here.sectionIndex + 1].name}</em>
                    ) : (
                      <em className="end">곡 끝</em>
                    )}
                  </div>
                  <div className="section-sub">
                    {hereSection.name} {here.barInSection + 1}/{hereSection.bars}마디 · 전체{' '}
                    {Math.min(info.bar, songBars)}/{songBars}
                    {meterOverridden && <> · {liveMeter}/4</>}
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
                ) : info?.isCountIn ? (
                  <span className="countin">카운트인 {info.beatInBar + 1}</span>
                ) : (
                  <>
                    <span className="bar-no">{info ? info.bar : '–'}</span>
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
                      (here && here.sectionIndex === i ? ' on' : '') +
                      ((here && i < here.sectionIndex) || info?.ended ? ' done' : '')
                    }
                    style={{ flexGrow: s.bars }}
                    title={`${s.name} ${s.bars}마디${s.bpm ? ` · ${s.bpm}BPM` : ''}${
                      s.beatsPerBar ? ` · ${s.beatsPerBar}/4` : ''
                    }`}
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
                <span className={bpmOverridden ? 'bpm-value over' : 'bpm-value'}>{liveBpm}</span>
                <span className="bpm-label">{bpmOverridden ? '구간 지정' : 'BPM'}</span>
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
            {hasOverrides && (
              <p className="hint center">
                슬라이더는 <b>기본 템포</b>({state.bpm})입니다. 템포·박자를 직접 지정한 구간은
                셋리스트에서 바꾸세요.
              </p>
            )}
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
              checked={prefs.speak}
              disabled={!supportsSpeech()}
              onChange={(e) => room.setPrefs({ speak: e.target.checked })}
            />
            <span>구간 이름 음성 안내</span>
          </label>
          <p className="hint">
            {supportsSpeech() ? (
              <>
                구간이 바뀌기 <b>한 마디 전</b>에 다음 구간 이름을 말해 줍니다. 화면을 못 볼 때
                유용합니다.
              </>
            ) : (
              '이 브라우저는 음성 합성을 지원하지 않습니다.'
            )}
          </p>
          <div className="preset-row">
            <button
              className="chip"
              disabled={!audioReady || !supportsSpeech()}
              onClick={() => say('Bridge', prefs.volume)}
            >
              음성 미리 듣기
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
