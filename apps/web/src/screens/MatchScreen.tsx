import { useEffect, useState } from "react";
import type { MakSiKradanView, MatchStart, MatchState } from "../api/types";
import { playerName } from "../i18n/messages";
import { ui } from "../i18n/ui";
import { store, useAppState } from "../state/store";

const CENTER_HOLES = new Set([27, 28, 35, 36]);

/**
 * กระดานหมากสี่กระดาน
 *
 * ไม่คำนวณกติกาเองเลย — ใช้ selectable / targets / canEndTurn ที่เซิร์ฟเวอร์ส่งมา
 * เพราะโหมดกระดานจริงเซิร์ฟเวอร์จงใจไม่ส่งข้อมูลช่วยเหลือมาให้
 */
function Board({ view, yourTurn }: { view: MakSiKradanView; yourTurn: boolean }) {
  const selectable = new Set(yourTurn ? view.selectable : []);
  const targets = new Set(yourTurn ? view.targets : []);
  const path = new Set(view.selection?.path ?? []);
  const eaten = new Set(view.selection?.capturedSquares ?? []);

  const onCellClick = (square: number) => {
    if (!yourTurn || view.status !== "active") return;
    if (targets.has(square)) {
      store.act("play", { to: square });
      return;
    }
    if (view.rules.assist === "full") {
      if (selectable.has(square)) store.act("select", { square });
      return;
    }
    // โหมดที่ไม่ชี้เป้า: หยิบหมากแล้วก็แค่วางลงช่องที่ต้องการ
    if (view.selection) {
      if (square !== view.selection.at) store.act("play", { to: square });
      return;
    }
    store.act("select", { square });
  };

  return (
    <div className="board" role="grid" aria-label="board">
      {view.board.map((piece, square) => {
        const dark = ((square >> 3) + (square & 7)) % 2 === 1;
        const classes = ["cell"];
        if (dark) classes.push("odd");
        if (CENTER_HOLES.has(square)) classes.push("center");
        if (view.selection?.at === square) classes.push("selected");
        if (path.has(square)) classes.push("path");
        if (eaten.has(square)) classes.push("eaten");
        if (targets.has(square)) classes.push("target", view.targetKind);
        else if (selectable.has(square)) classes.push("selectable");

        return (
          <button
            key={square}
            type="button"
            className={classes.join(" ")}
            data-square={square}
            onClick={() => onCellClick(square)}
          >
            {piece >= 0 ? <span className="piece" /> : null}
          </button>
        );
      })}
    </div>
  );
}

function Clock({ state }: { state: MatchState }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 250);
    return () => clearInterval(timer);
  }, []);

  const view = state.view;
  if (view.status !== "active" || state.deadline === null) {
    return (
      <div className="clock">
        <div className="turn">Turn {view.turn}</div>
        <div className="time">{state.turnSeconds > 0 ? "–" : "∞"}</div>
      </div>
    );
  }
  // ใช้เวลาของเซิร์ฟเวอร์เป็นหลัก ชดเชยนาฬิกาเครื่องที่ไม่ตรงกัน
  const skew = Date.now() / 1000 - state.now;
  const left = Math.max(0, Math.ceil(state.deadline + skew - Date.now() / 1000));
  return (
    <div className="clock">
      <div className="turn">Turn {view.turn}</div>
      <div className={`time${left <= 10 ? " warn" : ""}`}>{left}s</div>
    </div>
  );
}

function statusText(state: MatchState, match: MatchStart): string {
  const view = state.view;
  if (view.status !== "active") return ui("gameOver");
  if (state.autopilot.includes(match.you)) return ui("autopilotYours");
  if (view.current !== match.you) {
    return ui("waitingFor", { name: playerName(state.players[view.current]) });
  }
  if (!view.selection) return ui("yourTurn");
  if (view.targetKind === "capture") return ui("pickTarget");
  if (view.targetKind === "move") return ui("pickMove");
  if (view.canEndTurn) return ui("chainOrStop");
  return ui("placePiece");
}

