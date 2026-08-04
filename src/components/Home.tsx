import { useEffect, useState } from 'react';
import type { RoomApi } from '../App';

export default function Home({ room }: { room: RoomApi }) {
  const [name, setName] = useState(room.prefs.name);
  const [code, setCode] = useState('');

  // QR이나 링크로 들어온 경우 코드를 미리 채워 준다
  useEffect(() => {
    const fromUrl = new URLSearchParams(location.search).get('room');
    if (fromUrl) setCode(fromUrl.toUpperCase());
  }, []);

  const commitName = () => {
    const trimmed = name.trim().slice(0, 20);
    room.setPrefs({ name: trimmed });
    return trimmed || '멤버';
  };

  return (
    <div className="screen home">
      <header className="home-head">
        <div className="logo">♩</div>
        <h1>코다 합주 메트로놈</h1>
        <p className="tagline">
          한 방에 모이면 모든 기기가 <b>같은 순간에</b> 클릭을 냅니다.
        </p>
      </header>

      <div className="card">
        <label className="field">
          <span>내 이름 (또는 파트)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 드럼 우주"
            maxLength={20}
          />
        </label>

        <button
          className="btn primary big"
          onClick={() => room.createRoom(commitName())}
          disabled={room.connection !== 'online'}
        >
          방 만들기
        </button>

        <div className="divider"><span>또는</span></div>

        <label className="field">
          <span>방 코드로 참여</span>
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
            placeholder="ABC123"
            inputMode="text"
            autoCapitalize="characters"
          />
        </label>

        <button
          className="btn big"
          onClick={() => room.joinRoom(code, commitName())}
          disabled={code.length < 4 || room.connection !== 'online'}
        >
          참여하기
        </button>

        {room.error && (
          <p className="error" onClick={room.clearError}>
            {room.error}
          </p>
        )}
        {room.connection !== 'online' && (
          <p className="hint">
            {room.connection === 'connecting' ? '서버에 연결하는 중…' : '서버와 연결이 끊겼습니다. 다시 연결 중…'}
          </p>
        )}
      </div>

      <p className="footnote">
        블루투스 이어폰은 소리가 150~200ms 늦게 나옵니다. 방에 들어간 뒤
        <b> 내 기기 설정 → 오디오 지연 보정</b>에서 꼭 맞춰 주세요.
      </p>
    </div>
  );
}
