import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// StrictMode는 쓰지 않는다. 개발 중 이중 마운트가 WebSocket과 AudioContext를
// 두 번 만들어 타이밍 측정을 방해한다.
createRoot(document.getElementById('root')!).render(<App />);