export function MatchScreen({ match, state }: { match: MatchStart; state: MatchState }) {
  const { session } = useAppState();
  const view = state.view;
  const yourTurn = view.current === match.you && view.status === "active";
  const selection = view.selection;
  const inChain = Boolean(selection && selection.capturesSoFar > 0);
  const nearEnd =
    view.status === "active" && view.noCaptureLimit - view.noCaptureStreak <= 5 && !inChain;

  const offering = view.status === "active" && state.endOfferBy !== null;
  const offerMine = state.endOfferBy === match.you;
  const voted = offerMine || state.endVotes.includes(match.you);

  return (
    <div className="page match">
      <div className="scoreboard">
        <Clock state={state} />
        <div className="score-list">
          {state.players.map((player, seat) => {
            const classes = ["score"];
            if (view.current === seat && view.status === "active") classes.push("active");
            if (view.retired.includes(seat)) classes.push("retired");
            return (
              <div className={classes.join(" ")} key={player.id}>
                <span className="who">
                  {playerName(player)}
                  {seat === match.you ? " (คุณ)" : ""}
                  {state.autopilot.includes(seat) && !player.bot ? (
                    <span className="badge">AI</span>
                  ) : null}
                </span>
                <span className="points">{view.scores[seat]}</span>
              </div>
            );
          })}
        </div>
      </div>

      <p className={`status${yourTurn ? " mine" : ""}`}>{statusText(state, match)}</p>

      <Board view={view} yourTurn={yourTurn} />

      <div className="chain-slot">
        {inChain && selection ? (
          <div className="chain">
            {selection.availableCaptures !== null
              ? ui("chainProgressOf", {
                  captured: selection.capturesSoFar,
                  total: selection.availableCaptures,
                })
              : ui("chainProgress", { captured: selection.capturesSoFar })}
          </div>
        ) : nearEnd ? (
          <div className="chain">
            {ui("nearExhaustion", {
              streak: view.noCaptureStreak,
              limit: view.noCaptureLimit,
            })}
          </div>
        ) : null}
      </div>

      <div className="row">
        {yourTurn && view.canEndTurn ? (
          <button className="primary small" onClick={() => store.act("end_turn")}>
            {ui("endTurn")}
          </button>
        ) : null}
        {yourTurn && selection && selection.capturesSoFar === 0 && !view.rules.touchMove ? (
          <button className="ghost small" onClick={() => store.act("cancel_select")}>
            {ui("cancelSelect")}
          </button>
        ) : null}
        {!offering && view.status === "active" ? (
          <button className="ghost small" onClick={() => store.offerEnd()}>
            {ui("offerEnd")}
          </button>
        ) : null}
        <button className="danger small" onClick={() => store.resign()}>
          {ui("resign")}
        </button>
      </div>

      {offering ? (
        <div className="panel" style={{ maxWidth: 520, textAlign: "center" }}>
          <p style={{ margin: "0 0 10px" }}>
            {offerMine
              ? ui("youOfferedEnd", {
                  votes: `${state.endVotes.length}/${state.endVotesNeeded}`,
                })
              : ui("theyOfferedEnd", {
                  name: playerName(state.players[state.endOfferBy ?? 0]),
                  votes: `${state.endVotes.length}/${state.endVotesNeeded}`,
                })}
          </p>
          <div className="row">
            {offerMine ? (
              <button className="ghost small" onClick={() => store.respondEnd(false)}>
                {ui("withdraw")}
              </button>
            ) : voted ? null : (
              <>
                <button className="primary small" onClick={() => store.respondEnd(true)}>
                  {ui("accept")}
                </button>
                <button className="ghost small" onClick={() => store.respondEnd(false)}>
                  {ui("keepPlaying")}
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {!state.ranked ? <p className="empty">{ui("unranked")}</p> : null}
      {session ? null : null}
    </div>
  );
}
