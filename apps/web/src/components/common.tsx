import { useEffect, useState } from "react";
import { gameName } from "../i18n/messages";
import { modeName, ui } from "../i18n/ui";
import { store, useAppState } from "../state/store";
import type { GameSummary, RoomSummary } from "../api/types";

export function Toasts() {
  const { toasts } = useAppState();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`} role="status">
          {toast.text}
        </div>
      ))}
    </div>
  );
}

export function TopBar() {
  const { session, lobby, activeGameId, match } = useAppState();
  const [name, setName] = useState("");

  useEffect(() => {
    if (session) setName(session.name);
  }, [session]);

  const showBack = activeGameId !== null && match === null;

  return (
    <header className="topbar">
      {showBack ? (
        <button className="ghost small" onClick={() => store.openGame(null)}>
          ← {ui("back")}
        </button>
      ) : null}
      <button className="brand" onClick={() => store.openGame(null)}>
        MAK-THAI
      </button>
      <div className="spacer" />
      <span className="pill">
        <span className="dot" />
        {ui("playingNow", { count: lobby.inMatch })}
      </span>
      <input
        className="name-field"
        aria-label={ui("yourName")}
        value={name}
        placeholder={ui("yourName")}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => name.trim() && store.setName(name.trim())}
      />
    </header>
  );
}

export function GameCard({ game, onOpen }: { game: GameSummary; onOpen: () => void }) {
  return (
    <button className="game-card" onClick={onOpen}>
      <span className="art">{game.icon}</span>
      <span className="label">
        <b>{gameName(game.id)}</b>
        <span>
          {game.minPlayers}–{game.maxPlayers} {ui("maxPlayers")}
          {game.playing > 0 ? ` · ${ui("playingNow", { count: game.playing })}` : ""}
        </span>
      </span>
    </button>
  );
}

export function RoomList({ rooms, showGame }: { rooms: RoomSummary[]; showGame?: boolean }) {
  if (rooms.length === 0) return <p className="empty">{ui("noRooms")}</p>;
  return (
    <ul className="room-list">
      {rooms.map((room) => (
        <li key={room.id}>
          <span>
            {room.hostName}
            <span className="meta">
              <br />
              {showGame ? `${gameName(room.gameId)} · ` : ""}
              {room.players}/{room.capacity}
              {room.bots > 0 ? ` · AI ${room.bots}` : ""} · {modeName(room.mode)}
              {room.custom ? ` · ${ui("unranked")}` : ""}
            </span>
          </span>
          <button className="small" onClick={() => store.joinRoom(room.id)}>
            {ui("join")}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function InviteModal() {
  const { invite } = useAppState();
  if (!invite) return null;
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="panel">
        <h2>{ui("inviteTitle", { name: invite.fromName })}</h2>
        <p className="empty">
          {gameName(invite.gameId)} · {invite.players}/{invite.capacity} ·{" "}
          {modeName(invite.mode)} ·{" "}
          {invite.turnSeconds > 0 ? `${invite.turnSeconds}s` : ui("noLimit")}
        </p>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="primary" onClick={() => store.joinRoom(invite.code)}>
            {ui("join")}
          </button>
          <button className="ghost" onClick={() => store.dismissInvite()}>
            {ui("later")}
          </button>
        </div>
      </div>
    </div>
  );
}
