import * as R from "ramda";
import { Config, config as defaultConfig } from "./common.js";
import { readTraceFile } from "./traceFileReader.js";
import { TimingResult, filterTraceEvents, createTraceLogPredicate } from "./eventFilter.js";
import { CPUDurationResult } from "./cpuDuration.js";
import { Interval, isContained, newContainedInterval } from "./interval.js";

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
  "PrePaint"
  // including "PrePaint" causes longer durations as reported by chrome
];

export async function computeResultsFromTrace(
  cpuTrace: CPUDurationResult,
  cfg: Readonly<Config>,
  fileName: string,
  relevantTraceEvents: string[],
  includeClick: boolean
): Promise<number> {
  const totalDuration = cpuTrace;
  const entries = await readTraceFile(fileName);
  const predicate = createTraceLogPredicate(relevantTraceEvents, includeClick);
  const perfLogEvents = filterTraceEvents(entries, predicate, cfg);

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

export function computeResultsJS(
  cpuTrace: CPUDurationResult,
  cfg: Readonly<Config>,
  fileName: string
): Promise<number> {
  return computeResultsFromTrace(cpuTrace, cfg, fileName, traceJSEventNames, true);
}

export function computeResultsPaint(
  cpuTrace: CPUDurationResult,
  cfg: Readonly<Config>,
  fileName: string
): Promise<number> {
  return computeResultsFromTrace(cpuTrace, cfg, fileName, tracePaintEventNames, false);
}
