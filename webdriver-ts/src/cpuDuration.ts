/**
 * CPU duration computation module.
 *
 * Analyzes trace events to determine CPU benchmark durations,
 * including JS execution time and paint time breakdowns.
 */

import * as R from "ramda";
import { Config } from "./common.js";
import { CPUBenchmarkResult } from "./benchmarksCommon.js";
import { TimingResult } from "./traceEventFilter.js";
import { fetchEventsFromPerformanceLog, fetchEventsFromTraceLog } from "./traceFileReader.js";
import { newContainedInterval, Interval } from "./interval.js";

export interface CPUDurationResult {
  tsStart: number;
  tsEnd: number;
  duration: number;
  droppedNonMainProcessCommitEvents: boolean;
  droppedNonMainProcessOtherEvents: boolean;
  maxDeltaBetweenCommits: number;
  numberCommits: number;
  layouts: number;
  raf_long_delay: number;
}

function type_eq(...requiredTypes: string[]) {
  return (e: TimingResult) => requiredTypes.includes(e.type);
}

function logEvents(events: TimingResult[], click: TimingResult) {
  events.forEach((e) => {
    console.log("event", e.type, `${e.ts - click.ts} - ${e.end - click.ts}`, e.evt);
  });
}

/**
 * Compute CPU duration from a performance trace file.
 * Finds the click event, filters to main process events,
 * and determines the duration from click to the final commit.
 */
export async function computeResultsCPU(
  fileName: string,
  startLogicEventName: string = "click",
  cfg?: Config
): Promise<CPUDurationResult> {
  // Use a default config if none provided (backward compat)
  const config = cfg ?? { LOG_DEBUG: false, LOG_DETAILS: false } as Config;
  const perfLogEvents = await fetchEventsFromPerformanceLog(fileName, startLogicEventName, config);
  let events = R.sortBy((e: TimingResult) => e.end)(perfLogEvents);

  // Find mousedown event. This is the start of the benchmark
  let mousedowns = R.filter(type_eq("mousedown"))(events);
  if (mousedowns.length === 0) {
    console.log("no mousedown event", fileName);
  } else if (mousedowns.length == 1) {
    console.log("one mousedown event", fileName);
  } else if (mousedowns.length > 1) {
    console.log("more than one mousedown event", fileName, events);
    throw "at most one mousedown event is expected";
  }

  // Find click event (the synthetic startLogicEvent)
  let clicks = R.filter(type_eq("startLogicEvent"))(events);
  if (clicks.length !== 1) {
    console.log("exactly one click event is expected", fileName, events);
    throw "exactly one click event is expected";
  }
  let click = clicks[0];

  // Check if delay from mousedown to click is unusually long
  if (mousedowns.length > 0) {
    let mousedownToClick = click.ts - mousedowns[0].ts;
    if (mousedownToClick > 0) {
      console.log("mousedownToClick", mousedownToClick, fileName);
    }
    if (mousedownToClick > 5000) {
      console.log("difference between mousedown and click is unusually long", mousedownToClick, fileName);
    }
  }

  // The PID for the click event. Drop all events from other processes.
  let pid = click.pid;
  let eventsDuringBenchmark = R.filter((e: TimingResult) => e.ts > click.end || e.type === "click")(events);
  if (config.LOG_DETAILS) logEvents(eventsDuringBenchmark, click);

  let droppedNonMainProcessCommitEvents = false;
  let droppedNonMainProcessOtherEvents = false;

  let eventsOnMainThreadDuringBenchmark = R.filter((e: TimingResult) => e.pid === pid)(eventsDuringBenchmark);
  if (eventsOnMainThreadDuringBenchmark.length !== eventsDuringBenchmark.length) {
    let droppedEvents = R.filter((e: TimingResult) => e.pid !== pid)(events);
    if (R.any((e: TimingResult) => e.type === "commit")(droppedEvents)) {
      console.log("INFO: Dropping commit events from other processes", fileName);
      logEvents(droppedEvents, click);
      droppedNonMainProcessCommitEvents = true;
    }
    if (R.any((e: TimingResult) => e.type !== "commit")(droppedEvents)) {
      console.log("INFO: Dropping non-commit events from other processes", fileName);
      logEvents(droppedEvents, click);
      droppedNonMainProcessOtherEvents = true;
    }
  }

  let startFrom = R.filter(type_eq(startLogicEventName, "fireAnimationFrame", "timerFire", "layout", "functioncall"))(eventsOnMainThreadDuringBenchmark);
  let startFromEvent = startFrom.at(-1);
  if (startFromEvent === undefined) {
    throw "unexpected situation. There must be some events, but there were none.";
  }
  if (config.LOG_DETAILS) console.log("DEBUG: searching for commit event after", startFromEvent, "for", fileName);
  let commit = R.find((e: TimingResult) => e.ts > startFromEvent.end)(R.filter(type_eq("commit"))(eventsOnMainThreadDuringBenchmark));
  let allCommitsAfterClick = R.filter(type_eq("commit"))(eventsOnMainThreadDuringBenchmark);

  let numberCommits = allCommitsAfterClick.length;
  if (!commit) {
    console.log("INFO: No commit event found according to filter", fileName);
    if (allCommitsAfterClick.length === 0) {
      console.log("ERROR: No commit event found for", fileName);
      throw "No commit event found for " + fileName;
    } else {
      commit = allCommitsAfterClick.at(-1);
    }
  }
  let lastCommit = allCommitsAfterClick.at(-1);
  if (lastCommit === undefined || commit === undefined) {
    throw "unexpected situation. allCommitsAfterClick and commit must not be empty";
  }
  let maxDeltaBetweenCommits = (lastCommit.ts - allCommitsAfterClick[0].ts) / 1000.0;

  let duration = (commit.end - clicks[0].ts) / 1000.0;
  if (config.LOG_DEBUG) console.log("duration", duration);

  let layouts = R.filter(type_eq("layout"))(eventsOnMainThreadDuringBenchmark);

  // Adjust bogus delay for requestAnimationFrame
  let rafs_withinClick = R.filter((e: TimingResult) => e.ts >= click.ts && e.ts <= click.end)(
    R.filter(type_eq("requestAnimationFrame"))(events)
  );
  let fafs = R.filter((e: TimingResult) => e.ts >= click.ts && e.ts < commit.ts)(
    R.filter(type_eq("fireAnimationFrame"))(events)
  );

  let raf_long_delay = 0;
  if (rafs_withinClick.length > 0 && fafs.length > 0) {
    let waitDelay = (fafs[0].ts - click.end) / 1000.0;
    if (rafs_withinClick.length == 1 && fafs.length == 1) {
      if (waitDelay > 16) {
        let ignored = false;
        for (let e of layouts) {
          if (e.ts < fafs[0].ts) {
            console.log("IGNORING 1 raf, 1 faf, but layout before raf", waitDelay, fileName);
            ignored = true;
            break;
          }
        }
        if (!ignored) {
          raf_long_delay = waitDelay - 16;
          duration = duration - raf_long_delay;
          console.log("FOUND delay for 1 raf, 1 faf, but layout before raf", waitDelay, fileName);
        }
      } else {
        console.log("IGNORING delay < 16 msecs 1 raf, 1 faf", waitDelay, fileName);
      }
    } else if (fafs.length == 1) {
      throw (
        "Unexpected situation. Did not happen in the past. One fire animation frame, but non consistent request animation frames in " +
        fileName
      );
    } else {
      console.log(
        `IGNORING Bad case ${rafs_withinClick.length} raf, ${fafs.length} faf ${fileName}`
      );
    }
  }

  return {
    tsStart: click.ts,
    tsEnd: commit.end,
    duration,
    layouts: layouts.length,
    raf_long_delay,
    droppedNonMainProcessCommitEvents,
    droppedNonMainProcessOtherEvents,
    maxDeltaBetweenCommits,
    numberCommits,
  };
}

