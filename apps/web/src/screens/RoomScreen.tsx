import { useState } from "react";
import type { RoomView } from "../api/types";
import { gameName, playerName } from "../i18n/messages";
import { modeName, ui } from "../i18n/ui";
import { FriendsPanel } from "../components/SocialPanels";
import { store, useAppState } from "../state/store";

/** ห้องรอเล่น — ที่นั่ง รหัสห้อง และปุ่มเริ่ม */
export function RoomScreen({ room }: { room: RoomView }) {
  const { session, games } = useAppState();
  const [copied, setCopied] = useState(false);

  const isHost = session?.id === room.hostId;
  const game = games.find((item) => item.id === room.gameId);
  const emptySeats = Math.max(0, room.capacity - room.players.length);

  const statusText = room.players.length >= 2
    ? isHost
      ? ui("readyToStart")
      : ui("waitingHost")
    : ui("waitingPlayers", { players: room.players.length, capacity: room.capacity });

  return (
    <div className="page">
      <div className="lobby">
        <h1>{gameName(room.gameId)}</h1>
        <div className="code">{room.code}</div>
        <button
          className="ghost small"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(room.inviteUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              store.toast(room.inviteUrl);
            }
          }}
        >
          {copied ? ui("copied") : ui("copyLink")}
        </button>

        <p className="empty">
          {room.visibility === "public" ? ui("public") : ui("private")} ·{" "}
          {modeName(room.mode)} ·{" "}
          {room.turnSeconds > 0 ? `${room.turnSeconds}s` : ui("noLimit")}
          {room.custom ? ` · ${ui("unranked")}` : ""}
        </p>

        <div className="seat-grid">
          {room.players.map((player) => (
            <div className="seat" key={player.id}>
              {isHost && player.bot ? (
                <button
                  className="kick"
                  aria-label={`remove ${player.id}`}
                  onClick={() => store.removeBot(player.id)}
                >
                  ✕
                </button>
              ) : null}
              <span className="avatar">{player.bot ? "🤖" : "🙂"}</span>
              <span className="who">{playerName(player)}</span>
              {player.id === room.hostId ? <span className="tag">{ui("host")}</span> : null}
            </div>
          ))}
          {Array.from({ length: emptySeats }, (_, index) => (
            <div className="seat empty" key={`empty-${index}`}>
              <span className="avatar">＋</span>
              <span className="who">{ui("inviteSlot")}</span>
            </div>
          ))}
        </div>

        {isHost && game?.hasBots && emptySeats > 0 ? (
          <div className="bot-row">
            {game.botLevels.map((level) => (
              <button key={level} className="small" onClick={() => store.addBot(level)}>
                {ui("addBot")} · {level}
              </button>
            ))}
          </div>
        ) : null}

        <p className="empty">
          {statusText} · {ui("orderRandom")}
        </p>

        <div className="row">
          <button
            className="primary"
            disabled={!isHost || room.players.length < 2}
            onClick={() => store.startRoom()}
          >
            {ui("start")}
          </button>
          <button className="ghost" onClick={() => store.leaveRoom()}>
            {ui("leaveRoom")}
          </button>
        </div>

        <div style={{ textAlign: "left", width: "100%" }}>
          <FriendsPanel />
        </div>
      </div>
    </div>
  );
}
