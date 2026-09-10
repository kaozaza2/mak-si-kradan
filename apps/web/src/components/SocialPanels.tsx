import { useState } from "react";
import { ui } from "../i18n/ui";
import { store, useAppState } from "../state/store";

/** อันดับผู้เล่น */
export function Leaderboard() {
  const { accountsEnabled, leaderboard, account } = useAppState();
  if (!accountsEnabled) return null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="section-title">{ui("leaderboard")}</h2>
        <button className="ghost small" onClick={() => void store.refreshLeaderboard()}>
          {ui("refresh")}
        </button>
      </div>
      {leaderboard.length === 0 ? (
        <p className="empty">{ui("noRanked")}</p>
      ) : (
        <ol className="ranks">
          {leaderboard.map((row) => (
            <li key={row.id} className={account?.id === row.id ? "me" : ""}>
              <span className="rank">#{row.rank}</span>
              <span>
                {row.name}
                <span className="meta">
                  {" "}
                  {row.wins}-{row.losses}-{row.draws}
                </span>
              </span>
              <span className="points">{row.rating}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="empty">{ui("rankedNote")}</p>
    </section>
  );
}

/** รายชื่อเพื่อน คำขอ และปุ่มชวนเล่น */
export function FriendsPanel() {
  const { accountsEnabled, account, friends, room } = useAppState();
  const [identifier, setIdentifier] = useState("");
  if (!accountsEnabled || !account) return null;

  const empty =
    friends.friends.length === 0 && friends.incoming.length === 0 && friends.outgoing.length === 0;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="section-title">{ui("friends")}</h2>
        <button className="ghost small" onClick={() => void store.refreshFriends()}>
          {ui("refresh")}
        </button>
      </div>

      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (identifier.trim()) void store.requestFriend(identifier.trim());
          setIdentifier("");
        }}
      >
        <input
          aria-label={ui("addFriend")}
          placeholder={ui("friendIdentifier")}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
        />
        <button type="submit" className="small">
          {ui("add")}
        </button>
      </form>

      {friends.incoming.map((request) => (
        <div className="friend-row" key={request.requestId}>
          <span>
            <span className="request-label">{ui("friendRequest")}</span>
            <br />
            {request.player.name}
          </span>
          <span className="row">
            <button
              className="primary small"
              onClick={() => void store.respondFriend(request.requestId, true)}
            >
              {ui("accept")}
            </button>
            <button
              className="ghost small"
              onClick={() => void store.respondFriend(request.requestId, false)}
            >
              {ui("decline")}
            </button>
          </span>
        </div>
      ))}

      {friends.outgoing.map((request) => (
        <div className="friend-row" key={request.requestId}>
          <span>{request.player.name}</span>
          <span className="meta">{ui("awaitingReply")}</span>
        </div>
      ))}

      {empty ? <p className="empty">{ui("noFriends")}</p> : null}

      {friends.friends.map((friend) => (
        <div className="friend-row" key={friend.id}>
          <span className="friend">
            <span className={`dot${friend.online ? " online" : ""}`} />
            <span>
              {friend.name} <span className="meta">{friend.rating}</span>
            </span>
          </span>
          <span className="row">
            {room ? (
              <button
                className="primary small"
                onClick={() => store.inviteToRoom(friend.id)}
                disabled={!friend.online}
              >
                {ui("inviteToRoom")}
              </button>
            ) : null}
            <button className="ghost small" onClick={() => void store.removeFriend(friend.id)}>
              {ui("remove")}
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}
