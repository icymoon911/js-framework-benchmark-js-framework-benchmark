import * as fs from "node:fs";
import * as path from "node:path";
import { JsonResult, JsonResultData } from "./common.js";

/** Threshold for CPU benchmarks: regression if current mean is slower by more than this fraction */
const CPU_REGRESSION_THRESHOLD = 0.10;
/** Threshold for MEM benchmarks: regression if current mean is larger by more than this fraction */
const MEM_REGRESSION_THRESHOLD = 0.05;

export interface RegressionEntry {
  framework: string;
  benchmark: string;
  type: string;
  metric: string;
  baselineMean: number;
  currentMean: number;
  percentChange: number;
  isRegression: boolean;
}

export interface RegressionReport {
  timestamp: string;
  baselineDirectory: string;
  currentDirectory: string;
  thresholds: {
    cpu: number;
    mem: number;
  };
  ignoredFrameworks: string[];
  results: RegressionEntry[];
  summary: {
    totalComparisons: number;
    regressions: number;
    improvements: number;
    unchanged: number;
  };
}

/**
 * Read the ignore list from the root package.json under
 * the "js-framework-benchmark.ignoreRegression" field.
 * Returns an empty array if not found or unreadable.
 */
export function readIgnoreList(): string[] {
  // Walk up from the webdriver-ts directory to find the root package.json
  const candidates = [
    path.resolve(process.cwd(), "..", "package.json"),
    path.resolve(process.cwd(), "package.json"),
  ];

  for (const pkgPath of candidates) {
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const ignoreList = pkg?.["js-framework-benchmark"]?.ignoreRegression;
        if (Array.isArray(ignoreList)) {
          return ignoreList as string[];
        }
      }
    } catch {
      // ignore parse errors, try next candidate
    }
  }
  return [];
}

/**
 * Load all result JSON files from a directory into a Map.
 * Returns a map keyed by filename (e.g. "keyed_react_19.0.0_01_run1k.json").
 * Files that cannot be parsed are silently skipped.
 */
export function loadResultsFromDirectory(dir: string): Map<string, JsonResult> {
  const results = new Map<string, JsonResult>();

  if (!fs.existsSync(dir)) {
    return results;
  }

  const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf8");
      const parsed = JSON.parse(content) as JsonResult;
      // Basic validation: must have framework, benchmark, and values
      if (parsed && parsed.framework && parsed.benchmark && parsed.values) {
        results.set(file, parsed);
      }
    } catch {
      // skip files that can't be read or parsed
    }
  }

  return results;
}

/**
 * Determine which metric key to use for comparison based on benchmark type.
 * CPU benchmarks use "total", MEM benchmarks use "DEFAULT".
 * Returns undefined if the type is not comparable (e.g. "size", "startup").
 */
function getMetricKey(type: string): string | undefined {
  switch (type) {
    case "cpu":
      return "total";
    case "memory":
      return "DEFAULT";
    default:
      return undefined;
  }
}

/**
 * Compare two sets of results (baseline and current) and produce a regression report.
 *
 * @param baselineResults - Map of filename → JsonResult from the baseline run
 * @param currentResults - Map of filename → JsonResult from the current run
 * @param baselineLabel - Label for the baseline (directory path or description)
 * @param currentLabel - Label for the current results
 * @param ignoreFrameworks - List of framework names to skip
 * @returns A RegressionReport with all comparison details
 */
