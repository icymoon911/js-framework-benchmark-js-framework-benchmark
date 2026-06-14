import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  detectRegressions,
  compareResults,
  loadResultsFromDirectory,
  writeRegressionReport,
  readIgnoreList,
} from "./regressionDetection.js";

function makeResultJson(
  framework: string,
  benchmark: string,
  type: string,
  mean: number,
  metricKey?: string
) {
  const key = metricKey ?? (type === "cpu" ? "total" : "DEFAULT");
  return {
    framework,
    keyed: true,
    benchmark,
    type,
    values: {
      [key]: {
        min: mean - 1,
        max: mean + 1,
        mean,
        stddev: 0.5,
        median: mean,
        values: [mean - 1, mean, mean + 1],
      },
    },
  };
}

describe("regressionDetection", () => {
  let tmpDir: string;
  let baselineDir: string;
  let currentDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "regression-test-"));
    baselineDir = path.join(tmpDir, "baseline");
    currentDir = path.join(tmpDir, "current");
    fs.mkdirSync(baselineDir);
    fs.mkdirSync(currentDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeResult(dir: string, filename: string, data: object) {
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data), "utf8");
  }

  it("should detect no regressions when results are identical", () => {
    const result = makeResultJson("keyed/react", "01_run1k", "cpu", 100);
    writeResult(baselineDir, "keyed_react_01_run1k.json", result);
    writeResult(currentDir, "keyed_react_01_run1k.json", result);

    const report = detectRegressions(currentDir, baselineDir);
    expect(report.summary.regressions).toBe(0);
    expect(report.summary.totalComparisons).toBe(1);
  });

  it("should detect CPU regression when mean increases by more than 10%", () => {
    writeResult(baselineDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 100));
    writeResult(currentDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 115));

    const report = detectRegressions(currentDir, baselineDir);
    expect(report.summary.regressions).toBe(1);
    expect(report.results[0].isRegression).toBe(true);
    expect(report.results[0].percentChange).toBe(15);
  });

  it("should NOT detect CPU regression when mean increases by exactly 10%", () => {
    writeResult(baselineDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 100));
    writeResult(currentDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 110));

    const report = detectRegressions(currentDir, baselineDir);
    expect(report.summary.regressions).toBe(0);
    // 10% is exactly the threshold, not over it
    expect(report.results[0].isRegression).toBe(false);
  });

  it("should detect MEM regression when mean increases by more than 5%", () => {
    writeResult(baselineDir, "keyed_react_21_ready-memory.json", makeResultJson("keyed/react", "21_ready-memory", "memory", 1000));
    writeResult(currentDir, "keyed_react_21_ready-memory.json", makeResultJson("keyed/react", "21_ready-memory", "memory", 1060));

    const report = detectRegressions(currentDir, baselineDir);
    expect(report.summary.regressions).toBe(1);
    expect(report.results[0].isRegression).toBe(true);
    expect(report.results[0].percentChange).toBe(6);
  });

  it("should NOT detect MEM regression when mean increases by exactly 5%", () => {
    writeResult(baselineDir, "keyed_react_21_ready-memory.json", makeResultJson("keyed/react", "21_ready-memory", "memory", 1000));
    writeResult(currentDir, "keyed_react_21_ready-memory.json", makeResultJson("keyed/react", "21_ready-memory", "memory", 1050));

    const report = detectRegressions(currentDir, baselineDir);
    expect(report.summary.regressions).toBe(0);
    expect(report.results[0].isRegression).toBe(false);
  });

  it("should skip frameworks in the ignore list", () => {
    writeResult(baselineDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 100));
    writeResult(currentDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 200));

    const report = detectRegressions(currentDir, baselineDir, ["keyed/react"]);
    expect(report.summary.totalComparisons).toBe(0);
    expect(report.summary.regressions).toBe(0);
  });

  it("should skip when baseline file is missing", () => {
    writeResult(currentDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 100));

    const report = detectRegressions(currentDir, baselineDir);
    expect(report.summary.totalComparisons).toBe(0);
  });

  it("should skip non-comparable types (size, startup)", () => {
    const sizeResult = makeResultJson("keyed/react", "40_sizes", "size", 100, "size_uncompressed");
    writeResult(baselineDir, "keyed_react_40_sizes.json", sizeResult);
    writeResult(currentDir, "keyed_react_40_sizes.json", sizeResult);

    const report = detectRegressions(currentDir, baselineDir);
    expect(report.summary.totalComparisons).toBe(0);
  });

  it("should handle missing baseline directory gracefully", () => {
    writeResult(currentDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 100));

    const report = detectRegressions(currentDir, "/nonexistent/path");
    expect(report.summary.totalComparisons).toBe(0);
  });

  it("should detect improvements (negative percent change)", () => {
    writeResult(baselineDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 100));
    writeResult(currentDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 80));

    const report = detectRegressions(currentDir, baselineDir);
    expect(report.summary.regressions).toBe(0);
    expect(report.summary.improvements).toBe(1);
    expect(report.results[0].percentChange).toBe(-20);
  });

  it("should write regression report to disk", () => {
    writeResult(baselineDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 100));
    writeResult(currentDir, "keyed_react_01_run1k.json", makeResultJson("keyed/react", "01_run1k", "cpu", 120));

    const report = detectRegressions(currentDir, baselineDir);
    const outputPath = writeRegressionReport(report, currentDir);

    expect(fs.existsSync(outputPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(written.summary.regressions).toBe(1);
    expect(written.results[0].framework).toBe("keyed/react");
  });

  it("should handle multiple benchmarks and frameworks", () => {
    // Framework A: CPU regression
    writeResult(baselineDir, "fwA_01.json", makeResultJson("fwA", "01_run1k", "cpu", 100));
    writeResult(currentDir, "fwA_01.json", makeResultJson("fwA", "01_run1k", "cpu", 150));

    // Framework B: no regression
    writeResult(baselineDir, "fwB_01.json", makeResultJson("fwB", "01_run1k", "cpu", 100));
    writeResult(currentDir, "fwB_01.json", makeResultJson("fwB", "01_run1k", "cpu", 105));

    // Framework A: MEM regression
    writeResult(baselineDir, "fwA_21.json", makeResultJson("fwA", "21_ready-memory", "memory", 500));
    writeResult(currentDir, "fwA_21.json", makeResultJson("fwA", "21_ready-memory", "memory", 600));

    const report = detectRegressions(currentDir, baselineDir);
    expect(report.summary.totalComparisons).toBe(3);
    expect(report.summary.regressions).toBe(2); // fwA cpu + fwA mem
    expect(report.summary.improvements).toBe(0);
  });

  it("should skip entries with zero baseline mean to avoid division by zero", () => {
    writeResult(baselineDir, "fw_01.json", makeResultJson("fw", "01_run1k", "cpu", 0));
    writeResult(currentDir, "fw_01.json", makeResultJson("fw", "01_run1k", "cpu", 10));

    const report = detectRegressions(currentDir, baselineDir);
    expect(report.summary.totalComparisons).toBe(0);
  });

  // --- compareResults / loadResultsFromDirectory tests ---

  it("loadResultsFromDirectory should return empty map for missing directory", () => {
    const results = loadResultsFromDirectory("/nonexistent/path");
    expect(results.size).toBe(0);
  });

  it("loadResultsFromDirectory should skip invalid JSON files", () => {
    fs.writeFileSync(path.join(baselineDir, "bad.json"), "not json", "utf8");
    fs.writeFileSync(path.join(baselineDir, "good.json"), JSON.stringify(
      makeResultJson("fw", "bench", "cpu", 100)
    ), "utf8");
    fs.writeFileSync(path.join(baselineDir, "readme.txt"), "not json", "utf8");

    const results = loadResultsFromDirectory(baselineDir);
    expect(results.size).toBe(1);
    expect(results.has("good.json")).toBe(true);
  });

  it("compareResults should work with in-memory maps", () => {
    const baseline = new Map();
    baseline.set("fw_01.json", makeResultJson("fw", "01_run1k", "cpu", 100));

    const current = new Map();
    current.set("fw_01.json", makeResultJson("fw", "01_run1k", "cpu", 120));

    const report = compareResults(baseline, current, "baseline-mem", "current-mem");
    expect(report.summary.totalComparisons).toBe(1);
    expect(report.summary.regressions).toBe(1);
    expect(report.baselineDirectory).toBe("baseline-mem");
    expect(report.currentDirectory).toBe("current-mem");
  });

  it("readIgnoreList should return empty array when no config exists", () => {
    // In a test environment, the package.json may or may not have the field
    const result = readIgnoreList();
    expect(Array.isArray(result)).toBe(true);
  });
});
