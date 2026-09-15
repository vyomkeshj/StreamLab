/**
 * Stopwatch fold contract: one run at a time, every event idempotent by runId,
 * either order of stop-requested / finished converges, latencies computed in the
 * fold from the stamps the task and the kicker wrote — and the task loop's shape.
 */
import {
  pluginSchema,
  startRequestedEvent,
  startedEvent,
  stopRequestedEvent,
  finishedEvent,
  uiLatencyEvent,
  abandonedEvent,
  sourceSetEvent,
  clearedEvent,
  stopwatchChannel,
  formatMs,
  describeStopwatch,
  MAX_RUNS,
  CHUNKS_PER_RUN,
  type StopwatchData,
} from "./app";

const IDENT = { workspaceId: "ws1", nodeId: "node1", applicationType: "plugin_stopwatch", instanceName: "Lap" };
const fresh = (): StopwatchData => pluginSchema.stateCreator(IDENT as any, {});
const apply = (def: any, state: StopwatchData, args: Record<string, any>) =>
  def.processor(state, def.dataCreator({ ...IDENT, ...args }) as any);

describe("stopwatch — a run", () => {
  it("starts empty", () => {
    expect(fresh()).toMatchObject({ current: null, runs: [] });
  });

  it("start requested → started → finished, with latencies from the stamps", () => {
    let s = apply(startRequestedEvent, fresh(), { runId: "r1", kickedAt: 1000 });
    expect(s.current).toMatchObject({ runId: "r1", status: "starting" });
    s = apply(startedEvent, s, { runId: "r1", startedAt: 1400 });
    expect(s.current).toMatchObject({ status: "running", startLatencyMs: 400 });
    s = apply(stopRequestedEvent, s, { runId: "r1", stopRequestedAt: 5000 });
    expect(s.current).toMatchObject({ status: "stopping", elapsedMs: 4000 }); // the user's interval, known at once
    s = apply(finishedEvent, s, { runId: "r1", elapsedMs: 3900, taskEndedAt: 5300 });
    expect(s.current).toBeNull();
    expect(s.runs[0]).toMatchObject({ runId: "r1", status: "finished", elapsedMs: 4000, taskElapsedMs: 3900, stopLatencyMs: 300 });
  });

  it("finished before stop-requested converges to the same run", () => {
    let s = apply(startRequestedEvent, fresh(), { runId: "r1", kickedAt: 1000 });
    s = apply(startedEvent, s, { runId: "r1", startedAt: 1400 });
    s = apply(finishedEvent, s, { runId: "r1", elapsedMs: 3900, taskEndedAt: 5300 });
    s = apply(stopRequestedEvent, s, { runId: "r1", stopRequestedAt: 5000 });
    expect(s.runs[0]).toMatchObject({ status: "finished", stopRequestedAt: 5000, stopLatencyMs: 300, elapsedMs: 4000, taskElapsedMs: 3900 });
  });

  it("a stop with no runId targets the current run", () => {
    let s = apply(startRequestedEvent, fresh(), { runId: "r1", kickedAt: 1 });
    s = apply(stopRequestedEvent, s, { runId: "", stopRequestedAt: 9 });
    expect(s.current).toMatchObject({ runId: "r1", status: "stopping", stopRequestedAt: 9 });
  });

  it("one run at a time: a second start request while one runs is ignored", () => {
    let s = apply(startRequestedEvent, fresh(), { runId: "r1", kickedAt: 1 });
    s = apply(startRequestedEvent, s, { runId: "r2", kickedAt: 2 });
    expect(s.current?.runId).toBe("r1");
  });

  it("every event is idempotent by runId", () => {
    let s = apply(startRequestedEvent, fresh(), { runId: "r1", kickedAt: 1000 });
    s = apply(startRequestedEvent, s, { runId: "r1", kickedAt: 1000 });
    s = apply(startedEvent, s, { runId: "r1", startedAt: 1400 });
    const afterStart = apply(startedEvent, s, { runId: "r1", startedAt: 9999 });
    expect(afterStart).toBe(s);
    s = apply(finishedEvent, s, { runId: "r1", elapsedMs: 10, taskEndedAt: 1410 });
    const again = apply(finishedEvent, s, { runId: "r1", elapsedMs: 10, taskEndedAt: 1410 });
    expect(again).toBe(s);
    expect(s.runs).toHaveLength(1);
  });

  it("a started/finished whose request never folded still becomes a run", () => {
    let s = apply(startedEvent, fresh(), { runId: "r9", startedAt: 100, kickedAt: 50 });
    expect(s.current).toMatchObject({ runId: "r9", status: "running", startLatencyMs: 50 });
    s = apply(finishedEvent, fresh(), { runId: "r8", elapsedMs: 700, taskEndedAt: 1000 });
    expect(s.runs[0]).toMatchObject({ runId: "r8", startedAt: 300, status: "finished" });
  });

  it("refuses malformed payloads", () => {
    const s0 = fresh();
    expect(startRequestedEvent.processor(s0, { eventData: { runId: "" } } as any)).toBe(s0);
    expect(startedEvent.processor(s0, { eventData: { runId: "r1" } } as any)).toBe(s0);
    expect(finishedEvent.processor(s0, { eventData: { runId: "r1", elapsedMs: "x" } } as any)).toBe(s0);
  });

  it("browser-measured latencies merge into the run they name", () => {
    let s = apply(startRequestedEvent, fresh(), { runId: "r1", kickedAt: 1 });
    s = apply(uiLatencyEvent, s, { runId: "r1", uiStartLatencyMs: 820 });
    expect(s.current?.uiStartLatencyMs).toBe(820);
    s = apply(finishedEvent, s, { runId: "r1", elapsedMs: 5, taskEndedAt: 6 });
    s = apply(uiLatencyEvent, s, { runId: "r1", uiStopLatencyMs: 410 });
    expect(s.runs[0]).toMatchObject({ uiStartLatencyMs: 820, uiStopLatencyMs: 410 });
    expect(apply(uiLatencyEvent, s, { runId: "nope", uiStopLatencyMs: 1 })).toBe(s);
  });

  it("an abandoned run is recorded as abandoned and can never become a time", () => {
    let s = apply(startRequestedEvent, fresh(), { runId: "r1", kickedAt: 1000 });
    s = apply(abandonedEvent, s, { runId: "r1", abandonedAt: 20000, reason: "the clock never answered" });
    expect(s.current).toBeNull();
    expect(s.runs[0]).toMatchObject({ runId: "r1", status: "abandoned", reason: "the clock never answered" });
    // A late task still reporting on it changes nothing.
    const late1 = apply(startedEvent, s, { runId: "r1", startedAt: 30000 });
    const late2 = apply(finishedEvent, late1, { runId: "r1", elapsedMs: 5, taskEndedAt: 30005 });
    expect(late2.runs[0].status).toBe("abandoned");
    expect(late2.runs).toHaveLength(1);
    expect(apply(abandonedEvent, s, { runId: "nope", abandonedAt: 1 })).toBe(s);
  });

  it("the clock source is chosen per instance and recorded per run", () => {
    let s = fresh();
    expect(s.clockSource).toBe("task");
    s = apply(sourceSetEvent, s, { source: "stream" });
    expect(s.clockSource).toBe("stream");
    expect(apply(sourceSetEvent, s, { source: "nope" })).toBe(s);
    s = apply(startRequestedEvent, s, { runId: "r1", kickedAt: 1 });
    expect(s.current?.source).toBe("stream"); // inherits the instance's choice
    s = apply(finishedEvent, s, { runId: "r1", elapsedMs: 5, taskEndedAt: 6 });
    expect(s.runs[0].source).toBe("stream");
    const t = apply(startRequestedEvent, s, { runId: "r2", kickedAt: 1, source: "task" });
    expect(t.current?.source).toBe("task"); // an explicit source on the request wins
  });

  it("finished carries the route's stamps through its dataCreator (emitPluginAppEvent mints via it)", () => {
    const env = finishedEvent.dataCreator({ ...IDENT, runId: "r1", elapsedMs: 5, taskEndedAt: 6, stopRequestedAt: 4, kickedAt: 1, readMs: 60, source: "stream" }) as any;
    expect(env.eventData).toMatchObject({ runId: "r1", readMs: 60, source: "stream", kickedAt: 1 });
    const s = finishedEvent.processor(fresh(), env);
    expect(s.runs[0]).toMatchObject({ readMs: 60, source: "stream", elapsedMs: 5 });
  });

  it("caps history and clear keeps the current run", () => {
    let s = fresh();
    for (let i = 0; i < MAX_RUNS + 5; i++) s = apply(finishedEvent, s, { runId: `r${i}`, elapsedMs: 1, taskEndedAt: i + 10 });
    expect(s.runs).toHaveLength(MAX_RUNS);
    s = apply(startRequestedEvent, s, { runId: "live", kickedAt: 1 });
    s = apply(clearedEvent, s, {});
    expect(s.runs).toEqual([]);
    expect(s.current?.runId).toBe("live");
  });

  it("mints runId and kickedAt in the dataCreator, never in the processor", () => {
    const env = startRequestedEvent.dataCreator({ ...IDENT }) as any;
    expect(typeof env.eventData.runId).toBe("string");
    expect(env.eventData.runId.length).toBeGreaterThan(8);
    expect(typeof env.eventData.kickedAt).toBe("number");
  });
});

