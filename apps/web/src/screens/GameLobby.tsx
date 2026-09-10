import { useState } from "react";
import { gameName, gameTagline, t } from "../i18n/messages";
import { ui } from "../i18n/ui";
import { store, useAppState } from "../state/store";
import { CreateRoomModal } from "../components/CreateRoomModal";
import { RoomList } from "../components/common";

/** หน้าของเกมหนึ่งเกม — ปุ่มเริ่มเล่นทุกแบบอยู่ที่นี่ */
export function GameLobby({ gameId }: { gameId: string }) {
  const { games, rooms, searching } = useAppState();
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState("");

  const game = games.find((item) => item.id === gameId);
  if (!game) return <div className="page" />;

  const forThisGame = rooms.filter((room) => room.gameId === gameId);

  return (
    <div className="page">
      <div className="lobby">
        <span className="art">{game.icon}</span>
        <h1>{gameName(game.id)}</h1>
        <p className="tagline">{gameTagline(game.id)}</p>

        {searching ? (
          <>
            <div className="queue">
              <span className="spinner" />
              {ui("searching")}
            </div>
            <button className="ghost big" onClick={() => store.cancelQuickMatch()}>
              {ui("cancel")}
            </button>
          </>
        ) : (
          <button className="primary big" onClick={() => store.quickMatch(game.id)}>
            {ui("playOnline")}
          </button>
        )}

        {game.hasBots ? (
          <>
            <p className="empty">{ui("playBot")}</p>
            <div className="bot-row">
              {game.botLevels.map((level) => (
                <button key={level} onClick={() => store.playAi(game.id, level)}>
                  {t(`ai_${level}`)}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <button className="accent big" onClick={() => setCreating(true)}>
          {ui("createRoom")}
        </button>

        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) store.joinRoom(code.trim().toUpperCase());
            setCode("");
          }}
        >
          <input
            aria-label={ui("joinByCode")}
            placeholder={ui("roomCode")}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            style={{ textTransform: "uppercase", letterSpacing: "0.18em" }}
          />
          <button type="submit">{ui("join")}</button>
        </form>

        <section className="panel" style={{ textAlign: "left", marginTop: 10 }}>
          <div className="panel-head">
            <h2 className="section-title">
              {ui("openRooms")} ({forThisGame.length})
            </h2>
            <button className="ghost small" onClick={() => store.refreshRooms(gameId)}>
              {ui("refresh")}
            </button>
          </div>
          <RoomList rooms={forThisGame} />
        </section>
      </div>

      {creating ? <CreateRoomModal game={game} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
