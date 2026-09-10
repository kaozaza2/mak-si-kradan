import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { MakSiKradanView, MatchStart, MatchState } from "../api/types";
import { setCatalog } from "../i18n/messages";
import { store } from "../state/store";
import { MatchScreen } from "./MatchScreen";

setCatalog({
  departed_player: "ผู้เล่นที่ออกไปแล้ว",
  ai_easy: "AI (ง่าย)",
});

function makeView(overrides: Partial<MakSiKradanView> = {}): MakSiKradanView {
  const board = Array.from({ length: 64 }, (_, square) =>
    [27, 28, 35, 36].includes(square) ? -1 : square,
  );
  return {
    board,
    playerCount: 2,
    scores: [0, 0],
    retired: [],
    current: 0,
    turn: 1,
    status: "active",
    selection: null,
    selectable: [9, 10],
    targets: [],
    targetKind: "none",
    canEndTurn: false,
    rules: { forceCapture: true, forceMaximum: true, assist: "full", touchMove: false },
    lastTurn: null,
    noCaptureStreak: 0,
    noCaptureLimit: 20,
    ...overrides,
  };
}

function makeState(view: MakSiKradanView, overrides: Partial<MatchState> = {}): MatchState {
  return {
    matchId: "m1",
    gameId: "mak-si-kradan",
    mode: "assisted",
    ranked: true,
    players: [
      { id: "a", name: "อลิซ", connected: true },
      { id: "b", name: "บ็อบ", connected: true },
    ],
    turnSeconds: 0,
    deadline: null,
    now: Date.now() / 1000,
    endOfferBy: null,
    endVotes: [],
    endVotesNeeded: 2,
    autopilot: [],
    view,
    ...overrides,
  };
}

const match: MatchStart = {
  matchId: "m1",
  gameId: "mak-si-kradan",
  you: 0,
  players: [
    { id: "a", name: "อลิซ", connected: true },
    { id: "b", name: "บ็อบ", connected: true },
  ],
  turnSeconds: 0,
  ranked: true,
};

describe("หน้ากระดาน", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("วาดกระดาน 64 ช่อง และหมาก 60 ตัว", () => {
    render(<MatchScreen match={match} state={makeState(makeView())} />);
    const cells = document.querySelectorAll(".cell");
    expect(cells).toHaveLength(64);
    expect(document.querySelectorAll(".piece")).toHaveLength(60);
    expect(document.querySelectorAll(".cell.center")).toHaveLength(4);
  });

  test("คลิกหมากแล้วส่งคำสั่งให้เซิร์ฟเวอร์ตัดสิน", async () => {
    const act = vi.spyOn(store, "act").mockImplementation(() => {});
    render(<MatchScreen match={match} state={makeState(makeView())} />);

    await userEvent.click(document.querySelector('[data-square="9"]')!);
    expect(act).toHaveBeenCalledWith("select", { square: 9 });
  });

  test("คลิกช่องที่เล่นไม่ได้ไม่ส่งอะไรออกไป", async () => {
    const act = vi.spyOn(store, "act").mockImplementation(() => {});
    render(<MatchScreen match={match} state={makeState(makeView())} />);

    await userEvent.click(document.querySelector('[data-square="27"]')!);
    expect(act).not.toHaveBeenCalled();
  });

  test("ตาคู่แข่งกดอะไรบนกระดานไม่ได้", async () => {
    const act = vi.spyOn(store, "act").mockImplementation(() => {});
    const state = makeState(makeView({ current: 1 }));
    render(<MatchScreen match={match} state={state} />);

    expect(document.querySelectorAll(".cell.selectable")).toHaveLength(0);
    await userEvent.click(document.querySelector('[data-square="9"]')!);
    expect(act).not.toHaveBeenCalled();
  });

  test("ไฮไลต์ช่องลงและคลิกแล้วส่งการวางหมาก", async () => {
    const act = vi.spyOn(store, "act").mockImplementation(() => {});
    const view = makeView({
      selection: {
        origin: 9,
        at: 9,
        pieceId: 9,
        kind: "capture",
        path: [9],
        capturedSquares: [],
        requiredCaptures: 1,
        capturesSoFar: 0,
        availableCaptures: 1,
      },
      targets: [27],
      targetKind: "capture",
    });
    render(<MatchScreen match={match} state={makeState(view)} />);

    expect(document.querySelectorAll(".cell.target.capture")).toHaveLength(1);
    await userEvent.click(document.querySelector('[data-square="27"]')!);
    expect(act).toHaveBeenCalledWith("play", { to: 27 });
  });

  test("โหมดที่ไม่ชี้เป้าไม่ไฮไลต์อะไรเลย แต่ยังวางหมากได้", async () => {
    const act = vi.spyOn(store, "act").mockImplementation(() => {});
    const view = makeView({
      selectable: [],
      targets: [],
      targetKind: "none",
      rules: { forceCapture: false, forceMaximum: false, assist: "none", touchMove: true },
      selection: {
        origin: 9,
        at: 9,
        pieceId: 9,
        kind: "capture",
        path: [9],
        capturedSquares: [],
        requiredCaptures: 0,
        capturesSoFar: 0,
        availableCaptures: null,
      },
    });
    render(<MatchScreen match={match} state={makeState(view)} />);

    expect(document.querySelectorAll(".cell.selectable")).toHaveLength(0);
    expect(document.querySelectorAll(".cell.target")).toHaveLength(0);
    await userEvent.click(document.querySelector('[data-square="27"]')!);
    expect(act).toHaveBeenCalledWith("play", { to: 27 });
  });

  test("ปุ่มจบเทิร์นโผล่เมื่อเซิร์ฟเวอร์บอกว่าหยุดได้", () => {
    const view = makeView({ canEndTurn: true });
    render(<MatchScreen match={match} state={makeState(view)} />);
    expect(screen.getByRole("button", { name: "จบเทิร์น" })).toBeInTheDocument();
  });

  test("ที่นั่งที่ AI คุมอยู่ถูกทำเครื่องหมายไว้", () => {
    const state = makeState(makeView(), { autopilot: [1] });
    render(<MatchScreen match={match} state={state} />);
    expect(document.querySelectorAll(".score .badge")).toHaveLength(1);
  });

  test("โหวตจบเกมแสดงจำนวนเสียงที่ได้แล้ว", () => {
    const state = makeState(makeView(), { endOfferBy: 1, endVotes: [1], endVotesNeeded: 2 });
    render(<MatchScreen match={match} state={state} />);
    expect(screen.getByText(/1\/2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ยอมรับ" })).toBeInTheDocument();
  });
});
