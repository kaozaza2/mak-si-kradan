import { ui } from "../i18n/ui";
import { store, useAppState } from "../state/store";
import { AccountPanel } from "../components/AccountPanel";
import { FriendsPanel, Leaderboard } from "../components/SocialPanels";
import { GameCard, RoomList } from "../components/common";

/** หน้ารวมของแพลตฟอร์ม — เลือกเกม หรือกระโดดเข้าห้องที่เปิดอยู่ */
export function Portal() {
  const { games, rooms, lobby } = useAppState();

  return (
    <div className="page">
      <section className="hero">
        <h1>{ui("appTagline")}</h1>
        <p>{ui("appIntro")}</p>
        <div className="stats">
          <span className="pill">
            <span className="dot" />
            {ui("playingNow", { count: lobby.inMatch })}
          </span>
          <span className="pill">{ui("inQueue", { count: lobby.inQueue })}</span>
        </div>
      </section>

      <div className="columns">
        <section>
          <h2 className="section-title">{ui("chooseGame")}</h2>
          <p className="section-note">{ui("appIntro")}</p>
          <div className="game-grid">
            {games.map((game) => (
              <GameCard key={game.id} game={game} onOpen={() => store.openGame(game.id)} />
            ))}
          </div>
        </section>

        <aside className="side-stack">
          <AccountPanel />
          <section className="panel">
            <div className="panel-head">
              <h2 className="section-title">
                {ui("openRooms")} ({rooms.length})
              </h2>
              <button className="ghost small" onClick={() => store.refreshRooms()}>
                {ui("refresh")}
              </button>
            </div>
            <RoomList rooms={rooms} showGame />
          </section>
          <FriendsPanel />
          <Leaderboard />
        </aside>
      </div>
    </div>
  );
}
