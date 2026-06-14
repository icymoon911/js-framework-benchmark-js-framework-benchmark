/**
 * timeline.ts — Re-export hub for trace analysis.
 *
 * The original monolithic file has been split into:
 *  - traceFileReader.ts  — read trace JSON files
 *  - eventFilter.ts      — unified event filtering
 *  - cpuDuration.ts      — computeResultsCPU / CPUDurationResult
 *  - traceDuration.ts    — computeResultsJS / computeResultsPaint / computeResultsFromTrace
 *  - plausibilityCheck.ts — PlausibilityCheck class
 *
 * This file re-exports everything for backward compatibility.
 * It also retains the `parseCPUTrace` and `fileNameTrace` helpers
 * that orchestrate trace analysis for CPU benchmarks.
 */

import * as fs from "node:fs";
import { BenchmarkType, CPUBenchmarkInfo, CPUBenchmarkResult } from "./benchmarksCommon.js";
import { BenchmarkOptions, Config, FrameworkData } from "./common.js";
import { writeResults } from "./writeResults.js";

// Re-exports
export { CPUDurationResult, computeResultsCPU } from "./cpuDuration.js";
export { computeResultsJS, computeResultsPaint, computeResultsFromTrace } from "./traceDuration.js";
export { PlausibilityCheck } from "./plausibilityCheck.js";
export { TimingResult, extractRelevantEvents, extractRelevantTraceEvents } from "./eventFilter.js";
export { readTraceFile } from "./traceFileReader.js";

// --- Helpers kept here because they tie multiple modules together ---

export async function parseCPUTrace(
  benchmarkOptions: BenchmarkOptions,
  framework: FrameworkData,
  benchmarkInfo: CPUBenchmarkInfo,
  plausibilityCheck: import("./plausibilityCheck.js").PlausibilityCheck,
  startLogicEventName: string,
  cfg: Readonly<Config>
) {
  const { computeResultsCPU } = await import("./cpuDuration.js");
  const { computeResultsJS, computeResultsPaint } = await import("./traceDuration.js");

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

export function fileNameTrace(
  framework: FrameworkData,
  benchmark: CPUBenchmarkInfo,
  run: number,
  benchmarkOptions: BenchmarkOptions
) {
  return `${benchmarkOptions.tracesDirectory}/${framework.fullNameWithKeyedAndVersion}_${benchmark.id}_${run}.json`;
}
