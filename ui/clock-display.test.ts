import { EMPTY_FACE, foldClockMessage, shownMs, type ClockFace } from "./clock-display";

/** The clock moves only when a tick arrives — no time input exists to move it otherwise. */
describe("the stopwatch face", () => {
  const run = { runId: "r1", status: "running" };
  const tick = (n: number, elapsedMs: number, runId = "r1") => ({ topic: "tick", data: { runId, elapsedMs, tick: n, serverNow: 0 } });

  it("shows 0 for a run no tick has reached yet — the hand has not moved", () => {
    expect(shownMs(EMPTY_FACE, { runId: "r1", status: "starting" }, 4000)).toBe(0);
  });
  it("moves to each tick's elapsed, and nowhere else between ticks", () => {
    let face: ClockFace = EMPTY_FACE;
    face = foldClockMessage(face, tick(1, 1000));
    expect(shownMs(face, run, undefined)).toBe(1000);
    // Any amount of wall time passes; nothing arrived; the face is unchanged.
    expect(shownMs(face, run, undefined)).toBe(1000);
    face = foldClockMessage(face, tick(2, 2010));
    expect(shownMs(face, run, undefined)).toBe(2010);
  });
  it("a late or duplicate tick never moves the hand backwards", () => {
    let face = foldClockMessage(EMPTY_FACE, tick(3, 3000));
    face = foldClockMessage(face, tick(2, 2000));
    expect(shownMs(face, run, undefined)).toBe(3000);
  });
  it("a tick for a run this tab knows has been superseded does not move the hand", () => {
    const face = foldClockMessage(EMPTY_FACE, tick(5, 5000, "other"));
    expect(shownMs(face, run, undefined)).toBe(0);
  });
  it("a VIEWER's hand moves on a tick for a run its fold has not learned yet — a run started by a tool or another device", () => {
    let face = foldClockMessage(EMPTY_FACE, tick(1, 1000, "started-by-a-tool"));
    expect(shownMs(face, null, 4000)).toBe(1000);
    face = foldClockMessage(face, tick(2, 2000, "started-by-a-tool"));
    expect(shownMs(face, null, 4000)).toBe(2000);
    // …and keeps the same number once the fold catches up with that run.
    expect(shownMs(face, { runId: "started-by-a-tool", status: "running" }, 4000)).toBe(2000);
    // The stop heard on the channel freezes it, before the fold's finished lands.
    face = foldClockMessage(face, { topic: "stopped", data: { runId: "started-by-a-tool", elapsedMs: 2400 } });
    expect(shownMs(face, null, 4000)).toBe(2400);
  });
  it("a stop freezes the face at the authority's final time; the fold's recorded time wins once it lands", () => {
    let face = foldClockMessage(EMPTY_FACE, tick(9, 9000));
    face = foldClockMessage(face, { topic: "stopped", data: { runId: "r1", elapsedMs: 9430, taskEndedAt: 1 } });
    expect(shownMs(face, null, undefined)).toBe(9430);
    expect(shownMs(face, { runId: "r1", status: "finished", elapsedMs: 9512 }, undefined)).toBe(9512);
  });
  it("a new run starts from 0, not from the previous run's time", () => {
    const face = foldClockMessage(EMPTY_FACE, { topic: "stopped", data: { runId: "r1", elapsedMs: 9430 } });
    expect(shownMs(face, { runId: "r2", status: "starting" }, 9430)).toBe(0);
  });
  it("with no run and nothing heard, shows the last finished run from the fold", () => {
    expect(shownMs(EMPTY_FACE, null, 7777)).toBe(7777);
    expect(shownMs(EMPTY_FACE, null, undefined)).toBe(0);
  });
  it("ignores malformed and unrelated messages", () => {
    const face = foldClockMessage(EMPTY_FACE, tick(1, 1000));
    expect(foldClockMessage(face, { topic: "tick", data: null })).toBe(face);
    expect(foldClockMessage(face, { topic: "idle", data: { runs: 1 } })).toBe(face);
    expect(foldClockMessage(face, { topic: "tick", data: { runId: "r1" } })).toBe(face);
  });
  it("reads no clock: the module imports nothing and never calls Date or requestAnimationFrame", () => {
    const src = require("node:fs").readFileSync(require.resolve("./clock-display.ts"), "utf8") as string;
    expect(src).not.toMatch(/Date\.now|performance\.now|requestAnimationFrame|setInterval|setTimeout/);
  });
});
