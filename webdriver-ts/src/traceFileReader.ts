/**
 * Trace file reading module.
 *
 * Reads Chrome trace/performance log JSON files and extracts relevant events
 * using the unified event filter from traceEventFilter.ts.
 */

import { readFile } from "node:fs/promises";
import { Config } from "./common.js";
import { TimingResult, extractRelevantEvents, extractRelevantTraceEvents } from "./traceEventFilter.js";

/**
 * Read a performance log trace file and extract relevant events for CPU benchmark analysis.
 */
export async function fetchEventsFromPerformanceLog(
  fileName: string,
  startLogicEventName: string,
  cfg: Config
): Promise<TimingResult[]> {
  let contents = await readFile(fileName, { encoding: "utf8" });
  let json = JSON.parse(contents);
  let entries = json["traceEvents"];
  return extractRelevantEvents(entries, startLogicEventName, cfg.LOG_DETAILS, cfg.LOG_DEBUG);
}

/**
 * Read a trace log file and extract relevant events for JS/Paint duration analysis.
 */
export async function fetchEventsFromTraceLog(
  fileName: string,
  relevantTraceEvents: string[],
  includeClick: boolean,
  cfg: Config
): Promise<TimingResult[]> {
  let contents = await readFile(fileName, { encoding: "utf8" });
  let json = JSON.parse(contents);
  let entries = json["traceEvents"];
  return extractRelevantTraceEvents(entries, relevantTraceEvents, includeClick, cfg.LOG_DETAILS, cfg.LOG_DEBUG);
}
