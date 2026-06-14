import * as fs from "node:fs/promises";
import { WebDriver } from "selenium-webdriver";
import { BenchmarkType, CPUBenchmarkResult, slowDownFactor } from "./benchmarksCommon.js";
import { benchmarks, CPUBenchmarkWebdriverCDP } from "./benchmarksWebdriverCDP.js";
import { BenchmarkOptions, config as defaultConfig, ErrorAndWarning, FrameworkData, Config } from "./common.js";
import { computeResultsCPU, computeResultsJS, computeResultsPaint, fileNameTrace } from "./timeline.js";
import {
  buildDriver,
  setButtonsInShadowRoot,
  setShadowRootName,
  setUseRowShadowRoot,
  setUseShadowRoot,
} from "./webdriverCDPAccess.js";
import { convertError, startForkedRunner } from "./forkedRunnerCommon.js";

let config: Config = defaultConfig;

// necessary to launch without specifiying a path
import "chromedriver";

const wait = (delay = 1000) => new Promise((res) => setTimeout(res, delay));

async function runBenchmark(
  driver: WebDriver,
  benchmark: CPUBenchmarkWebdriverCDP,
  framework: FrameworkData
): Promise<any> {
  await benchmark.run(driver, framework);
  if (config.LOG_PROGRESS)
    console.log("after run", benchmark.benchmarkInfo.id, benchmark.benchmarkInfo.type, framework.name);
}

async function initBenchmark(
  driver: WebDriver,
  benchmark: CPUBenchmarkWebdriverCDP,
  framework: FrameworkData
): Promise<any> {
  await benchmark.init(driver, framework);
  if (config.LOG_PROGRESS) console.log("after initialized", benchmark.benchmarkInfo.id, benchmark.benchmarkInfo.type, framework.name);
}

async function runCPUBenchmark(
  framework: FrameworkData,
  benchmark: CPUBenchmarkWebdriverCDP,
  benchmarkOptions: BenchmarkOptions
): Promise<ErrorAndWarning<CPUBenchmarkResult>> {
  let error: string | undefined = undefined;
  let warnings: string[] = [];
  let results: CPUBenchmarkResult[] = [];

  console.log("benchmarking", framework, benchmark.benchmarkInfo.id, "with webdriver (tracing via CDP Connection)");
  let driver: WebDriver | null = null;
  try {
    for (let i = 0; i < benchmarkOptions.batchSize; i++) {
      driver = buildDriver(benchmarkOptions);
      let trace: any = { traceEvents: [] };
      setUseShadowRoot(framework.useShadowRoot);
      setUseRowShadowRoot(framework.useRowShadowRoot);
      if (framework.shadowRootName) {
        setShadowRootName(framework.shadowRootName);
      }
      setButtonsInShadowRoot(framework.buttonsInShadowRoot);
      await driver.get(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`);

      await initBenchmark(driver, benchmark, framework);
      const cdpConnection = await (driver as any).createCDPConnection("page");
      let throttleCPU = slowDownFactor(benchmark.benchmarkInfo.id, benchmarkOptions.allowThrottling);
      if (throttleCPU) {
        console.log("CPU slowdown", throttleCPU);
        await (driver as any).sendDevToolsCommand("Emulation.setCPUThrottlingRate", {
          rate: throttleCPU,
        });
      }

      let categories = [
        "blink.user_timing",
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
    ];

      console.log("**** Tracing start");
      await cdpConnection.execute("Tracing.start", {
        transferMode: "ReportEvents",
        traceConfig: {
            enableSampling: false,
            enableSystrace: false,
            excludedCategories: [],
            includedCategories: categories,
        },
      });

      let p = new Promise((resolve) => {
        cdpConnection._wsConnection.on("message", async (msg: any) => {
          let message: any = JSON.parse(msg);
          if (message.method === "Tracing.dataCollected") {
            trace.traceEvents = trace.traceEvents.concat(message.params.value);
          } else if (message.method === "Tracing.tracingComplete") {
            console.log(
              "---- Tracing.tracingComplete",
              fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions)
            );
            await fs.writeFile(
              fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions),
              JSON.stringify(trace),
              "utf8"
            );
            resolve({});
          }
        });
      });

      await wait(100);

      await runBenchmark(driver, benchmark, framework);

      if (throttleCPU) {
        console.log("resetting CPU slowdown");
        await (driver as any).sendDevToolsCommand("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
      await wait(100);

      await cdpConnection.execute("Tracing.end", {});
      await p;

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
      await driver.close();
      await driver.quit();
    }
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

export async function executeBenchmark(
  framework: FrameworkData,
  benchmarkId: string,
  benchmarkOptions: BenchmarkOptions
): Promise<ErrorAndWarning<number | CPUBenchmarkResult>> {
  let runBenchmarks: Array<CPUBenchmarkWebdriverCDP> = benchmarks.filter(
    (b) => benchmarkId === b.benchmarkInfo.id && b instanceof CPUBenchmarkWebdriverCDP
  ) as Array<CPUBenchmarkWebdriverCDP>;
  if (runBenchmarks.length != 1) throw `Benchmark name ${benchmarkId} is not unique (webdriver)`;

  let benchmark = runBenchmarks[0];

  let errorAndWarnings: ErrorAndWarning<number | CPUBenchmarkResult> = { error: "No benchmark executed" };
  if (benchmark.benchmarkInfo.type == BenchmarkType.CPU) {
    errorAndWarnings = await runCPUBenchmark(framework, benchmark, benchmarkOptions);
  }

  if (config.LOG_DEBUG) console.log("benchmark finished - got errors promise", errorAndWarnings);
  return errorAndWarnings;
}

startForkedRunner("forkedBenchmarkRunnerWebdriverCDP", executeBenchmark);
