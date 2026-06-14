/**
 * Unified trace event filtering module.
 *
 * Replaces the duplicated `extractRelevantEvents` and `extractRelevantTraceEvents`
 * functions from the old timeline.ts with a single generic filter function.
 */

import { Config } from "./common.js";

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
 * Predicate function for deciding whether a raw trace event should be included.
 * Returns a TimingResult if the event matches, or null to skip it.
 */
export type EventMatcher<T> = (rawEvent: any, context: T) => TimingResult | null;

/**
 * Generic event filter: walks an array of raw trace events and applies a matcher.
 * This unifies the old `extractRelevantEvents` and `extractRelevantTraceEvents`
 * functions into a single reusable function.
 *
 * @param entries - Raw trace events from a trace JSON file
 * @param matcher - Function that inspects each event and returns a TimingResult or null
 * @param context - Context object passed to the matcher (e.g. config, startLogicEvent name)
 * @param logDebug - Whether to log each raw event for debugging
 */
export function filterTraceEvents<T>(
  entries: any[],
  matcher: EventMatcher<T>,
  context: T,
  logDebug: boolean = false
): TimingResult[] {
  const filteredEvents: TimingResult[] = [];

  for (const e of entries) {
    if (logDebug) console.log(JSON.stringify(e));
    const result = matcher(e, context);
    if (result) {
      filteredEvents.push(result);
    }
  }

  return filteredEvents;
}

// ─── Performance Log Matcher (used for CPU benchmark traces) ────────────────

interface PerfLogContext {
  startLogicEvent: string;
  logDetails: boolean;
}

/**
 * Matcher for performance log events (the older format).
 * Identifies startLogicEvent, click, mousedown, pointerup, layout, functioncall, etc.
 */
const perfLogMatcher: EventMatcher<PerfLogContext> = (e, ctx) => {
  const { startLogicEvent, logDetails } = ctx;

  if (e.name === "EventDispatch") {
    const eventType = e.args?.data?.type;
    if (eventType === startLogicEvent) {
      if (logDetails) console.log("startLogicEvent", eventType, +e.ts);
      return {
        type: "startLogicEvent",
        ts: +e.ts,
        dur: +e.dur,
        end: +e.ts + e.dur,
        pid: e.pid,
        evt: JSON.stringify(e),
      };
    }
    if (eventType === "click") {
      return { type: "click", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
    } else if (eventType === "mousedown") {
      if (logDetails) console.log("MOUSEDOWN", +e.ts);
      return { type: "mousedown", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
    } else if (eventType === "pointerup") {
      if (logDetails) console.log("POINTERUP", +e.ts);
      return { type: "pointerup", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
    }
  } else if (e.ph === "X") {
    const typeMap: Record<string, string> = {
      Layout: "layout",
      FunctionCall: "functioncall",
      HitTest: "hittest",
      Commit: "commit",
      Paint: "paint",
      FireAnimationFrame: "fireAnimationFrame",
    };
    const mappedType = typeMap[e.name];
    if (mappedType) {
      if (logDetails) console.log(e.name, +e.ts);
      return { type: mappedType, ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, pid: e.pid, evt: JSON.stringify(e) };
    }
    if (e.name === "TimerFire") {
      if (logDetails) console.log("TimerFire", +e.ts);
      return { type: "timerFire", ts: +e.ts, dur: 0, end: +e.ts, pid: e.pid, evt: JSON.stringify(e) };
    }
  }
  if (e.name === "RequestAnimationFrame") {
    if (logDetails) console.log("RequestAnimationFrame", +e.ts);
    return { type: "requestAnimationFrame", ts: +e.ts, dur: 0, end: +e.ts, pid: e.pid, evt: JSON.stringify(e) };
  }
  return null;
};

/**
 * Extract relevant events from a performance log (older Chrome tracing format).
 * Used for CPU benchmark trace analysis.
 */
export function extractRelevantEvents(
  entries: any[],
  startLogicEvent: string,
  logDetails: boolean = false,
  logDebug: boolean = false
): TimingResult[] {
  return filterTraceEvents<PerfLogContext>(
    entries,
    perfLogMatcher,
    { startLogicEvent, logDetails },
    logDebug
  );
}

// ─── Trace Event Matcher (used for JS/Paint duration) ───────────────────────

interface TraceLogContext {
  relevantEventNames: string[];
  includeClick: boolean;
  logDetails: boolean;
}

/**
 * Matcher for trace log events (newer format).
 * Filters by a list of relevant event names plus optional click events.
 */
const traceLogMatcher: EventMatcher<TraceLogContext> = (e, ctx) => {
  const { relevantEventNames, includeClick, logDetails } = ctx;

  if (e.name === "EventDispatch") {
    if (e.args?.data?.type === "click" && includeClick) {
      if (logDetails) console.log("CLICK", +e.ts);
      return { type: "click", ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur };
    }
  } else if (relevantEventNames.includes(e.name) && e.ph === "X") {
    return { type: e.name, ts: +e.ts, dur: +e.dur, end: +e.ts + e.dur, orig: JSON.stringify(e) };
  }
  return null;
};

/**
 * Extract relevant events from a trace log (newer Chrome tracing format).
 * Used for JS/Paint duration computation.
 */
export function extractRelevantTraceEvents(
  entries: any[],
  relevantEventNames: string[],
  includeClick: boolean,
  logDetails: boolean = false,
  logDebug: boolean = false
): TimingResult[] {
  return filterTraceEvents<TraceLogContext>(
    entries,
    traceLogMatcher,
    { relevantEventNames, includeClick, logDetails },
    logDebug
  );
}
