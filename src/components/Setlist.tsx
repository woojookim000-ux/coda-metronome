import { useState } from 'react';
import type { RoomApi } from '../App';
import type { Section, Song } from '../lib/types';
import { totalBars, totalSeconds } from '../lib/types';
import { loadSavedSetlist, saveSetlist } from '../lib/useRoom';

const newId = () => Math.random().toString(36).slice(2);

/** 밴드 합주에서 자주 쓰는 구간 이름. 직접 입력해도 되고 한글도 읽어 준다. */
const PRESETS = ['Intro', 'Verse', 'Pre', 'Chorus', 'Bridge', 'Solo', 'Outro'];

function SectionEditor({
  song,
  onChange,
}: {
  song: Song;
  onChange: (sections: Section[]) => void;
}) {
  const [name, setName] = useState('');
  const [bars, setBars] = useState(8);
  const sections = song.sections;

  const add = (label?: string) => {
    const n = (label ?? name).trim();
    if (!n) return;
    onChange([...sections, { id: newId(), name: n, bars }]);
    if (!label) setName('');
  };

  const patch = (id: string, p: Partial<Section>) =>
    onChange(sections.map((s) => (s.id === id ? { ...s, ...p } : s)));

  const move = (i: number, delta: number) => {
    const target = i + delta;
    if (target < 0 || target >= sections.length) return;
    const next = [...sections];
    [next[i], next[target]] = [next[target], next[i]];
    onChange(next);
  };

  return (
    <div className="sec-editor">
      {sections.length === 0 && (
        <p className="hint">
          구간을 넣으면 합주 중에 "지금 Chorus, 3마디 뒤 Bridge"처럼 화면에 크게 뜨고,
          바뀌기 한 마디 전에 음성으로도 알려줍니다.
        </p>
      )}

      <ul className="sec-list">
        {sections.map((s, i) => (
          <li key={s.id}>
            <div className="sec-row">
              <input
                className="sec-name"
                value={s.name}
                maxLength={12}
                onChange={(e) => patch(s.id, { name: e.target.value })}
              />
              <input
                className="sec-bars"
                type="number"
                min={1}
                max={999}
                value={s.bars}
                onChange={(e) => patch(s.id, { bars: Math.max(1, Number(e.target.value) || 1) })}
              />
              <span className="sec-unit">마디</span>
              <button className="icon" onClick={() => move(i, -1)} aria-label="위로">↑</button>
              <button className="icon" onClick={() => move(i, 1)} aria-label="아래로">↓</button>
              <button
                className="icon danger"
                onClick={() => onChange(sections.filter((x) => x.id !== s.id))}
                aria-label="삭제"
              >
                ×
              </button>
            </div>

            {/* 비워 두면 곡 기본값을 따른다. 박자가 바뀌는 구간만 채우면 된다. */}
            <div className="sec-row over">
              <label>
                <span>템포</span>
                <input
                  type="number"
                  min={20}
                  max={300}
                  value={s.bpm ?? ''}
                  placeholder={String(song.bpm)}
                  onChange={(e) =>
                    patch(s.id, { bpm: e.target.value === '' ? undefined : Number(e.target.value) })
                  }
                />
              </label>
              <label>
                <span>박자</span>
                <select
                  value={s.beatsPerBar ?? ''}
                  onChange={(e) =>
                    patch(s.id, {
                      beatsPerBar: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                >
                  <option value="">기본 {song.beatsPerBar}/4</option>
                  {[2, 3, 4, 5, 6, 7, 9, 12].map((n) => (
                    <option key={n} value={n}>{n}/4</option>
                  ))}
                </select>
              </label>
            </div>
          </li>
        ))}
      </ul>

      <div className="sec-presets">
        {PRESETS.map((p) => (
          <button key={p} className="chip tiny" onClick={() => add(p)}>
            + {p}
          </button>
        ))}
      </div>

      <div className="sec-add">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="구간 이름"
          maxLength={12}
        />
        <input
          className="num"
          type="number"
          min={1}
          max={999}
          value={bars}
          onChange={(e) => setBars(Math.max(1, Number(e.target.value) || 1))}
          aria-label="마디 수"
        />
        <button className="btn small" onClick={() => add()}>추가</button>
      </div>

      {sections.length > 0 && (
        <p className="hint">
          전체 <b>{totalBars(sections)}마디</b> · 약 {Math.round(totalSeconds(song))}초
        </p>
      )}
    </div>
  );
}

export default function Setlist({ room }: { room: RoomApi }) {
  const state = room.state!;
  const [title, setTitle] = useState('');
  const [bpm, setBpm] = useState(120);
  const [bpb, setBpb] = useState(4);
  const [openId, setOpenId] = useState<string | null>(null);

  const songs = state.setlist;

  const add = () => {
    const t = title.trim();
    if (!t) return;
    const song: Song = { id: newId(), title: t, bpm, beatsPerBar: bpb, sections: [] };
    room.setSetlist([...songs, song]);
    setTitle('');
    setOpenId(song.id); // 바로 구간을 짜도록 펼쳐 준다
  };

  const remove = (id: string) => room.setSetlist(songs.filter((s) => s.id !== id));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= songs.length) return;
    const next = [...songs];
    [next[index], next[target]] = [next[target], next[index]];
    room.setSetlist(next);
  };

  const patchSong = (id: string, p: Partial<Song>) =>
    room.setSetlist(songs.map((s) => (s.id === id ? { ...s, ...p } : s)));

  return (
    <div className="panel">
      <div className="panel-title">
        셋리스트
        {room.isHost && (
          <div className="panel-actions">
            <button className="chip" onClick={() => saveSetlist(songs)} disabled={!songs.length}>
              내 기기에 저장
            </button>
            <button className="chip" onClick={() => room.setSetlist(loadSavedSetlist())}>
              불러오기
            </button>
          </div>
        )}
      </div>

      {songs.length === 0 && (
        <p className="hint">아직 곡이 없습니다. {room.isHost ? '아래에서 추가하세요.' : ''}</p>
      )}

      <ul className="songs">
        {songs.map((s, i) => (
          <li key={s.id} className={i === state.currentSong ? 'song current' : 'song'}>
            <div className="song-row">
              <button
                className="song-main"
                onClick={() => room.isHost && room.selectSong(i)}
                disabled={!room.isHost}
              >
                <span className="song-no">{i + 1}</span>
                <span className="song-title">{s.title}</span>
                <span className="song-meta">
                  {s.bpm} <small>BPM</small> · {s.beatsPerBar}/4
                  {s.sections.length > 0 && ` · ${totalBars(s.sections)}마디`}
                </span>
              </button>
              {room.isHost && (
                <div className="song-tools">
                  <button className="icon" onClick={() => move(i, -1)} aria-label="위로">↑</button>
                  <button className="icon" onClick={() => move(i, 1)} aria-label="아래로">↓</button>
                  <button className="icon danger" onClick={() => remove(s.id)} aria-label="삭제">×</button>
                </div>
              )}
            </div>

            <button
              className={openId === s.id ? 'sec-toggle on' : 'sec-toggle'}
              onClick={() => setOpenId(openId === s.id ? null : s.id)}
            >
              구간 {s.sections.length > 0 ? `${s.sections.length}개` : '없음'}
              <span className="caret">{openId === s.id ? '▲' : '▼'}</span>
            </button>

            {openId === s.id &&
              (room.isHost ? (
                <SectionEditor song={s} onChange={(sections) => patchSong(s.id, { sections })} />
              ) : (
                <ul className="sec-readonly">
                  {s.sections.map((sec) => (
                    <li key={sec.id}>
                      <span>{sec.name}</span>
                      <span className="sec-unit">
                        {sec.bars}마디
                        {sec.beatsPerBar != null && ` · ${sec.beatsPerBar}/4`}
                        {sec.bpm != null && ` · ${sec.bpm}BPM`}
                      </span>
                    </li>
                  ))}
                  {s.sections.length === 0 && <li className="hint">등록된 구간이 없습니다.</li>}
                </ul>
              ))}
          </li>
        ))}
      </ul>

      {room.isHost && (
        <div className="song-add">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="곡 제목"
            maxLength={40}
          />
          <input
            className="num"
            type="number"
            value={bpm}
            min={20}
            max={300}
            onChange={(e) => setBpm(Number(e.target.value))}
            aria-label="BPM"
          />
          <select value={bpb} onChange={(e) => setBpb(Number(e.target.value))} aria-label="박자표">
            {[2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>{n}/4</option>
            ))}
          </select>
          <button className="btn small" onClick={add}>추가</button>
        </div>
      )}
    </div>
  );
}
