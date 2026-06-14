import { WebDriver, Builder } from "selenium-webdriver";
import { CPUBenchmarkWebdriver, benchmarks } from "./benchmarksWebdriverAfterframe.js";
import { setUseShadowRoot, setUseRowShadowRoot, setShadowRootName, setButtonsInShadowRoot } from "./webdriverAccess.js";

import { Config, FrameworkData, ErrorAndWarning, BenchmarkOptions } from "./common.js";
import { BenchmarkType, CPUBenchmarkResult } from "./benchmarksCommon.js";
import { getAfterframeDurations, initMeasurement } from "./benchmarksWebdriverAfterframe.js";
import { convertError, setupForkedRunner } from "./forkedRunnerCommon.js";

async function runBenchmark(
  driver: WebDriver,
  benchmark: CPUBenchmarkWebdriver,
  framework: FrameworkData,
  cfg: Readonly<Config>
): Promise<void> {
  await benchmark.run(driver, framework);
  if (cfg.LOG_PROGRESS)
    console.log("after run", benchmark.benchmarkInfo.id, benchmark.benchmarkInfo.type, framework.name);
}

async function initBenchmark(
  driver: WebDriver,
  benchmark: CPUBenchmarkWebdriver,
  framework: FrameworkData,
  cfg: Readonly<Config>
): Promise<void> {
  await benchmark.init(driver, framework);
  if (cfg.LOG_PROGRESS)
    console.log("after initialized", benchmark.benchmarkInfo.id, benchmark.benchmarkInfo.type, framework.name);
  await initMeasurement(driver);
}

async function runCPUBenchmark(
  framework: FrameworkData,
  benchmark: CPUBenchmarkWebdriver,
  benchmarkOptions: BenchmarkOptions,
  cfg: Readonly<Config>
): Promise<ErrorAndWarning<CPUBenchmarkResult>> {
  let error: string | undefined = undefined;
  let warnings: string[] = [];
  let results: CPUBenchmarkResult[] = [];

  console.log("benchmarking", framework, benchmark.benchmarkInfo.id);
  let driver: WebDriver | null = null;
  try {
    driver = await new Builder().forBrowser(benchmarkOptions.browser).build();
    console.log(`using afterframe measurement with ${benchmarkOptions.browser}`);
    await driver.manage().window().maximize();

    for (let i = 0; i < benchmarkOptions.batchSize; i++) {
      setUseShadowRoot(framework.useShadowRoot);
      setUseRowShadowRoot(framework.useRowShadowRoot);
      if (framework.shadowRootName) {
        setShadowRootName(framework.shadowRootName);
      }
      setButtonsInShadowRoot(framework.buttonsInShadowRoot);
      console.log("runCPUBenchmark: before loading page");
      await driver.get(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`);
      await driver.sleep(50);
      console.log("runCPUBenchmark: initBenchmark");
      await initBenchmark(driver, benchmark, framework, cfg);
      console.log("runCPUBenchmark: runBenchmark");
      await runBenchmark(driver, benchmark, framework, cfg);
      console.log("runCPUBenchmark: getAfterframeDurations");
      results.push(...getAfterframeDurations());
      console.log("runCPUBenchmark: loop end");
    }
    console.log("runCPUBenchmark: driver.quit");
    await driver.quit();
    return { error, warnings, result: results };
  } catch (error) {
    console.log("ERROR", error);
    try {
      if (driver) {
        await driver.close();
        await driver.quit();
      }
    } catch (error) {
      console.log("ERROR cleaning up driver", error);
    }
    return { error: convertError(error), warnings };
  }
}

async function executeBenchmark(
  framework: FrameworkData,
  benchmarkId: string,
  benchmarkOptions: BenchmarkOptions,
  cfg: Readonly<Config>
): Promise<ErrorAndWarning<number | CPUBenchmarkResult>> {
  let runBenchmarks: Array<CPUBenchmarkWebdriver> = benchmarks.filter(
    (b) => benchmarkId === b.benchmarkInfo.id && b instanceof CPUBenchmarkWebdriver
  ) as Array<CPUBenchmarkWebdriver>;
  if (runBenchmarks.length != 1) throw `Benchmark name ${benchmarkId} is not unique (webdriver)`;

  let benchmark = runBenchmarks[0];

  let errorAndWarnings: ErrorAndWarning<number | CPUBenchmarkResult> = { error: "No benchmark executed" };
  if (benchmark.benchmarkInfo.type == BenchmarkType.CPU) {
    errorAndWarnings = await runCPUBenchmark(framework, benchmark, benchmarkOptions, cfg);
  }

  if (cfg.LOG_DEBUG) console.log("benchmark finished - got errors promise", errorAndWarnings);
  return errorAndWarnings;
}

setupForkedRunner("WebdriverAfterframe", executeBenchmark);
