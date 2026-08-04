/**
 * 합주 메트로놈 서버
 *
 * 역할이 두 가지뿐이다.
 *  1) 시계 기준점 제공 — 클라이언트의 ping에 서버 시각을 붙여 돌려준다.
 *     클라이언트는 왕복시간으로 자기 시계의 오프셋을 추정한다. (NTP와 같은 방식)
 *  2) 방 상태(bpm/박자표/시작시각) 보관 및 브로드캐스트.
 *
 * 박자 신호 자체는 절대 보내지 않는다. "서버시각 anchor에 anchorBeat번째 박,
 * 이후 60000/bpm ms 간격" 이라는 규칙만 공유하고, 소리 예약은 각 기기가 한다.
 * 그래서 네트워크 지터가 클릭 타이밍에 영향을 주지 않는다.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
// --port가 있으면 그것을 쓴다. 개발 중에는 Vite가 쓰는 포트와 겹치면 안 되므로
// 환경변수 PORT(호스팅 업체가 주입)보다 명시적 인자를 우선한다.
const portArgIndex = process.argv.indexOf('--port');
const PORT = portArgIndex !== -1 ? Number(process.argv[portArgIndex + 1]) : process.env.PORT || 3001;

const serverNow = () => performance.timeOrigin + performance.now();

// ---------------------------------------------------------------- 정적 파일

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('개발 모드: 클라이언트는 http://localhost:5173 에서 확인하세요.\n(배포하려면 npm run build 후 다시 실행)');
    return;
  }

  const url = (req.url || '/').split('?')[0];
  let filePath = path.join(DIST, decodeURIComponent(url));

  // dist 밖으로 나가는 경로 차단
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html'); // SPA 폴백
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(filePath).pipe(res);
}

const httpServer = http.createServer(serveStatic);

// ---------------------------------------------------------------- 방 관리

/** @type {Map<string, Room>} */
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 0/O/1/I 제외

function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return 'R' + Date.now().toString(36).toUpperCase().slice(-5);
}

function defaultState() {
  return {
    bpm: 120,
    beatsPerBar: 4,
    running: false,
    anchor: 0, // 서버 시각(ms) — anchorBeat번째 박이 울리는 순간
    anchorBeat: 0, // anchor에 대응하는 논리 박 번호 (음수 = 카운트인)
    countInEnabled: true,
    countInBars: 1,
    setlist: [],
    currentSong: -1,
  };
}

function createRoom(code) {
  const room = {
    code,
    hostId: null,
    state: defaultState(),
    members: new Map(), // id -> { ws, name, soundOn }
    emptySince: null,
  };
  rooms.set(code, room);
  return room;
}

function memberList(room) {
  return [...room.members.entries()].map(([id, m]) => ({
    id,
    name: m.name,
    soundOn: m.soundOn,
    isHost: id === room.hostId,
  }));
}

function broadcast(room, msg) {
  const payload = JSON.stringify(msg);
  for (const m of room.members.values()) {
    if (m.ws.readyState === m.ws.OPEN) m.ws.send(payload);
  }
}

function broadcastRoom(room) {
  broadcast(room, {
    type: 'room',
    state: room.state,
    members: memberList(room),
    hostId: room.hostId,
    serverTime: serverNow(),
  });
}

/**
 * 재생 중에 bpm이나 박자표를 바꿀 때, 다음 박 위치로 기준점을 옮긴다.
 * 이렇게 해야 박이 겹치거나 건너뛰지 않고 마디 번호도 유지된다.
 */
function reanchor(state) {
  if (!state.running) return;
  const interval = 60000 / state.bpm;
  const idx = Math.max(0, Math.ceil((serverNow() - state.anchor) / interval));
  state.anchor = state.anchor + idx * interval;
  state.anchorBeat = state.anchorBeat + idx;
}

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

let nextClientId = 1;

