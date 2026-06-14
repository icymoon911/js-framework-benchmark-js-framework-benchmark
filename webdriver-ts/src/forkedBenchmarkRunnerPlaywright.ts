import { Browser, Page } from "playwright-core";
import { BenchmarkType, CPUBenchmarkResult, slowDownFactor } from "./benchmarksCommon.js";
import {
  benchmarks,
  CPUBenchmarkPlaywright,
  MemBenchmarkPlaywright,
  BenchmarkPlaywright,
} from "./benchmarksPlaywright.js";
import { BenchmarkOptions, config as defaultConfig, ErrorAndWarning, FrameworkData, Config } from "./common.js";
import { startBrowser } from "./playwrightAccess.js";
import { computeResultsCPU, computeResultsJS, computeResultsPaint, fileNameTrace } from "./timeline.js";
import { convertError, startForkedRunner } from "./forkedRunnerCommon.js";

let config: Config = defaultConfig;

async function runBenchmark(
  browser: Browser,
  page: Page,
  benchmark: BenchmarkPlaywright,
  framework: FrameworkData
): Promise<any> {
  await benchmark.run(browser, page, framework);
  if (config.LOG_PROGRESS) console.log("after run", benchmark.benchmarkInfo.id, benchmark.type, framework.name);
}

async function initBenchmark(
  browser: Browser,
  page: Page,
  benchmark: BenchmarkPlaywright,
  framework: FrameworkData
): Promise<any> {
  await benchmark.init(browser, page, framework);
  if (config.LOG_PROGRESS) console.log("after initialized", benchmark.benchmarkInfo.id, benchmark.type, framework.name);
}

const wait = (delay = 1000) => new Promise((res) => setTimeout(res, delay));

async function forceGC(page: Page) {
  await page.evaluate("window.gc({type:'major',execution:'sync',flavor:'last-resort'})");
}

async function runCPUBenchmark(
  framework: FrameworkData,
  benchmark: CPUBenchmarkPlaywright,
  benchmarkOptions: BenchmarkOptions
): Promise<ErrorAndWarning<CPUBenchmarkResult>> {
  let error: string | undefined = undefined;
  let warnings: string[] = [];
  let results: CPUBenchmarkResult[] = [];

  console.log("benchmarking", framework, benchmark.benchmarkInfo.id);
  let browser: Browser | null = null;
  try {
    browser = await startBrowser(benchmarkOptions);
    for (let i = 0; i < benchmarkOptions.batchSize; i++) {
      let page = await browser.newPage();
      page.on("console", (msg) => {
        for (let j = 0; j < msg.args().length; ++j) console.log(`BROWSER: ${msg.args()[j]}`);
      });
      let client = await page.context().newCDPSession(page);
      await page.goto(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`, {
        waitUntil: "networkidle",
      });

      console.log("initBenchmark Playwright");
      await initBenchmark(browser, page, benchmark, framework);
      let categories = ["blink.user_timing", "devtools.timeline", "disabled-by-default-devtools.timeline"];

      await forceGC(page);
      let throttleCPU = slowDownFactor(benchmark.benchmarkInfo.id, benchmarkOptions.allowThrottling);
      if (throttleCPU) {
        console.log("CPU slowdown", throttleCPU);
        await client.send("Emulation.setCPUThrottlingRate", { rate: throttleCPU });
      }

      await browser.startTracing(page, {
        path: fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions),
        screenshots: false,
        categories: categories,
      });
      await runBenchmark(browser, page, benchmark, framework);

      await wait(40);
      await browser.stopTracing();
      if (throttleCPU) {
        await client.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
      let result = await computeResultsCPU(fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions), framework.startLogicEventName);
      let resultScript = await computeResultsJS(
        result,
        config,
        fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions)
      );
      let resultPaint = await computeResultsPaint(
        result,
        config,
        fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions)
      );

      let res = { total: result.duration, script: resultScript, paint: resultPaint };
      results.push(res);
      console.log(`duration for ${framework.name} and ${benchmark.benchmarkInfo.id}: ${JSON.stringify(res)}`);
      if (result.duration < 0) throw new Error(`duration ${result} < 0`);
      try {
        if (page) {
          await page.close();
        }
      } catch (error) {
        console.log("ERROR closing page", error);
      }
    }
    return { error, warnings, result: results };
  } catch (error) {
    console.log("ERROR", error);
    return { error: convertError(error), warnings };
  } finally {
    try {
      if (browser) {
        await browser.close();
      }
    } catch (error) {
      console.log("ERROR cleaning up driver", error);
    }
  }
}

async function runMemBenchmark(
  framework: FrameworkData,
  benchmark: MemBenchmarkPlaywright,
  benchmarkOptions: BenchmarkOptions
): Promise<ErrorAndWarning<number>> {
  let error: string | undefined = undefined;
  let warnings: string[] = [];
  let results: number[] = [];

  console.log("benchmarking", framework, benchmark.benchmarkInfo.id);
  let browser: Browser | null = null;
  try {
    browser = await startBrowser(benchmarkOptions);
    const page = await browser.newPage();
    for (let i = 0; i < benchmarkOptions.batchSize; i++) {
      if (config.LOG_DETAILS) {
        page.on("console", (msg) => {
          for (let j = 0; j < msg.args().length; ++j) console.log(`BROWSER: ${msg.args()[j]}`);
        });
      }

      await page.goto(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`, {
        waitUntil: "networkidle",
      });

      console.log("initBenchmark");
      let client = await page.context().newCDPSession(page);
      await client.send("Performance.enable");
      await initBenchmark(browser, page, benchmark, framework);

      console.log("runBenchmark");
      await runBenchmark(browser, page, benchmark, framework);
      await forceGC(page);
      await wait(40);

      let result = ((await page.evaluate("performance.measureUserAgentSpecificMemory()")) as any).bytes / 1024 / 1024;
      console.log("afterBenchmark ");
      results.push(result);
      console.log(`memory result for ${framework.name} and ${benchmark.benchmarkInfo.id}: ${result}`);
      if (result < 0) throw new Error(`memory result ${result} < 0`);
    }
    await page.close();
    await browser.close();
    return { error, warnings, result: results };
  } catch (error) {
    console.log("ERROR", error);
    try {
      if (browser) {
        await browser.close();
      }
    } catch (error) {
      console.log("ERROR cleaning up driver", error);
    }
    return { error: convertError(error), warnings };
  }
}

export async function executeBenchmark(
  framework: FrameworkData,
  benchmarkId: string,
  benchmarkOptions: BenchmarkOptions
): Promise<ErrorAndWarning<number | CPUBenchmarkResult>> {
  let runBenchmarks: Array<BenchmarkPlaywright> = benchmarks.filter(
    (b) =>
      benchmarkId === b.benchmarkInfo.id && (b instanceof CPUBenchmarkPlaywright || b instanceof MemBenchmarkPlaywright)
  ) as Array<BenchmarkPlaywright>;

  let benchmark = runBenchmarks[0];

  let errorAndWarnings: ErrorAndWarning<number | CPUBenchmarkResult>;
  if (benchmark.type == BenchmarkType.CPU) {
    errorAndWarnings = await runCPUBenchmark(framework, benchmark as CPUBenchmarkPlaywright, benchmarkOptions);
  } else {
    errorAndWarnings = await runMemBenchmark(framework, benchmark as MemBenchmarkPlaywright, benchmarkOptions);
  }
  if (config.LOG_DEBUG) console.log("benchmark finished - got errors promise", errorAndWarnings);
  return errorAndWarnings;
}

startForkedRunner("forkedBenchmarkRunnerPlaywright", executeBenchmark);
