import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { detectRegressions, writeRegressionReport, RegressionReport } from "./regressionDetection.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "regression-test-"));
}

function writeResultFile(dir: string, filename: string, data: any): void {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data), "utf8");
}

function makeCPUResult(framework: string, benchmark: string, meanTotal: number): any {
  return {
    framework,
    keyed: true,
    benchmark,
    type: "cpu",
    values: {
      total: { min: meanTotal - 1, max: meanTotal + 1, mean: meanTotal, stddev: 0.5, median: meanTotal, values: [meanTotal] },
      script: { min: meanTotal * 0.7, max: meanTotal * 0.9, mean: meanTotal * 0.8, stddev: 0.3, median: meanTotal * 0.8, values: [meanTotal * 0.8] },
      paint: { min: 0.5, max: 1.5, mean: 1.0, stddev: 0.2, median: 1.0, values: [1.0] },
    },
  };
}

function makeMemResult(framework: string, benchmark: string, meanMem: number): any {
  return {
    framework,
    keyed: true,
    benchmark,
    type: "memory",
    values: {
      DEFAULT: { min: meanMem - 100, max: meanMem + 100, mean: meanMem, stddev: 50, median: meanMem, values: [meanMem] },
    },
  };
}

describe("regressionDetection", () => {
  let currentDir: string;
  let baselineDir: string;

  beforeEach(() => {
    currentDir = createTempDir();
    baselineDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(currentDir, { recursive: true, force: true });
    fs.rmSync(baselineDir, { recursive: true, force: true });
  });

  it("should detect no regressions when results are identical", () => {
    const result = makeCPUResult("keyed/react", "01_run1k", 50.0);
    writeResultFile(currentDir, "keyed_react_01_run1k.json", result);
    writeResultFile(baselineDir, "keyed_react_01_run1k.json", result);

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(hasRegressions).toBe(false);
    expect(report.entries.length).toBe(1);
    expect(report.entries[0].changePercent).toBe(0);
    expect(report.entries[0].isRegression).toBe(false);
  });

  it("should detect CPU regression when mean increases by more than 10%", () => {
    writeResultFile(baselineDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 56.0)); // +12%

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(hasRegressions).toBe(true);
    expect(report.entries.length).toBe(1);
    expect(report.entries[0].isRegression).toBe(true);
    expect(report.entries[0].changePercent).toBe(12);
    expect(report.summary.regressions).toBe(1);
  });

  it("should NOT detect CPU regression when mean increases by less than 10%", () => {
    writeResultFile(baselineDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 54.0)); // +8%

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(hasRegressions).toBe(false);
    expect(report.entries[0].isRegression).toBe(false);
    expect(report.entries[0].changePercent).toBe(8);
  });

  it("should detect MEM regression when mean increases by more than 5%", () => {
    writeResultFile(baselineDir, "keyed_react_21_ready-memory.json", makeMemResult("keyed/react", "21_ready-memory", 5000));
    writeResultFile(currentDir, "keyed_react_21_ready-memory.json", makeMemResult("keyed/react", "21_ready-memory", 5300)); // +6%

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(hasRegressions).toBe(true);
    expect(report.entries[0].isRegression).toBe(true);
    expect(report.entries[0].changePercent).toBe(6);
  });

  it("should NOT detect MEM regression when mean increases by less than 5%", () => {
    writeResultFile(baselineDir, "keyed_react_21_ready-memory.json", makeMemResult("keyed/react", "21_ready-memory", 5000));
    writeResultFile(currentDir, "keyed_react_21_ready-memory.json", makeMemResult("keyed/react", "21_ready-memory", 5200)); // +4%

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(hasRegressions).toBe(false);
    expect(report.entries[0].isRegression).toBe(false);
  });

  it("should skip when baseline file does not exist", () => {
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));
    // No baseline file

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(hasRegressions).toBe(false);
    expect(report.entries.length).toBe(0);
    expect(report.summary.skipped).toBe(1);
  });

  it("should skip when baseline directory does not exist", () => {
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: "/nonexistent/path/that/does/not/exist",
    });

    expect(hasRegressions).toBe(false);
    expect(report.entries.length).toBe(0);
    expect(report.summary.skipped).toBe(1);
  });

  it("should handle multiple frameworks and benchmarks", () => {
    // Baseline
    writeResultFile(baselineDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));
    writeResultFile(baselineDir, "keyed_vue_01_run1k.json", makeCPUResult("keyed/vue", "01_run1k", 60.0));
    writeResultFile(baselineDir, "keyed_react_02_replace1k.json", makeCPUResult("keyed/react", "02_replace1k", 45.0));

    // Current: react 01 has regression, vue 01 no regression, react 02 improvement
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 60.0)); // +20% regression
    writeResultFile(currentDir, "keyed_vue_01_run1k.json", makeCPUResult("keyed/vue", "01_run1k", 62.0)); // +3.3% no regression
    writeResultFile(currentDir, "keyed_react_02_replace1k.json", makeCPUResult("keyed/react", "02_replace1k", 35.0)); // -22% improvement

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(hasRegressions).toBe(true);
    expect(report.summary.total).toBe(3);
    expect(report.summary.regressions).toBe(1);
    expect(report.summary.improvements).toBe(1);
  });

  it("should write report to file correctly", () => {
    writeResultFile(baselineDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 60.0));

    const { report } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    const reportPath = writeRegressionReport(currentDir, report);
    expect(fs.existsSync(reportPath)).toBe(true);

    const writtenReport: RegressionReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(writtenReport.entries.length).toBe(1);
    expect(writtenReport.entries[0].isRegression).toBe(true);
    expect(writtenReport.timestamp).toBeDefined();
    expect(writtenReport.summary).toBeDefined();
  });

  it("should ignore regression_report.json in the results directory", () => {
    writeResultFile(currentDir, "regression_report.json", { some: "data" });
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));
    writeResultFile(baselineDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));

    const { report } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    // regression_report.json should be skipped, only the real result should be processed
    expect(report.entries.length).toBe(1);
  });

  it("should skip files that are not valid benchmark results", () => {
    writeResultFile(currentDir, "not_a_result.json", { foo: "bar" });
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));
    writeResultFile(baselineDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));

    const { report } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(report.entries.length).toBe(1);
  });

  it("should handle improvement (faster performance) correctly", () => {
    writeResultFile(baselineDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 40.0)); // -20% faster

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(hasRegressions).toBe(false);
    expect(report.entries[0].changePercent).toBe(-20);
    expect(report.entries[0].isRegression).toBe(false);
    expect(report.summary.improvements).toBe(1);
  });

  it("should report correct threshold values in the report", () => {
    const { report } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(report.thresholds.cpu).toBe(0.10);
    expect(report.thresholds.mem).toBe(0.05);
  });

  it("should include baseline and current directory in report", () => {
    const { report } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(report.baselineDirectory).toBe(baselineDir);
    expect(report.currentDirectory).toBe(currentDir);
  });

  it("should include timestamp in ISO format", () => {
    const { report } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(report.timestamp).toBeDefined();
    // Verify it's a valid ISO date
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
  });

  it("should handle CPU result with baseline mean of zero gracefully", () => {
    const zeroResult = makeCPUResult("keyed/react", "01_run1k", 0);
    writeResultFile(baselineDir, "keyed_react_01_run1k.json", zeroResult);
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    // Should skip because baseline mean is 0 (division by zero guard)
    expect(hasRegressions).toBe(false);
    expect(report.entries.length).toBe(0);
    expect(report.summary.skipped).toBe(1);
  });

  it("should handle both CPU and MEM benchmarks in same run", () => {
    // Baseline
    writeResultFile(baselineDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 50.0));
    writeResultFile(baselineDir, "keyed_react_21_ready-memory.json", makeMemResult("keyed/react", "21_ready-memory", 5000));

    // Current: CPU regression, MEM no regression
    writeResultFile(currentDir, "keyed_react_01_run1k.json", makeCPUResult("keyed/react", "01_run1k", 56.0)); // +12% CPU regression
    writeResultFile(currentDir, "keyed_react_21_ready-memory.json", makeMemResult("keyed/react", "21_ready-memory", 5100)); // +2% MEM no regression

    const { report, hasRegressions } = detectRegressions({
      currentDirectory: currentDir,
      baselineDirectory: baselineDir,
    });

    expect(hasRegressions).toBe(true);
    expect(report.summary.total).toBe(2);
    expect(report.summary.regressions).toBe(1);

    const cpuEntry = report.entries.find(e => e.benchmark === "01_run1k");
    const memEntry = report.entries.find(e => e.benchmark === "21_ready-memory");
    expect(cpuEntry?.isRegression).toBe(true);
    expect(memEntry?.isRegression).toBe(false);
  });
});
