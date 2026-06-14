import * as fs from "node:fs";
import * as path from "node:path";
import { JsonResult, JsonResultData } from "./common.js";
import { BenchmarkType } from "./benchmarksCommon.js";

/** Threshold for CPU benchmarks: regression if current mean is more than 10% slower */
const CPU_REGRESSION_THRESHOLD = 0.10;
/** Threshold for MEM benchmarks: regression if current mean is more than 5% larger */
const MEM_REGRESSION_THRESHOLD = 0.05;

export interface RegressionEntry {
  framework: string;
  benchmark: string;
  type: string;
  baselineMean: number;
  currentMean: number;
  changePercent: number;
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
  entries: RegressionEntry[];
  summary: {
    total: number;
    regressions: number;
    improvements: number;
    unchanged: number;
    skipped: number;
  };
}

/**
 * Read the ignoreRegression list from the root package.json.
 * The field is at: js-framework-benchmark.ignoreRegression (array of framework name strings).
 */
function loadIgnoreList(currentDirectory: string): string[] {
  // Walk up from results directory to find the root package.json
  // The results directory is typically inside webdriver-ts/, so the root is one level up.
  const candidatePaths = [
    path.resolve(currentDirectory, "..", "package.json"),          // results -> webdriver-ts -> root
    path.resolve(currentDirectory, "..", "..", "package.json"),     // if results is deeper
    path.resolve(currentDirectory, "package.json"),                 // if results is at root
  ];

  // Also try process.cwd() based paths
  candidatePaths.push(
    path.resolve(process.cwd(), "package.json"),
    path.resolve(process.cwd(), "..", "package.json"),
  );

  for (const pkgPath of candidatePaths) {
    try {
      if (fs.existsSync(pkgPath)) {
        const pkgContent = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkgContent.name === "js-framework-benchmark" && pkgContent["js-framework-benchmark"]) {
          const ignoreList = pkgContent["js-framework-benchmark"].ignoreRegression;
          if (Array.isArray(ignoreList)) {
            return ignoreList;
          }
        }
      }
    } catch {
      // ignore parse errors, try next path
    }
  }

  return [];
}

/**
 * Determine which sub-result key to use for mean comparison.
 * CPU benchmarks use "total" (total time), MEM benchmarks use "DEFAULT".
 */
function getMeanKey(type: string): string {
  if (type === "cpu") return "total";
  return "DEFAULT";
}

/**
 * Get the threshold for a given result type.
 */
function getThreshold(type: string): number {
  if (type === "cpu") return CPU_REGRESSION_THRESHOLD;
  if (type === "memory") return MEM_REGRESSION_THRESHOLD;
  // For other types (startup, size), use CPU threshold as default
  return CPU_REGRESSION_THRESHOLD;
}

/**
 * Determine if a change is a regression based on the result type and change percentage.
 * For CPU/memory, higher values are worse (positive changePercent = slower/more memory = regression).
 */
function isRegression(type: string, changePercent: number): boolean {
  const threshold = getThreshold(type);
  return changePercent > threshold;
}

/**
 * Load all JSON result files from a directory, indexed by filename.
 */
