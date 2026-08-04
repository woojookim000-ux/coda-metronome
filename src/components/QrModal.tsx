import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export default function QrModal({ code, onClose }: { code: string; onClose: () => void }) {
  const [dataUrl, setDataUrl] = useState('');
  const url = `${location.origin}/?room=${code}`;

  useEffect(() => {
    QRCode.toDataURL(url, {
      width: 560,
      margin: 1,
      color: { dark: '#0b0d12', light: '#ffffff' },
    }).then(setDataUrl);
  }, [url]);

  const copy = () => navigator.clipboard?.writeText(url);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>이 QR을 찍으면 바로 참여</h2>
        {dataUrl ? <img className="qr" src={dataUrl} alt={`방 ${code} 참여 QR`} /> : <div className="qr placeholder" />}
        <div className="room-code big">{code}</div>
        <button className="btn" onClick={copy}>링크 복사</button>
        <button className="btn ghost" onClick={onClose}>닫기</button>
      </div>
    </div>
  );
}
