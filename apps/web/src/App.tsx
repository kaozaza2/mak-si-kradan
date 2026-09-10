import { useEffect, useState } from "react";
import { InviteModal, TopBar, Toasts } from "./components/common";
import { loadCatalog } from "./i18n/messages";
import { GameLobby } from "./screens/GameLobby";
import { Portal } from "./screens/Portal";
import { ResultScreen } from "./screens/ResultScreen";
import { RoomScreen } from "./screens/RoomScreen";
import { MatchScreen } from "./screens/MatchScreen";
import { store, useAppState } from "./state/store";

/**
 * เลือกหน้าจากสถานะ ไม่ใช่จาก URL
 *
 * เพราะหน้าจอถูกกำหนดโดยเซิร์ฟเวอร์เป็นหลัก — กลับมาหลังหลุดแล้วเซิร์ฟเวอร์
 * ส่งห้องหรือแมตช์ที่ค้างอยู่กลับมาเอง หน้าเว็บแค่วาดตาม
 */
function Screen() {
  const { room, match, state, result, activeGameId } = useAppState();
  if (result && match) return <ResultScreen result={result} match={match} />;
  if (match && state) return <MatchScreen match={match} state={state} />;
  if (room) return <RoomScreen room={room} />;
  if (activeGameId) return <GameLobby gameId={activeGameId} />;
  return <Portal />;
}

export function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // โหลดคำแปลก่อนต่อ ไม่งั้นข้อความแรก ๆ จะโผล่มาเป็นรหัสดิบ
    loadCatalog().then(() => {
      if (cancelled) return;
      setReady(true);
      store.connect();
      // เข้ามาทางลิงก์เชิญก็เข้าห้องให้เลย
      const invited = location.pathname.match(/^\/join\/([A-Za-z0-9]{4,10})$/);
      if (invited) {
        store.joinRoom(invited[1].toUpperCase());
        history.replaceState(null, "", "/");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return <div className="app" />;

  return (
    <div className="app">
      <TopBar />
      <Screen />
      <InviteModal />
      <Toasts />
    </div>
  );
}