function loadResultFiles(directory: string): Map<string, JsonResult> {
  const results = new Map<string, JsonResult>();

  if (!fs.existsSync(directory)) {
    return results;
  }

  const files = fs.readdirSync(directory);
  for (const file of files) {
    if (!file.endsWith(".json") || file === "regression_report.json") continue;

    const filePath = path.join(directory, file);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content) as JsonResult;
      // Validate it looks like a benchmark result
      if (parsed.framework && parsed.benchmark && parsed.values) {
        results.set(file, parsed);
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  return results;
}

/**
 * Extract the mean value from a result's values map.
 */
function extractMean(result: JsonResult): number | undefined {
  const meanKey = getMeanKey(result.type);
  const valueData: JsonResultData | undefined = result.values[meanKey];
  if (valueData && typeof valueData.mean === "number") {
    return valueData.mean;
  }
  // Fallback: try DEFAULT if the type-specific key doesn't exist
  if (result.values["DEFAULT"] && typeof result.values["DEFAULT"].mean === "number") {
    return result.values["DEFAULT"].mean;
  }
  return undefined;
}

/**
 * Check if a framework name matches any pattern in the ignore list.
 * Supports exact match and simple wildcard patterns (e.g., "keyed/broken-*").
 */
function isFrameworkIgnored(frameworkName: string, ignoreList: string[]): boolean {
  for (const pattern of ignoreList) {
    if (pattern === frameworkName) return true;
    // Simple wildcard support: "prefix*" matches any framework starting with "prefix"
    if (pattern.endsWith("*") && frameworkName.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

export interface RegressionDetectionOptions {
  /** Directory containing the current (just-written) benchmark results */
  currentDirectory: string;
  /** Directory containing the baseline results to compare against */
  baselineDirectory: string;
}

/**
 * Run regression detection comparing current results against a baseline.
 * Returns the regression report and whether any regressions were found.
 */
export function detectRegressions(options: RegressionDetectionOptions): {
  report: RegressionReport;
  hasRegressions: boolean;
} {
  const { currentDirectory, baselineDirectory } = options;
  const ignoreList = loadIgnoreList(currentDirectory);

  const currentResults = loadResultFiles(currentDirectory);
  const baselineResults = loadResultFiles(baselineDirectory);

  const entries: RegressionEntry[] = [];
  let skipped = 0;

  for (const [filename, currentResult] of currentResults) {
    const framework = currentResult.framework;
    const benchmark = currentResult.benchmark;
    const type = currentResult.type;

    // Skip ignored frameworks
    if (isFrameworkIgnored(framework, ignoreList)) {
      skipped++;
      continue;
    }

    // Check if baseline exists for this file
    const baselineResult = baselineResults.get(filename);
    if (!baselineResult) {
      skipped++;
      continue;
    }

    const currentMean = extractMean(currentResult);
    const baselineMean = extractMean(baselineResult);

    if (currentMean === undefined || baselineMean === undefined || baselineMean === 0) {
      skipped++;
      continue;
    }

    const changePercent = (currentMean - baselineMean) / baselineMean;
    const regression = isRegression(type, changePercent);

    entries.push({
      framework,
      benchmark,
      type,
      baselineMean: Number(baselineMean.toFixed(4)),
      currentMean: Number(currentMean.toFixed(4)),
      changePercent: Number((changePercent * 100).toFixed(2)),
      isRegression: regression,
    });
  }

  const regressions = entries.filter((e) => e.isRegression).length;
  const improvements = entries.filter((e) => e.changePercent < -5).length;
  const unchanged = entries.length - regressions - improvements;

  const report: RegressionReport = {
    timestamp: new Date().toISOString(),
    baselineDirectory: baselineDirectory,
    currentDirectory: currentDirectory,
    thresholds: {
      cpu: CPU_REGRESSION_THRESHOLD,
      mem: MEM_REGRESSION_THRESHOLD,
    },
    ignoredFrameworks: ignoreList,
    entries,
    summary: {
      total: entries.length,
      regressions,
      improvements,
      unchanged,
      skipped,
    },
  };

  return {
    report,
    hasRegressions: regressions > 0,
  };
}

/**
 * Write the regression report to the results directory.
 */
export function writeRegressionReport(resultDir: string, report: RegressionReport): string {
  const reportPath = path.join(resultDir, "regression_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { encoding: "utf8" });
  return reportPath;
}

/**
 * Print a summary of the regression report to the console.
 */
export function printRegressionSummary(report: RegressionReport): void {
  console.log("");
  console.log("=====================================");
  console.log("  REGRESSION DETECTION REPORT");
  console.log("=====================================");
  console.log(`Baseline: ${report.baselineDirectory}`);
  console.log(`Current:  ${report.currentDirectory}`);
  console.log(`Thresholds: CPU >${(report.thresholds.cpu * 100).toFixed(0)}%, MEM >${(report.thresholds.mem * 100).toFixed(0)}%`);
  console.log("");

  if (report.ignoredFrameworks.length > 0) {
    console.log(`Ignored frameworks: ${report.ignoredFrameworks.join(", ")}`);
    console.log("");
  }

  console.log(`Summary: ${report.summary.total} compared, ${report.summary.regressions} regressions, ${report.summary.improvements} improvements, ${report.summary.skipped} skipped`);
  console.log("");

  const regressions = report.entries.filter((e) => e.isRegression);
  if (regressions.length > 0) {
    console.log("--- REGRESSIONS DETECTED ---");
    for (const entry of regressions) {
      console.log(
        `  [${entry.type}] ${entry.framework} / ${entry.benchmark}: ` +
        `${entry.baselineMean} → ${entry.currentMean} (+${entry.changePercent}%)`
      );
    }
    console.log("");
  } else {
    console.log("No regressions detected.");
    console.log("");
  }
}
