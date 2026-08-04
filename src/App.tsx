import Home from './components/Home';
import RoomView from './components/Room';
import { useRoom } from './lib/useRoom';

export default function App() {
  const room = useRoom();
  return room.code ? <RoomView room={room} /> : <Home room={room} />;
}

export type RoomApi = ReturnType<typeof useRoom>;