// ─── JS and Paint duration from trace ────────────────────────────────────────

const traceJSEventNames = [
  "EventDispatch",
  "EvaluateScript",
  "v8.evaluateModule",
  "FunctionCall",
  "TimerFire",
  "FireIdleCallback",
  "FireAnimationFrame",
  "RunMicrotasks",
  "V8.Execute",
];

const tracePaintEventNames = [
  "UpdateLayoutTree",
  "Layout",
  "Commit",
  "Paint",
  "Layerize",
  "PrePaint",
];

/**
 * Compute JS execution or paint duration from a trace file
 * within the time window determined by the CPU trace result.
 */
export async function computeResultsFromTrace(
  cpuTrace: CPUDurationResult,
  cfg: Config,
  fileName: string,
  relevantTraceEvents: string[],
  includeClick: boolean
): Promise<number> {
  const totalDuration = cpuTrace;

  const perfLogEvents = await fetchEventsFromTraceLog(fileName, relevantTraceEvents, includeClick, cfg);

  const eventsWithin = R.filter<TimingResult>(
    (e) => e.ts >= totalDuration.tsStart && e.ts <= totalDuration.tsEnd
  )(perfLogEvents);

  for (let ev of eventsWithin) {
    ev.ts -= totalDuration.tsStart;
    ev.end -= totalDuration.tsStart;
  }

  let intervals: Array<Interval<TimingResult>> = [];
  for (let ev of eventsWithin) {
    const outerIv: Interval<TimingResult> = { start: ev.ts, end: ev.end, timingResult: ev };
    intervals = newContainedInterval(outerIv, intervals);
  }
  if (cfg.LOG_DETAILS) {
    if (intervals.length > 1) {
      console.log(`*** More than 1 interval ${intervals.length} for ${fileName}`, intervals);
    } else {
      console.log(`1 interval for ${fileName}`, intervals);
    }
  }
  let res = intervals.reduce((p, c) => p + (c.end - c.start), 0) / 1000.0;
  return res;
}

/**
 * Compute JS execution duration within the CPU benchmark time window.
 */
export function computeResultsJS(
  cpuTrace: CPUDurationResult,
  cfg: Config,
  fileName: string
): Promise<number> {
  return computeResultsFromTrace(cpuTrace, cfg, fileName, traceJSEventNames, true);
}

/**
 * Compute paint duration within the CPU benchmark time window.
 */
export function computeResultsPaint(
  cpuTrace: CPUDurationResult,
  cfg: Config,
  fileName: string
): Promise<number> {
  return computeResultsFromTrace(cpuTrace, cfg, fileName, tracePaintEventNames, false);
}