describe("stopwatch — description, channel, tasks", () => {
  it("describes without ever inventing an emptiness", () => {
    expect(pluginSchema.getStateDescription({ instanceName: "Lap" } as any)).toMatch(/did not load|incomplete|missing/i);
    const s = apply(finishedEvent, fresh(), { runId: "r1", elapsedMs: 61230, taskEndedAt: 100000, stopRequestedAt: 99700 });
    expect(describeStopwatch(s)).toContain("elapsed 01:01.23");
    expect(describeStopwatch(s)).toContain("stop→task end 300 ms");
  });

  it("formats mm:ss.cc", () => {
    expect(formatMs(0)).toBe("00:00.00");
    expect(formatMs(61230)).toBe("01:01.23");
    expect(formatMs(-5)).toBe("00:00.00");
  });

  it("declares its channel with the two topics the task publishes on", () => {
    expect(stopwatchChannel.topicNames).toEqual(["tick", "stopped"]);
    expect(pluginSchema.channel).toBe(stopwatchChannel);
  });

  it("the tick task observes the fold: ticks while running, finishes on stopping, leaves when gone", async () => {
    const tasks = pluginSchema.tasks!;
    expect(tasks.map((t) => t.taskName)).toEqual(["tick"]);
    const tick = tasks[0];
    expect(tick.concurrency).toEqual({ limit: 1, scope: "per-app" });

    const make = (script: (reads: number) => StopwatchData) => {
      const dispatched: any[] = [];
      const notified: any[] = [];
      const sent: any[] = [];
      let reads = 0;
      const ctx = (eventData: Record<string, unknown>) => ({
        identifier: IDENT,
        eventData: { pollMs: 1, tickMs: 5, chunkMs: 40, ...eventData },
        logger: console,
        timing: { lastGetState: { importMs: 1, foldMs: 2, at: 3 } },
        step: {
          run: async (_id: string, fn: () => Promise<unknown>) => fn(),
          sendEvent: async (_id: string, evt: unknown) => sent.push(evt),
        },
        getState: async () => script(reads++),
        dispatchEvent: async (name: string, data: unknown) => dispatched.push({ name, data }),
        notify: async (topic: string, data: unknown) => notified.push({ topic, data }),
      });
      return { ctx, dispatched, notified, sent };
    };
    const running = (runId: string): StopwatchData => ({ ...fresh(), current: { runId, kickedAt: 1, startedAt: 2, status: "running", source: "task" } });

    // Running for a while, then the fold says stopping.
    const a = make((n) => (n < 12 ? running("r1") : { ...running("r1"), current: { ...running("r1").current!, status: "stopping", stopRequestedAt: 777 } }));
    await tick.handler(a.ctx({ runId: "r1", kickedAt: 5 }) as any);
    expect(a.dispatched[0].name).toBe("plugin_stopwatch_started"); // minted inside the first chunk, one hop from the kick
    const ticks = a.notified.filter((n) => n.topic === "tick");
    expect(ticks.length).toBeGreaterThan(0);
    expect(typeof ticks.at(-1).data.readMs).toBe("number"); // a tick carries what the last fold read cost; a fresh run ticks before its first read lands
    expect(a.notified.at(-1).topic).toBe("stopped");
    expect(a.dispatched.at(-1)).toMatchObject({ name: "plugin_stopwatch_finished", data: { runId: "r1", stopRequestedAt: 777 } });
    expect(a.sent).toHaveLength(0);

    // A continuation whose run the fold no longer holds (abandoned): leave without a finish,
    // and without a tick — a run nobody holds must not hear one.
    const b = make(() => fresh());
    await tick.handler(b.ctx({ runId: "r2", kickedAt: 5, startedAt: 1234 }) as any);
    expect(b.dispatched).toHaveLength(0);
    expect(b.notified).toHaveLength(0);

    // A fresh run ticks as soon as it has recorded `started` — before its first read lands.
    const d = make((n) => (n < 3 ? running("r4") : { ...running("r4"), current: { ...running("r4").current!, status: "stopping", stopRequestedAt: 9 } }));
    const dctx = d.ctx({ runId: "r4", kickedAt: 5 });
    const slowRead = dctx.getState; dctx.getState = () => new Promise((r) => setTimeout(() => r(slowRead()), 30));
    await tick.handler(dctx as any);
    const dticks = d.notified.filter((n) => n.topic === "tick");
    expect(dticks.length).toBeGreaterThanOrEqual(3);
    expect(dticks[0].data.readMs).toBeUndefined(); // ticked before any read landed
    expect(dticks[0].data.elapsedMs).toBe(0); // the very first tick precedes even the `started` record
    expect(d.notified[0].topic).toBe("tick"); // …and is the first thing the run says

    // Never stopped within the budget: hands itself on with the ORIGINAL clock.
    const c = make(() => running("r3"));
    await tick.handler(c.ctx({ runId: "r3", kickedAt: 5, startedAt: 1234, chunkMs: 2 }) as any);
    expect(c.dispatched.some((d) => d.name === "plugin_stopwatch_started")).toBe(false);
    expect(c.sent[0]).toMatchObject({ name: "plugin_stopwatch/tick", data: { runId: "r3", startedAt: 1234, chunkFrom: CHUNKS_PER_RUN } });
  });

  it("ticks keep the server clock's cadence while a fold read is slow — the read runs beside the ticks, not in front of them", async () => {
    const tick = pluginSchema.tasks![0];
    const notified: any[] = [];
    let reads = 0;
    const running: StopwatchData = { ...fresh(), current: { runId: "r9", kickedAt: 1, startedAt: 2, status: "running", source: "task" } };
    const ctx = {
      identifier: IDENT,
      eventData: { runId: "r9", kickedAt: 5, startedAt: 1234, pollMs: 1, tickMs: 5, chunkMs: 200 },
      logger: console,
      timing: {},
      step: { run: async (_id: string, fn: () => Promise<unknown>) => fn(), sendEvent: async () => {} },
      // Every read takes 60 ms — twelve tick boundaries. Chained, that is two ticks per chunk.
      getState: () => new Promise((r) => setTimeout(() => r(reads++ < 1 ? running : { ...running, current: { ...running.current!, status: "stopping", stopRequestedAt: 9 } }), 60)),
      dispatchEvent: async () => {},
      notify: async (topic: string, data: unknown) => notified.push({ topic, data }),
    };
    await tick.handler(ctx as any);
    const ticks = notified.filter((n) => n.topic === "tick");
    expect(ticks.length).toBeGreaterThanOrEqual(8); // ~12 boundaries between the first read landing (60 ms) and the second (120 ms); a chained loop manages one
    expect(notified.at(-1).topic).toBe("stopped");
    expect(reads).toBeGreaterThanOrEqual(2);
    // The elapsed on each tick grows with the server clock, never with the read count.
    const el = ticks.map((t) => t.data.elapsedMs as number);
    expect(el.every((v, i) => i === 0 || v >= el[i - 1])).toBe(true);
  });

  it("every task description fits Inngest's function-name column — a longer one fails the whole app sync silently (2026-09-10)", () => {
    for (const t of pluginSchema.tasks!) expect((t.description ?? "").length).toBeLessThanOrEqual(255);
  });

  it("stop is an event on the timeline, not a kick", () => {
    const captured: any[] = [];
    const tools = pluginSchema.toolkitCreator(IDENT as any, "chat", (e) => captured.push(e), () => {}) as Record<string, any>;
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("no network in this test"); };
    try {
      return tools.stop_stopwatch_Lap.execute({}).then((r: string) => {
        expect(r).toMatch(/Stop recorded/);
        expect(captured[0].eventName).toBe("plugin_stopwatch_stop_requested");
      });
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it("every tool has onClient = execute (voice surfaces run the same work)", () => {
    const tools = pluginSchema.toolkitCreator(IDENT as any, "chat", () => {}, () => {}) as Record<string, any>;
    expect(Object.keys(tools).sort()).toEqual(["abandon_stopwatch_run_Lap", "clear_stopwatch_history_Lap", "read_stopwatch_Lap", "set_clock_source_Lap", "start_stopwatch_Lap", "stop_stopwatch_Lap"]);
    for (const t of Object.values(tools)) expect(t.onClient).toBe(t.execute);
  });

  it("start records the run only after the kick was accepted", async () => {
    const captured: any[] = [];
    const tools = pluginSchema.toolkitCreator(IDENT as any, "chat", (e) => captured.push(e), () => {}) as Record<string, any>;
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: false, status: 403 });
    try {
      const refused = await tools.start_stopwatch_Lap.execute({});
      expect(refused).toMatch(/Not started/);
      expect(captured).toHaveLength(0);
      (globalThis as any).fetch = async () => ({ ok: true, status: 200 });
      const started = await tools.start_stopwatch_Lap.execute({});
      expect(started).toMatch(/Started run/);
      expect(captured).toHaveLength(1);
      expect(captured[0].eventName).toBe("plugin_stopwatch_start_requested");
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});
