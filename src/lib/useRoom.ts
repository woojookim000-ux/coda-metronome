import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clock, now } from './clock';
import { MetronomeEngine } from './metronome';
import { buildTimeline, reanchor } from './timeline';
import type { LocalPrefs, Member, RoomState, Song } from './types';
import { DEFAULT_PREFS } from './types';

const PREFS_KEY = 'band-metronome:prefs';
const SETLIST_KEY = 'band-metronome:setlists';

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export function loadPrefs(): LocalPrefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function loadSavedSetlist(): Song[] {
  try {
    return JSON.parse(localStorage.getItem(SETLIST_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveSetlist(songs: Song[]) {
  localStorage.setItem(SETLIST_KEY, JSON.stringify(songs));
}

export type Connection = 'connecting' | 'online' | 'offline';

export function useRoom() {
  const clockRef = useRef<Clock>(null as unknown as Clock);
  if (!clockRef.current) clockRef.current = new Clock();

  const engineRef = useRef<MetronomeEngine>(null as unknown as MetronomeEngine);
  if (!engineRef.current) engineRef.current = new MetronomeEngine(clockRef.current);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<any[]>([]);
  /** 재접속했을 때 자동으로 다시 들어가기 위해 기억해 둔다 */
  const rejoinRef = useRef<{ code: string; name: string } | null>(null);
  /** 끊기기 직전에 내가 호스트였는지. 방이 되살아날 때 호스트를 돌려받는다. */
  const wasHostRef = useRef(false);

  const [connection, setConnection] = useState<Connection>('connecting');
  const [code, setCode] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [state, setState] = useState<RoomState | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState({ ready: false, dispersion: Infinity, rtt: Infinity });

  const [prefs, setPrefsState] = useState<LocalPrefs>(loadPrefs);
  const prefsRef = useRef(prefs);

  const send = useCallback((msg: any) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else pendingRef.current.push(msg);
  }, []);

  // --- 소켓 연결 (끊기면 자동 재접속) -------------------------------------
  useEffect(() => {
    let closed = false;
    let retry = 0;
    let pingTimer: number | undefined;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (closed) return;
      setConnection('connecting');

      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        setConnection('online');

        // 접속 직후에는 촘촘히, 이후에는 드물게 시계를 맞춘다.
        // 초반 집중 샘플링으로 빠르게 수렴시키고, 이후엔 시계 드리프트만 따라간다.
        let burst = 0;
        const ping = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping', t0: now() }));
        ping();
        pingTimer = window.setInterval(() => {
          ping();
          burst++;
          if (burst === 14) {
            clearInterval(pingTimer);
            pingTimer = window.setInterval(ping, 4000);
          }
        }, 120);

        if (rejoinRef.current) {
          // rejoin 표시가 있어야 서버가 사라진 방을 같은 코드로 되살려 준다
          ws.send(
            JSON.stringify({
              type: 'join',
              ...rejoinRef.current,
              rejoin: true,
              wasHost: wasHostRef.current,
            })
          );
        }
        for (const m of pendingRef.current.splice(0)) ws.send(JSON.stringify(m));
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        switch (msg.type) {
          case 'pong': {
            const clock = clockRef.current;
            clock.addSample(msg.t0, msg.ts, now());
            setSync({ ready: clock.ready, dispersion: clock.dispersion, rtt: clock.rtt });
            break;
          }
          case 'joined':
            setCode(msg.code);
            setMyId(msg.id);
            setError(null);
            rejoinRef.current = { code: msg.code, name: prefsRef.current.name || '멤버' };
            break;
          case 'room':
            // 예전 버전 서버나 예전에 저장해 둔 셋리스트에는 sections가 없다.
            // 여기서 한 번 채워 두면 화면 쪽에서 방어할 필요가 없다.
            setState({
              ...msg.state,
              setlist: (msg.state.setlist ?? []).map((s: Song) => ({
                ...s,
                sections: Array.isArray(s.sections) ? s.sections : [],
              })),
            });
            setMembers(msg.members);
            setHostId(msg.hostId);
            break;
          case 'error':
            setError(msg.message);
            rejoinRef.current = null;
            break;
        }
      };

      ws.onclose = () => {
        clearInterval(pingTimer);
        if (closed) return;
        setConnection('offline');
        // 서버가 재시작되면 시계 기준이 바뀔 수 있으니 샘플을 버린다
        clockRef.current.reset();
        setSync({ ready: false, dispersion: Infinity, rtt: Infinity });
        retry++;
        reconnectTimer = window.setTimeout(connect, Math.min(5000, 300 * retry));
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  // --- 상태/설정을 엔진에 전달 -------------------------------------------
  useEffect(() => {
    prefsRef.current = prefs;
    engineRef.current.setPrefs(prefs);
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [prefs]);

  // 곡 구간마다 템포·박자표가 다를 수 있으므로 방 상태에서 타임라인을 만든다.
  // 엔진과 화면이 같은 타임라인을 봐야 소리와 표시가 어긋나지 않는다.
  const timeline = useMemo(() => {
    const song = state && state.currentSong >= 0 ? state.setlist[state.currentSong] : null;
    return buildTimeline({
      sections: song?.sections ?? [],
      baseBpm: state?.bpm ?? 120,
      baseBeatsPerBar: state?.beatsPerBar ?? 4,
      countInBars: state?.countInEnabled ? state.countInBars : 0,
    });
  }, [
    state?.bpm,
    state?.beatsPerBar,
    state?.countInEnabled,
    state?.countInBars,
    state?.currentSong,
    state?.setlist,
  ]);

  useEffect(() => {
    if (state) engineRef.current.setState(state, timeline);
  }, [state, timeline]);

  // 소리 켠 사람이 누군지 다른 멤버에게도 보이도록
  useEffect(() => {
    if (code) send({ type: 'presence', name: prefs.name || '멤버', soundOn: prefs.soundOn });
  }, [code, prefs.name, prefs.soundOn, send]);

  // 재생 중에는 화면이 꺼지지 않게 (모바일에서 화면이 꺼지면 오디오도 멈춘다)
  useEffect(() => {
    if (!state?.running) return;
    let lock: any = null;
    let released = false;

    const acquire = async () => {
      try {
        lock = await (navigator as any).wakeLock?.request('screen');
      } catch {
        /* 미지원 브라우저 */
      }
    };
    acquire();

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !released) acquire();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release?.().catch(() => {});
    };
  }, [state?.running]);

  const setPrefs = useCallback((patch: Partial<LocalPrefs>) => {
    setPrefsState((p) => ({ ...p, ...patch }));
  }, []);

  const isHost = !!myId && myId === hostId;

  // 끊기는 순간의 값이 아니라, 끊기기 직전까지의 값을 기억해 둬야 한다
  useEffect(() => {
    if (myId && hostId) wasHostRef.current = myId === hostId;
  }, [myId, hostId]);

  /**
   * 호스트가 템포·박자표·곡을 바꿀 때 쓴다.
   *
   * 재생 중이라면 anchor를 다시 계산해서 함께 보낸다. 서버는 곡 구조를 모르므로
   * (구간마다 템포가 다를 수 있어 계산이 복잡하다) 이 계산은 호스트가 한다.
   * 서버는 받은 값을 검증해서 저장·전파만 한다.
   */
  const applyPatch = useCallback(
    (patch: Partial<RoomState>) => {
      if (!state) return;
      let full = patch;

      if (state.running) {
        const next = { ...state, ...patch };
        const nextSong = next.currentSong >= 0 ? next.setlist[next.currentSong] : null;
        const nextTimeline = buildTimeline({
          sections: nextSong?.sections ?? [],
          baseBpm: next.bpm,
          baseBeatsPerBar: next.beatsPerBar,
          countInBars: next.countInEnabled ? next.countInBars : 0,
        });
        full = {
          ...patch,
          anchor: reanchor(timeline, nextTimeline, state.anchor, clockRef.current.serverNow()),
        };
      }

      send({ type: 'update', patch: full });
    },
    [state, timeline, send]
  );

  return {
    engine: engineRef.current,
    clock: clockRef.current,
    timeline,
    connection,
    sync,
    code,
    myId,
    isHost,
    state,
    members,
    error,
    prefs,
    setPrefs,
    clearError: () => setError(null),

    createRoom: (name: string) => {
      rejoinRef.current = null;
      send({ type: 'create', name });
    },
    joinRoom: (roomCode: string, name: string) => {
      rejoinRef.current = { code: roomCode.toUpperCase(), name };
      send({ type: 'join', code: roomCode.toUpperCase(), name });
    },
    setBpm: (bpm: number) => applyPatch({ bpm: Math.min(300, Math.max(20, Math.round(bpm))) }),
    setMeter: (beatsPerBar: number) => applyPatch({ beatsPerBar }),
    setCountIn: (countInEnabled: boolean, bars?: number) =>
      applyPatch(bars == null ? { countInEnabled } : { countInEnabled, countInBars: bars }),
    start: () => send({ type: 'start' }),
    stop: () => applyPatch({ running: false }),
    setSetlist: (setlist: Song[]) => send({ type: 'setSetlist', setlist }),
    selectSong: (index: number) => {
      const song = state?.setlist[index];
      if (!song) return;
      // 곡을 고르면 그 곡의 기본 템포·박자표도 함께 적용한다
      applyPatch({ currentSong: index, bpm: song.bpm, beatsPerBar: song.beatsPerBar });
    },
    handOffHost: (to: string) => send({ type: 'handOffHost', to }),
  };
}
