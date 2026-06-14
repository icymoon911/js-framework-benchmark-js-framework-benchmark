import { CPUBenchmarkInfo } from "./benchmarksCommon.js";
import { FrameworkData } from "./common.js";
import { CPUDurationResult } from "./cpuDuration.js";

function putIfAbsent<K, V>(map: Map<K, V>, key: K, default_value: V) {
  if (map.get(key) === undefined) {
    map.set(key, default_value);
  }
}

export class PlausibilityCheck {
  maxDeltaBetweenCommits = new Map<string, number>();
  raf_long_delays = new Map<string, number>();
  unnecessaryLayouts = new Set<string>();

  check(result: CPUDurationResult, trace: string, framework: FrameworkData, benchmarkInfo: CPUBenchmarkInfo) {
    if (!benchmarkInfo.layoutEventRequired && result.layouts > 0) {
      this.unnecessaryLayouts.add(framework.fullNameWithKeyedAndVersion);
    }

    putIfAbsent(this.maxDeltaBetweenCommits, framework.fullNameWithKeyedAndVersion, 0);
    let val = this.maxDeltaBetweenCommits.get(framework.fullNameWithKeyedAndVersion) ?? 0;
    this.maxDeltaBetweenCommits.set(framework.fullNameWithKeyedAndVersion, Math.max(val, result.maxDeltaBetweenCommits));

    putIfAbsent(this.raf_long_delays, framework.fullNameWithKeyedAndVersion, 0);
    val = this.raf_long_delays.get(framework.fullNameWithKeyedAndVersion) ?? 0;
    this.raf_long_delays.set(framework.fullNameWithKeyedAndVersion, Math.max(val, result.raf_long_delay));
  }

  print() {
    console.log("\n==== Results of PlausibilityCheck:");
    if (this.maxDeltaBetweenCommits.size > 0) {
      console.log("Info: The following implementation had a unnecessary layout event for select row:");
      for (let [impl, maxDelay] of this.maxDeltaBetweenCommits.entries()) {
        if (maxDelay > 0) console.log(` ${impl}: ${maxDelay}`);
      }
      console.log("  Interpretation: Just an information. Could be optimized, but not a bug in the implementation.");
    }
    if (this.raf_long_delays.size > 0) {
      console.log("Info: Some frameworks have a delay between raf and fire animation frame longer than 16 msecs. The correction was:");
      for (let [impl, maxDelay] of this.raf_long_delays.entries()) {
        if (maxDelay > 0) console.log(` ${impl}: ${maxDelay}`);
      }
      console.log("  Interpretation: If the list contains more than just a few entries or large numbers the results should be checked");
    }
  }
}
