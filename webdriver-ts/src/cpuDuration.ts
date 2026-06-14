import * as R from "ramda";
import { Config, config as defaultConfig } from "./common.js";
import { readTraceFile } from "./traceFileReader.js";
import {
  TimingResult,
  filterTraceEvents,
  createPerformanceLogPredicate,
} from "./eventFilter.js";

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

export async function computeResultsCPU(
  fileName: string,
  startLogicEventName: string = "click",
  cfg: Readonly<Config> = defaultConfig
): Promise<CPUDurationResult> {
  const entries = await readTraceFile(fileName);
  const predicate = createPerformanceLogPredicate(startLogicEventName);
  const perfLogEvents = filterTraceEvents(entries, predicate, cfg);
  let events = R.sortBy((e: TimingResult) => e.end)(perfLogEvents);

  // Find mousedown event. This is the start of the benchmark
  let mousedowns = R.filter(type_eq("mousedown"))(events);
  // Invariant: There must be exactly one click event
  if (mousedowns.length === 0) {
    console.log("no mousedown event", fileName);
  } else if (mousedowns.length == 1) {
    console.log("one mousedown event", fileName);
  } else if (mousedowns.length > 1) {
    console.log("more than one mousedown event", fileName, events);
    throw "at most one mousedown event is expected";
  }

  // Find click event (the synthetic "startLogicEvent" event)
  let clicks = R.filter(type_eq("startLogicEvent"))(events);
  // Invariant: There must be exactly one click event
  if (clicks.length !== 1) {
    console.log("exactly one click event is expected", fileName, events);
    throw "exactly one click event is expected";
  }
  let click = clicks[0];

  // check if delay from mousedown to click is unusually long
  if (mousedowns.length > 0) {
    let mousedownToClick = click.ts - mousedowns[0].ts;
    if (mousedownToClick > 0) {
      console.log("mousedownToClick", mousedownToClick, fileName);
    }
    if (mousedownToClick > 5000) {
      console.log("difference between mousedown and click is unusually long", mousedownToClick, fileName);
    }
  }

  // The PID for the click event. We're dropping all events from other processes.
  let pid = click.pid;
  let eventsDuringBenchmark = R.filter((e: TimingResult) => e.ts > click.end || e.type === "click")(events);
  if (cfg.LOG_DETAILS) logEvents(eventsDuringBenchmark, click);

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
  // we're looking for the commit after this event
  let startFromEvent = startFrom.at(-1);
  if (startFromEvent === undefined) {
    throw "unexpected situation. There must be some events, but there were none.";
  }
  if (cfg.LOG_DETAILS) console.log("DEBUG: searching for commit event after", startFromEvent, "for", fileName);
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
  if (cfg.LOG_DEBUG) console.log("duration", duration);

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