export function compareResults(
  baselineResults: Map<string, JsonResult>,
  currentResults: Map<string, JsonResult>,
  baselineLabel: string,
  currentLabel: string,
  ignoreFrameworks: string[] = []
): RegressionReport {
  const ignoreSet = new Set(ignoreFrameworks);
  const entries: RegressionEntry[] = [];

  for (const [filename, current] of currentResults) {
    const baseline = baselineResults.get(filename);
    if (!baseline) {
      // No baseline for this file — skip silently
      continue;
    }

    // Check if this framework should be ignored
    if (ignoreSet.has(current.framework)) {
      continue;
    }

    const metricKey = getMetricKey(current.type);
    if (!metricKey) {
      // Not a comparable type (size, startup, etc.)
      continue;
    }

    const currentData: JsonResultData | undefined = current.values[metricKey];
    const baselineData: JsonResultData | undefined = baseline.values[metricKey];

    if (!currentData || !baselineData) {
      continue;
    }

    const baselineMean = baselineData.mean;
    const currentMean = currentData.mean;

    if (baselineMean === 0) {
      // Avoid division by zero
      continue;
    }

    // For CPU: positive percentChange means slower (regression)
    // For MEM: positive percentChange means more memory (regression)
    const percentChange = (currentMean - baselineMean) / baselineMean;

    const threshold =
      current.type === "cpu" ? CPU_REGRESSION_THRESHOLD : MEM_REGRESSION_THRESHOLD;

    const isRegression = percentChange > threshold;

    entries.push({
      framework: current.framework,
      benchmark: current.benchmark,
      type: current.type,
      metric: metricKey,
      baselineMean,
      currentMean,
      percentChange: Math.round(percentChange * 10000) / 100, // two decimal places as percentage
      isRegression,
    });
  }

  const regressions = entries.filter((e) => e.isRegression).length;
  const improvements = entries.filter((e) => e.percentChange < 0).length;
  const unchanged = entries.length - regressions - improvements;

  const report: RegressionReport = {
    timestamp: new Date().toISOString(),
    baselineDirectory: baselineLabel,
    currentDirectory: currentLabel,
    thresholds: {
      cpu: CPU_REGRESSION_THRESHOLD,
      mem: MEM_REGRESSION_THRESHOLD,
    },
    ignoredFrameworks: ignoreFrameworks,
    results: entries,
    summary: {
      totalComparisons: entries.length,
      regressions,
      improvements,
      unchanged,
    },
  };

  return report;
}

/**
 * Detect regressions by comparing current results directory against a baseline directory.
 * This is a convenience wrapper around compareResults that loads both directories.
 *
 * @param currentDir - Directory containing the current run's result JSON files
 * @param baselineDir - Directory containing the baseline result JSON files
 * @param ignoreFrameworks - List of framework names to skip
 * @returns A RegressionReport with all comparison details
 */
export function detectRegressions(
  currentDir: string,
  baselineDir: string,
  ignoreFrameworks: string[] = []
): RegressionReport {
  const baselineResults = loadResultsFromDirectory(baselineDir);
  const currentResults = loadResultsFromDirectory(currentDir);
  return compareResults(baselineResults, currentResults, baselineDir, currentDir, ignoreFrameworks);
}

/**
 * Write the regression report to disk as JSON.
 */
export function writeRegressionReport(
  report: RegressionReport,
  outputDir: string
): string {
  const outputPath = path.join(outputDir, "regression_report.json");
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
  return outputPath;
}

/**
 * Print a human-readable summary of the regression report to the console.
 */
export function printRegressionSummary(report: RegressionReport): void {
  console.log("================================");
  console.log("  REGRESSION DETECTION REPORT");
  console.log("================================");
  console.log(`Baseline: ${report.baselineDirectory}`);
  console.log(`Current:  ${report.currentDirectory}`);
  console.log(
    `Thresholds: CPU > +${(report.thresholds.cpu * 100).toFixed(0)}%, MEM > +${(report.thresholds.mem * 100).toFixed(0)}%`
  );

  if (report.ignoredFrameworks.length > 0) {
    console.log(`Ignored frameworks: ${report.ignoredFrameworks.join(", ")}`);
  }

  console.log(
    `\nTotal comparisons: ${report.summary.totalComparisons} | ` +
      `Regressions: ${report.summary.regressions} | ` +
      `Improvements: ${report.summary.improvements} | ` +
      `Unchanged: ${report.summary.unchanged}`
  );

  const regressions = report.results.filter((r) => r.isRegression);
  if (regressions.length > 0) {
    console.log("\n⚠ REGRESSIONS DETECTED:");
    console.log("-".repeat(80));
    for (const r of regressions) {
      const sign = r.percentChange >= 0 ? "+" : "";
      console.log(
        `  ${r.framework} | ${r.benchmark} (${r.metric}): ` +
          `${r.baselineMean.toFixed(2)} → ${r.currentMean.toFixed(2)} (${sign}${r.percentChange}%)`
      );
    }
    console.log("-".repeat(80));
  } else if (report.summary.totalComparisons > 0) {
    console.log("\n✓ No regressions detected.");
  } else {
    console.log("\n(No comparable baseline results found — skipping regression check.)");
  }
  console.log("================================");
}
