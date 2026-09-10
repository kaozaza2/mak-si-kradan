import type { MatchEnd, MatchStart } from "../api/types";
import { playerName, t } from "../i18n/messages";
import { ui } from "../i18n/ui";
import { store, useAppState } from "../state/store";

function title(result: MatchEnd, you: number): string {
  const winners = result.result.winners;
  if (winners.length === 0) return ui("gameOver");
  if (winners.includes(you)) return winners.length > 1 ? ui("youWinShared") : ui("youWin");
  if (winners.length > 1) {
    return ui("draw", {
      names: winners.map((seat) => playerName(result.players[seat])).join(" · "),
    });
  }
  return ui("winnerIs", { name: playerName(result.players[winners[0]]) });
}

export function ResultScreen({ result, match }: { result: MatchEnd; match: MatchStart }) {
  const { session, rematchRequested } = useAppState();
  const winners = result.result.winners;
  const waitingRematch = session ? rematchRequested.includes(session.id) : false;

  const rows: [string, (index: number) => string | number][] = [
    [ui("statScore"), (index) => result.stats.players[index].score],
    [ui("statCaptures"), (index) => result.stats.players[index].captures],
    [ui("statTurns"), (index) => result.stats.players[index].turns],
    [ui("statBestChain"), (index) => result.stats.players[index].bestChain],
    [ui("statMissed"), (index) => result.stats.players[index].missedCaptures],
  ];

  return (
    <div className="page">
      <div className="result">
        <h1>{title(result, match.you)}</h1>
        <p className="empty">{t(`end_${result.result.reason}`)}</p>

        <div className="final">
          {result.result.scores.map((score, seat) => (
            <div key={seat} className={winners.includes(seat) ? "win" : ""}>
              <b>{score}</b>
              {playerName(result.players[seat])}
            </div>
          ))}
        </div>

        <div className="table-scroll">
          <table className="stats">
            <tbody>
              <tr>
                <th />
                {result.players.map((player) => (
                  <th key={player.id}>{playerName(player)}</th>
                ))}
              </tr>
              {rows.map(([label, pick]) => (
                <tr key={label}>
                  <td>{label}</td>
                  {result.players.map((player, index) => (
                    <td key={player.id}>{pick(index)}</td>
                  ))}
                </tr>
              ))}
              <tr>
                <td>{ui("piecesLeft")}</td>
                <td colSpan={result.players.length}>{result.stats.piecesLeft}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="row">
          <button className="primary" onClick={() => store.rematch()}>
            {ui("playAgain")}
          </button>
          <button className="ghost" onClick={() => store.leaveMatch()}>
            {ui("backToLobby")}
          </button>
        </div>
        {waitingRematch ? <p className="empty">{ui("waitingRematch")}</p> : null}
      </div>
    </div>
  );
}
