/**
 * Timeline module - barrel re-export and high-level trace analysis.
 *
 * This module re-exports the split sub-modules and provides the
 * high-level `parseCPUTrace` orchestration function.
 */

import * as fs from "node:fs";
import { BenchmarkType, CPUBenchmarkInfo, CPUBenchmarkResult } from "./benchmarksCommon.js";
import { BenchmarkOptions, Config, FrameworkData } from "./common.js";
import { writeResults } from "./writeResults.js";

// Re-export from sub-modules
export { TimingResult, EventMatcher, filterTraceEvents, extractRelevantEvents, extractRelevantTraceEvents } from "./traceEventFilter.js";
export { fetchEventsFromPerformanceLog, fetchEventsFromTraceLog } from "./traceFileReader.js";
export { CPUDurationResult, computeResultsCPU, computeResultsFromTrace, computeResultsJS, computeResultsPaint } from "./cpuDuration.js";
export { PlausibilityCheck } from "./plausibilityCheck.js";

/**
 * Generate the file path for a trace file.
 */
export function fileNameTrace(
  framework: FrameworkData,
  benchmark: CPUBenchmarkInfo,
  run: number,
  benchmarkOptions: BenchmarkOptions
) {
  return `${benchmarkOptions.tracesDirectory}/${framework.fullNameWithKeyedAndVersion}_${benchmark.id}_${run}.json`;
}

/**
 * Parse all CPU trace files for a framework/benchmark combination,
 * compute results, and write them to the results directory.
 */
export async function parseCPUTrace(
  benchmarkOptions: BenchmarkOptions,
  framework: FrameworkData,
  benchmarkInfo: CPUBenchmarkInfo,
  plausibilityCheck: import("./plausibilityCheck.js").PlausibilityCheck,
  startLogicEventName: string,
  cfg: Config
) {
  // Import dynamically to avoid circular deps
  const { computeResultsCPU } = await import("./cpuDuration.js");
  const { computeResultsJS, computeResultsPaint } = await import("./cpuDuration.js");

  let results: CPUBenchmarkResult[] = [];
  for (let i = 0; i < benchmarkOptions.numIterationsForCPUBenchmarks + benchmarkInfo.additionalNumberOfRuns; i++) {
    let trace = `${fileNameTrace(framework, benchmarkInfo, i, benchmarkOptions)}`;
    if (fs.existsSync(trace)) {
      console.log("analyzing trace", trace);
      try {
        let result = await computeResultsCPU(trace, startLogicEventName, cfg);
        plausibilityCheck.check(result, trace, framework, benchmarkInfo);
        let resultJS = await computeResultsJS(result, cfg, trace);
        let resultPaint = await computeResultsPaint(result, cfg, trace);
        results.push({ total: result.duration, script: resultJS, paint: resultPaint });
      } catch (error) {
        console.log(error);
      }
    } else {
      throw new Error(`Trace file ${trace} does not exist`);
    }
  }

  await writeResults(benchmarkOptions.resultsDirectory, {
    framework: framework,
    benchmark: benchmarkInfo,
    results: results,
    type: BenchmarkType.CPU,
  });
}
