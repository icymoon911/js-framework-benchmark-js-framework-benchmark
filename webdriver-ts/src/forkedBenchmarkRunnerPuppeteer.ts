import { Browser, Page } from "puppeteer-core";
import { BenchmarkType, CPUBenchmarkResult, slowDownFactor } from "./benchmarksCommon.js";
import { CPUBenchmarkPuppeteer, MemBenchmarkPuppeteer, BenchmarkPuppeteer, benchmarks } from "./benchmarksPuppeteer.js";
import {
  BenchmarkOptions,
  ErrorAndWarning,
  FrameworkData,
  Config,
  wait,
  config as defaultConfig,
} from "./common.js";
import { startBrowser } from "./puppeteerAccess.js";
import { computeResultsCPU, computeResultsJS, computeResultsPaint, fileNameTrace } from "./timeline.js";
import { convertError, startForkedRunner } from "./forkedRunnerCommon.js";
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";

let config: Config = defaultConfig;

async function runBenchmark(page: Page, benchmark: BenchmarkPuppeteer, framework: FrameworkData): Promise<any> {
  await benchmark.run(page, framework);
  if (config.LOG_PROGRESS) console.log("after run", benchmark.benchmarkInfo.id, benchmark.type, framework.name);
}

async function initBenchmark(page: Page, benchmark: BenchmarkPuppeteer, framework: FrameworkData): Promise<any> {
  await benchmark.init(page, framework);
  if (config.LOG_PROGRESS) console.log("after initialized", benchmark.benchmarkInfo.id, benchmark.type, framework.name);
}

async function forceGC(page: Page) {
  await page.evaluate("window.gc({type:'major',execution:'sync',flavor:'last-resort'})");
}

async function runCPUBenchmark(
  framework: FrameworkData,
  benchmark: CPUBenchmarkPuppeteer,
  benchmarkOptions: BenchmarkOptions
): Promise<ErrorAndWarning<CPUBenchmarkResult>> {
  let warnings: string[] = [];
  let results: CPUBenchmarkResult[] = [];

  console.log("benchmarking", framework, benchmark.benchmarkInfo.id);
  let browser: Browser | null = null;
  try {
    browser = await startBrowser(benchmarkOptions);
    for (let i = 0; i < benchmarkOptions.batchSize; i++) {
      const page = await browser.newPage();
      page.on("console", (msg) => console.log("BROWSER:", ...msg.args()));
      try {
        await page.goto(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`, {
          waitUntil: "networkidle0",
        });
      } catch (error) {
        console.log("**** loading benchmark failed, retrying");
        await page.goto(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`, {
          waitUntil: "networkidle0",
        });
      }

      console.log("initBenchmark");
      await initBenchmark(page, benchmark, framework);

      let categories = [
        "disabled-by-default-v8.cpu_profiler",
        "blink.user_timing",
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
      ];

      let throttleCPU = slowDownFactor(benchmark.benchmarkInfo.id, benchmarkOptions.allowThrottling);
      if (throttleCPU) {
        console.log("CPU slowdown", throttleCPU);
        await page.emulateCPUThrottling(throttleCPU);
      }

      await page.tracing.start({
        path: fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions),
        screenshots: false,
        categories: categories,
      });
      await wait(50);

      await forceGC(page);

      console.log("runBenchmark");

      await runBenchmark(page, benchmark, framework);

      await wait(100);
      await page.tracing.stop();
      if (throttleCPU) {
        await page.emulateCPUThrottling(1);
      }

      try {
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
        console.log("**** resultScript =", resultScript);
        results.push({ total: result.duration, script: resultScript, paint: resultPaint });
        console.log(`duration for ${framework.name} and ${benchmark.benchmarkInfo.id}: ${JSON.stringify(result)}`);
        if (result.duration < 0) throw new Error(`duration ${result} < 0`);
      } catch (error) {
        if (error === "exactly one click event is expected") {
          let fileName = fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions);
          let errorFileName = fileName.replace(/\//, "/error-");
          fs.copyFileSync(fileName, errorFileName);
          console.log(
            "*** Repeating run because of 'exactly one click event is expected' error",
            fileName,
            "saved in",
            errorFileName
          );
          i--;
          continue;
        } else {
          console.log("*** Unhandled error:", error);
          throw error;
        }
      } finally {
        await page.close();
      }
    }
    return { error: undefined, warnings, result: results };
  } catch (error) {
    console.log("ERROR", error);
    return { error: convertError(error), warnings };
  } finally {
    try {
      if (browser) {
        console.log("*** browser close");
        await browser.close();
        console.log("*** browser closed");
      }
    } catch (error) {
      console.log("ERROR cleaning up driver", error);
    }
    console.log("*** browser has been shutting down");
  }
}

async function runMemBenchmark(
  framework: FrameworkData,
  benchmark: MemBenchmarkPuppeteer,
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
          for (let i = 0; i < msg.args().length; ++i) console.log(`BROWSER: ${msg.args()[i]}`);
        });
      }

      await page.goto(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`, {
        waitUntil: "networkidle0",
      });

      console.log("initBenchmark");
      await initBenchmark(page, benchmark, framework);
      const client = await page.createCDPSession();

      console.log("runBenchmark");
      await runBenchmark(page, benchmark, framework);
      await forceGC(page);
      await wait(40);
      let result = ((await page.evaluate("performance.measureUserAgentSpecificMemory()")) as any).bytes / 1024 / 1024;
      console.log("afterBenchmark");

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
): Promise<ErrorAndWarning<any>> {
  const startTime = performance.now();
  let runBenchmarks: Array<BenchmarkPuppeteer> = benchmarks.filter(
    (b) =>
      benchmarkId === b.benchmarkInfo.id && (b instanceof CPUBenchmarkPuppeteer || b instanceof MemBenchmarkPuppeteer)
  ) as Array<BenchmarkPuppeteer>;
  if (runBenchmarks.length != 1) throw `Benchmark name ${benchmarkId} is not unique (puppeteer)`;

  let benchmark = runBenchmarks[0];
  let errorAndWarnings: ErrorAndWarning<any>;
  if (benchmark.type == BenchmarkType.CPU) {
    errorAndWarnings = await runCPUBenchmark(framework, benchmark as CPUBenchmarkPuppeteer, benchmarkOptions);
  } else {
    errorAndWarnings = await runMemBenchmark(framework, benchmark as MemBenchmarkPuppeteer, benchmarkOptions);
  }
  if (config.LOG_DEBUG) console.log("benchmark finished - got errors promise", errorAndWarnings);
  const duration = performance.now() - startTime;
  console.log(`=> Duration for ${benchmark.benchmarkInfo.id} and framework ${framework.name}: ${duration.toFixed(2)} ms`);
  return errorAndWarnings;
}

startForkedRunner("forkedBenchmarkRunnerPuppeteer", executeBenchmark);
