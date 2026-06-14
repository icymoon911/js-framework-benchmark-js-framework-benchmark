import { Config } from "./common.js";

/**
 * A filtered timing result produced by event filtering.
 */
export interface TimingResult {
  type: string;
  ts: number;
  dur: number;
  end: number;
  pid?: number;
  evt?: string;
  orig?: string;
}

/**
 * Predicate for filtering trace events.
 * Receives a raw Chrome trace event and returns a TimingResult if the event
 * should be included, or `null` to skip it.
 */
export type EventPredicate = (e: any, cfg: Readonly<Config>) => TimingResult | null;

/**
 * Unified generic event filter: walks an array of raw trace events
 * and applies a predicate to produce filtered TimingResult entries.
 */
export function filterTraceEvents(
  entries: any[],
  predicate: EventPredicate,
  cfg: Readonly<Config>
): TimingResult[] {
  const results: TimingResult[] = [];
  for (const e of entries) {
    if (cfg.LOG_DEBUG) console.log(JSON.stringify(e));
    const result = predicate(e, cfg);
    if (result) {
      results.push(result);
    }
  }
  return results;
}

/**
 * Build a predicate for the performance-log (EventDispatch-based) extraction.
 * Tracks the startLogicEvent timestamps and filters relevant event types.
 *
 * This replaces the old `extractRelevantEvents` function.
 */
export function createPerformanceLogPredicate(startLogicEvent: string): EventPredicate & {
  getStartLogicEventStartTS: () => number;
  getStartLogicEventEndTS: () => number;
} {
  let startLogicEvent_startTS = 0;
  let startLogicEvent_endTS = 0;

  const fn = ((e: any, cfg: Readonly<Config>): TimingResult | null => {
    if (e.name === "EventDispatch") {
      if (e.args.data.type === startLogicEvent) {
        if (cfg.LOG_DETAILS) console.log("startLogicEvent", e.args.data.type, +e.ts);
        startLogicEvent_startTS = +e.ts;
        startLogicEvent_endTS = +e.ts + e.dur;
        return { type: "startLogicEvent", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
      }
      if (e.args.data.type === "click") {
        return { type: "click", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
      } else if (e.args.data.type === "mousedown") {
        if (cfg.LOG_DETAILS) console.log("MOUSEDOWN", +e.ts);
        return { type: "mousedown", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
      } else if (e.args.data.type === "pointerup") {
        if (cfg.LOG_DETAILS) console.log("POINTERUP", +e.ts);
        return { type: "pointerup", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
      }
    } else if (e.name === "Layout" && e.ph === "X") {
      if (cfg.LOG_DETAILS) console.log("Layout", +e.ts, +e.ts + e.dur - startLogicEvent_startTS);
      return { type: "layout", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
    } else if (e.name === "FunctionCall" && e.ph === "X") {
      if (cfg.LOG_DETAILS) console.log("FunctionCall", +e.ts, +e.ts + e.dur - startLogicEvent_startTS);
      return { type: "functioncall", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
    } else if (e.name === "HitTest" && e.ph === "X") {
      if (cfg.LOG_DETAILS) console.log("HitTest", +e.ts, +e.ts + e.dur - startLogicEvent_startTS);
      return { type: "hittest", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
    } else if (e.name === "Commit" && e.ph === "X") {
      if (cfg.LOG_DETAILS) console.log("COMMIT PAINT", +e.ts, +e.ts + e.dur - startLogicEvent_startTS);
      return { type: "commit", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
    } else if (e.name === "Paint" && e.ph === "X") {
      if (cfg.LOG_DETAILS) console.log("PAINT", +e.ts, +e.ts + e.dur - startLogicEvent_startTS);
      return { type: "paint", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
    } else if (e.name === "FireAnimationFrame" && e.ph === "X") {
      if (cfg.LOG_DETAILS) console.log("FireAnimationFrame", +e.ts, +e.ts - startLogicEvent_startTS);
      return { type: "fireAnimationFrame", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
    } else if (e.name === "TimerFire" && e.ph === "X") {
      if (cfg.LOG_DETAILS) console.log("TimerFire", +e.ts, +e.ts - startLogicEvent_startTS, +e.ts - startLogicEvent_endTS);
      return { type: "timerFire", ts: +e.ts, dur: 0, end: +e.ts, pid: e.pid, evt: JSON.stringify(e) };
    } else if (e.name === "RequestAnimationFrame") {
      if (cfg.LOG_DETAILS) console.log("RequestAnimationFrame", +e.ts, +e.ts - startLogicEvent_startTS, +e.ts - startLogicEvent_endTS);
      return { type: "requestAnimationFrame", ts: +e.ts, dur: 0, end: +e.ts, pid: e.pid, evt: JSON.stringify(e) };
    }
    return null;
  }) as EventPredicate & { getStartLogicEventStartTS: () => number; getStartLogicEventEndTS: () => number };

  fn.getStartLogicEventStartTS = () => startLogicEvent_startTS;
  fn.getStartLogicEventEndTS = () => startLogicEvent_endTS;
  return fn;
}

/**
 * Build a predicate for trace-log extraction (used by computeResultsFromTrace).
 * Filters EventDispatch(click) and any events whose name is in `relevantEventNames`.
 *
 * This replaces the old `extractRelevantTraceEvents` function.
 */
export function createTraceLogPredicate(relevantEventNames: string[], includeClick: boolean): EventPredicate {
  return (e: any, cfg: Readonly<Config>): TimingResult | null => {
    if (e.name === "EventDispatch") {
      if (e.args.data.type === "click" && includeClick) {
        if (cfg.LOG_DETAILS) console.log("CLICK", +e.ts);
        return { type: "click", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur };
      }
    } else if (relevantEventNames.includes(e.name) && e.ph === "X") {
      return { type: e.name, ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, orig: JSON.stringify(e) };
    }
    return null;
  };
}

// ---- Backward-compat wrappers (same signatures as the old functions) ----

/**
 * @deprecated Use `filterTraceEvents` with `createPerformanceLogPredicate` directly.
 */
export function extractRelevantEvents(entries: any[], startLogicEvent: string, cfg: Readonly<Config> = { LOG_DEBUG: false, LOG_DETAILS: false } as any): TimingResult[] {
  const predicate = createPerformanceLogPredicate(startLogicEvent);
  return filterTraceEvents(entries, predicate, cfg);
}

/**
 * @deprecated Use `filterTraceEvents` with `createTraceLogPredicate` directly.
 */
export function extractRelevantTraceEvents(cfg: Readonly<Config>, relevantEventNames: string[], entries: any[], includeClick: boolean): TimingResult[] {
  const predicate = createTraceLogPredicate(relevantEventNames, includeClick);
  return filterTraceEvents(entries, predicate, cfg);
}