wss.on('connection', (ws) => {
  const id = 'c' + nextClientId++;
  ws.isAlive = true;
  ws.roomCode = null;
  ws.on('pong', () => { ws.isAlive = true; });

  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const currentRoom = () => (ws.roomCode ? rooms.get(ws.roomCode) : null);
  const isHost = () => {
    const room = currentRoom();
    return !!room && room.hostId === id;
  };

  send({ type: 'hello', id, serverTime: serverNow() });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // --- 시계 동기화: 가장 뜨거운 경로. 다른 처리보다 먼저, 최소한의 일만 한다.
    if (msg.type === 'ping') {
      send({ type: 'pong', t0: msg.t0, ts: serverNow() });
      return;
    }

    switch (msg.type) {
      case 'create': {
        const code = makeCode();
        const room = createRoom(code);
        room.hostId = id;
        room.members.set(id, { ws, name: msg.name || '호스트', soundOn: true });
        ws.roomCode = code;
        send({ type: 'joined', code, id, isHost: true });
        broadcastRoom(room);
        break;
      }

      case 'join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) {
          send({ type: 'error', message: '그런 방이 없습니다. 코드를 다시 확인해 주세요.' });
          return;
        }
        room.emptySince = null;
        room.members.set(id, { ws, name: msg.name || '멤버', soundOn: true });
        if (!room.hostId) room.hostId = id;
        ws.roomCode = code;
        send({ type: 'joined', code, id, isHost: room.hostId === id });
        broadcastRoom(room);
        break;
      }

      case 'presence': {
        const room = currentRoom();
        if (!room) return;
        const me = room.members.get(id);
        if (!me) return;
        if (typeof msg.name === 'string') me.name = msg.name.slice(0, 20);
        if (typeof msg.soundOn === 'boolean') me.soundOn = msg.soundOn;
        broadcastRoom(room);
        break;
      }

      case 'setBpm': {
        const room = currentRoom();
        if (!room || !isHost()) return;
        const bpm = Math.min(300, Math.max(20, Math.round(Number(msg.bpm) || 120)));
        if (bpm === room.state.bpm) return;
        reanchor(room.state);
        room.state.bpm = bpm;
        broadcastRoom(room);
        break;
      }

      case 'setMeter': {
        const room = currentRoom();
        if (!room || !isHost()) return;
        const bpb = Math.min(12, Math.max(1, Math.round(Number(msg.beatsPerBar) || 4)));
        if (bpb === room.state.beatsPerBar) return;
        reanchor(room.state);
        room.state.beatsPerBar = bpb;
        room.state.anchorBeat = 0; // 새 박자표는 1마디 1박부터 다시 센다
        broadcastRoom(room);
        break;
      }

      case 'setCountIn': {
        const room = currentRoom();
        if (!room || !isHost()) return;
        room.state.countInEnabled = !!msg.enabled;
        if (msg.bars != null) {
          room.state.countInBars = Math.min(4, Math.max(1, Math.round(Number(msg.bars) || 1)));
        }
        broadcastRoom(room);
        break;
      }

      case 'start': {
        const room = currentRoom();
        if (!room || !isHost()) return;
        const s = room.state;
        // 모든 기기가 예약할 시간을 벌기 위한 리드타임
        s.anchor = serverNow() + 600;
        s.anchorBeat = s.countInEnabled ? -(s.countInBars * s.beatsPerBar) : 0;
        s.running = true;
        broadcastRoom(room);
        break;
      }

      case 'stop': {
        const room = currentRoom();
        if (!room || !isHost()) return;
        room.state.running = false;
        broadcastRoom(room);
        break;
      }

      case 'setSetlist': {
        const room = currentRoom();
        if (!room || !isHost()) return;
        if (!Array.isArray(msg.setlist)) return;
        room.state.setlist = msg.setlist.slice(0, 100).map((s) => ({
          id: String(s.id ?? Math.random().toString(36).slice(2)),
          title: String(s.title ?? '').slice(0, 40),
          bpm: Math.min(300, Math.max(20, Math.round(Number(s.bpm) || 120))),
          beatsPerBar: Math.min(12, Math.max(1, Math.round(Number(s.beatsPerBar) || 4))),
          sections: (Array.isArray(s.sections) ? s.sections : []).slice(0, 40).map((sec) => ({
            id: String(sec.id ?? Math.random().toString(36).slice(2)),
            name: String(sec.name ?? '').slice(0, 12),
            bars: Math.min(999, Math.max(1, Math.round(Number(sec.bars) || 8))),
          })),
        }));
        if (room.state.currentSong >= room.state.setlist.length) room.state.currentSong = -1;
        broadcastRoom(room);
        break;
      }

      case 'selectSong': {
        const room = currentRoom();
        if (!room || !isHost()) return;
        const i = Number(msg.index);
        const song = room.state.setlist[i];
        if (!song) return;
        reanchor(room.state);
        room.state.currentSong = i;
        room.state.bpm = song.bpm;
        if (song.beatsPerBar !== room.state.beatsPerBar) {
          room.state.beatsPerBar = song.beatsPerBar;
          room.state.anchorBeat = 0;
        }
        broadcastRoom(room);
        break;
      }

      case 'handOffHost': {
        const room = currentRoom();
        if (!room || !isHost()) return;
        if (!room.members.has(msg.to)) return;
        room.hostId = msg.to;
        broadcastRoom(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = currentRoom();
    if (!room) return;
    room.members.delete(id);
    if (room.members.size === 0) {
      room.emptySince = Date.now();
    } else {
      if (room.hostId === id) room.hostId = room.members.keys().next().value;
      broadcastRoom(room);
    }
  });
});

// 끊어진 소켓 정리 + 빈 방 회수
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const cutoff = Date.now() - 10 * 60 * 1000; // 빈 방은 10분 후 삭제
  for (const [code, room] of rooms) {
    if (room.emptySince && room.emptySince < cutoff) rooms.delete(code);
  }
}, 30000);

httpServer.listen(PORT, () => {
  console.log(`[합주 메트로놈] http://localhost:${PORT}  (ws: /ws)`);
});
