import { useState } from "react";
import type { GameSummary } from "../api/types";
import { modeName, ui } from "../i18n/ui";
import { store } from "../state/store";

/**
 * ฟอร์มสร้างห้อง
 *
 * ตัวเลือกขั้นสูงถูกพับไว้ เพราะคนส่วนใหญ่แค่กดสร้างแล้วเล่น และการเปลี่ยนค่าพวกนี้
 * ทำให้เกมไม่นับอันดับ จึงบอกไว้ให้ชัดตรงที่กด ไม่ใช่ให้ไปรู้ทีหลัง
 */
export function CreateRoomModal({
  game,
  onClose,
}: {
  game: GameSummary;
  onClose: () => void;
}) {
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [bots, setBots] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [capacity, setCapacity] = useState(game.minPlayers);
  const [turnSeconds, setTurnSeconds] = useState(game.defaultTurnSeconds);
  const [mode, setMode] = useState(game.modes[0]);

  const custom =
    bots > 0 ||
    capacity !== game.minPlayers ||
    turnSeconds !== game.defaultTurnSeconds ||
    mode !== game.modes[0];

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={ui("createRoom")}>
      <div className="panel">
        <h2>{ui("createRoom")}</h2>

        <div className="toggle">
          <button
            className={visibility === "public" ? "on" : ""}
            onClick={() => setVisibility("public")}
          >
            {ui("public")}
          </button>
          <button
            className={visibility === "private" ? "on" : ""}
            onClick={() => setVisibility("private")}
          >
            {ui("private")}
          </button>
        </div>

        <label className="field">
          {ui("botCount")}
          <input
            type="number"
            min={0}
            max={capacity - 1}
            value={bots}
            onChange={(event) => setBots(Math.max(0, Number(event.target.value) || 0))}
          />
        </label>

        <button
          className="ghost small"
          style={{ width: "100%", marginTop: 12 }}
          onClick={() => setAdvanced((open) => !open)}
          aria-expanded={advanced}
        >
          {ui("advanced")} {advanced ? "▲" : "▼"}
        </button>

        {advanced ? (
          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <div className="grid-two">
              <label className="field">
                {ui("turnLimit")}
                <input
                  type="number"
                  min={0}
                  max={600}
                  value={turnSeconds}
                  onChange={(event) => setTurnSeconds(Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
              <label className="field">
                {ui("maxPlayers")}
                <select
                  value={capacity}
                  onChange={(event) => setCapacity(Number(event.target.value))}
                >
                  {Array.from(
                    { length: game.maxPlayers - game.minPlayers + 1 },
                    (_, index) => game.minPlayers + index,
                  ).map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              {ui("ruleMode")}
              <select value={mode} onChange={(event) => setMode(event.target.value)}>
                {game.modes.map((option) => (
                  <option key={option} value={option}>
                    {modeName(option)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {custom ? <p className="warn">{ui("customUnranked")}</p> : null}

        <div className="row" style={{ marginTop: 16 }}>
          <button
            className="primary"
            onClick={() => {
              store.createRoom({
                gameId: game.id,
                visibility,
                capacity,
                turnSeconds,
                mode,
                bots,
              });
              onClose();
            }}
          >
            {ui("create")}
          </button>
          <button className="ghost" onClick={onClose}>
            {ui("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
