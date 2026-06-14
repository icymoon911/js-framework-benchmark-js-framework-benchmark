import yargs from "yargs";
import {
  BenchmarkOptions,
  BenchmarkRunner,
  Config,
  createConfig,
  ErrorAndWarning,
  FrameworkData,
  initializeFrameworks,
} from "./common.js";
import { fork, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import {
  BenchmarkInfo,
  benchmarkInfos,
  BenchmarkType,
  CPUBenchmarkInfo,
  cpuBenchmarkInfosArray,
  CPUBenchmarkResult,
  MemBenchmarkInfo,
  SizeBenchmarkInfo,
  SizeMainBenchmarkInfo,
  StartupBenchmarkInfo,
} from "./benchmarksCommon.js";
import { StartupBenchmarkResult } from "./benchmarksLighthouse.js";
import { writeResults, ResultCPU, ResultMem, ResultSize, ResultLightHouse } from "./writeResults.js";
import { PlausibilityCheck } from "./plausibilityCheck.js";
import { SizeBenchmarkResult } from "./benchmarksSize.js";

// ---- Types for parseArgs ----

interface ParsedArgs {
  headless: boolean;
  smoketest: boolean;
  type: string | undefined;
  nothrottling: boolean;
  runner: string;
  browser: string;
  framework: string[] | undefined;
  benchmark: string[] | undefined;
  count: number | undefined;
  puppeteerSleep: number | undefined;
  chromeBinary: string | undefined;
  positionalArgs: string[];
  help: boolean;
}

function parseArgs(): ParsedArgs {
  const args = yargs(process.argv)
    .usage(
      "$0 [--framework Framework1 Framework2 ...] [--benchmark Benchmark1 Benchmark2 ...] [--chromeBinary path] \n or: $0 [directory1] [directory2] .. [directory3]"
    )
    .help("help")
    .boolean("headless")
    .default("headless", false)
    .boolean("smoketest")
    .string("type")
    .boolean("nothrottling")
    .default("nothrottling", false)
    .string("runner")
    .default("runner", "puppeteer")
    .string("browser")
    .default("browser", "chrome")
    .array("framework")
    .array("benchmark")
    .number("count")
    .number("puppeteerSleep")
    .string("chromeBinary")
    .parseSync();

  const allArgs = (args._?.length ?? 0) <= 2 ? [] : (args._?.slice(2) ?? []).map(String);

  return {
    headless: args.headless as boolean,
    smoketest: args.smoketest as boolean,
    type: args.type as string | undefined,
    nothrottling: args.nothrottling as boolean,
    runner: args.runner as string,
    browser: args.browser as string,
    framework: args.framework as string[] | undefined,
    benchmark: args.benchmark as string[] | undefined,
    count: args.count as number | undefined,
    puppeteerSleep: args.puppeteerSleep as number | undefined,
    chromeBinary: args.chromeBinary as string | undefined,
    positionalArgs: allArgs,
    help: !!args.help,
  };
}

function resolveRunner(runner: string): BenchmarkRunner {
  const validRunners: BenchmarkRunner[] = [
    BenchmarkRunner.WEBDRIVER_CDP,
    BenchmarkRunner.WEBDRIVER_AFTERFRAME,
    BenchmarkRunner.PLAYWRIGHT,
    BenchmarkRunner.PUPPETEER,
  ];
  if (validRunners.includes(runner as BenchmarkRunner)) {
    return runner as BenchmarkRunner;
  }
  console.log("ERROR: argument runner has illegal value " + runner, validRunners);
  process.exit(1);
}

function filterBenchmarks(
  infos: BenchmarkInfo[],
  filterNames: string[],
  runner: BenchmarkRunner
): BenchmarkInfo[] {
  return infos.filter(
    (b) =>
      (runner !== BenchmarkRunner.WEBDRIVER_AFTERFRAME || b.type == BenchmarkType.CPU) &&
      filterNames.some((name) => b.id.toLowerCase().includes(name))
  );
}

function filterFrameworks(
  frameworks: FrameworkData[],
  frameworkArgs: string[],
  typeFilter: string | undefined,
  runner: BenchmarkRunner
): FrameworkData[] {
  let result = frameworks.filter(
    (f) => (frameworkArgs.length === 0 || frameworkArgs.some((arg) => arg == f.name)) &&
           (f.keyed || runner !== BenchmarkRunner.WEBDRIVER_AFTERFRAME)
  );

  if (typeFilter === "keyed") {
    result = result.filter((f) => f.keyed);
    console.log("run only keyed frameworks");
  } else if (typeFilter === "non-keyed") {
    result = result.filter((f) => !f.keyed);
    console.log("run only non-keyed frameworks");
  }

  return result;
}

// ---- Fork & call benchmark (with timeout) ----

type BenchmarkResultUnion = number | CPUBenchmarkResult | StartupBenchmarkResult | SizeBenchmarkResult;

function forkAndCallBenchmark(
  framework: FrameworkData,
  benchmarkInfo: BenchmarkInfo,
  benchmarkOptions: BenchmarkOptions,
  cfg: Readonly<Config>
): Promise<ErrorAndWarning<BenchmarkResultUnion>> {
  return new Promise((resolve, reject) => {
    let forkedRunner: string;
    if (benchmarkInfo.type === BenchmarkType.STARTUP_MAIN) {
      forkedRunner = "dist/forkedBenchmarkRunnerLighthouse.js";
    } else if (benchmarkInfo.type === BenchmarkType.SIZE_MAIN) {
      forkedRunner = "dist/forkedBenchmarkRunnerSize.js";
    } else if (cfg.BENCHMARK_RUNNER == BenchmarkRunner.WEBDRIVER_CDP) {
      forkedRunner = "dist/forkedBenchmarkRunnerWebdriverCDP.js";
    } else if (cfg.BENCHMARK_RUNNER == BenchmarkRunner.PLAYWRIGHT) {
      forkedRunner = "dist/forkedBenchmarkRunnerPlaywright.js";
    } else if (cfg.BENCHMARK_RUNNER == BenchmarkRunner.WEBDRIVER_AFTERFRAME) {
      forkedRunner = "dist/forkedBenchmarkRunnerWebdriverAfterframe.js";
    } else {
      forkedRunner = "dist/forkedBenchmarkRunnerPuppeteer.js";
    }
    console.log("forking", forkedRunner);
    const forked: ChildProcess = fork(forkedRunner);
    if (cfg.LOG_DETAILS) console.log("FORKING:  forked child process");

    forked.send({
      config: cfg,
      framework,
      benchmarkId: benchmarkInfo.id,
      benchmarkOptions,
    });

    // Timeout: kill child process if no response within cfg.TIMEOUT
    const timer = setTimeout(() => {
      console.error(`TIMEOUT: forked runner ${forkedRunner} did not respond within ${cfg.TIMEOUT}ms. Killing child process.`);
      forked.removeAllListeners("message");
      forked.removeAllListeners("error");
      forked.kill("SIGKILL");
      resolve({ error: `Timeout: ${forkedRunner} did not respond within ${cfg.TIMEOUT}ms`, warnings: [] });
    }, cfg.TIMEOUT);

    forked.on("message", (msg: ErrorAndWarning<BenchmarkResultUnion>) => {
      clearTimeout(timer);
      if (cfg.LOG_DETAILS) console.log("FORKING: main process got message from child", msg);
      resolve(msg);
    });
    forked.on("close", (msg) => {
      if (cfg.LOG_DETAILS) console.log("FORKING: child closed", msg);
    });
    forked.on("error", (msg) => {
      clearTimeout(timer);
      if (cfg.LOG_DETAILS) console.log("FORKING: child error", msg);
      reject(msg);
    });
    forked.on("exit", (code, signal) => {
      if (cfg.LOG_DEBUG) console.log("child exit", code, signal);
    });
  });
}

// ---- Unified benchmark loop ----

interface LoopHandler<T> {
  /** How many iterations to run */
  iterationCount(benchmarkInfo: T, benchmarkOptions: BenchmarkOptions, cfg: Readonly<Config>): number;
  /** Initial batch size for the loop */
  initialBatchSize(benchmarkInfo: T, benchmarkOptions: BenchmarkOptions, count: number, cfg: Readonly<Config>): number;
  /** Write the collected results to disk */
  writeResults(
    resultsDir: string,
    framework: FrameworkData,
    benchmarkInfo: T,
    results: any[]
  ): Promise<void>;
}

const cpuLoopHandler: LoopHandler<CPUBenchmarkInfo> = {
  iterationCount(info, opts, cfg) {
    return opts.numIterationsForCPUBenchmarks + info.additionalNumberOfRuns;
  },
  initialBatchSize(info, opts, count, cfg) {
    return cfg.ALLOW_BATCHING && info.allowBatching ? count : 1;
  },
  async writeResults(resultsDir, framework, info, results) {
    await writeResults(resultsDir, {
      framework,
      benchmark: info,
      results: results as CPUBenchmarkResult[],
      type: BenchmarkType.CPU,
    } as ResultCPU);
  },
};

const memLoopHandler: LoopHandler<MemBenchmarkInfo> = {
  iterationCount(_info, opts, _cfg) {
    return opts.numIterationsForMemBenchmarks;
  },
  initialBatchSize() {
    return 1;
  },
  async writeResults(resultsDir, framework, info, results) {
    await writeResults(resultsDir, {
      framework,
      benchmark: info,
      results: results as number[],
      type: BenchmarkType.MEM,
    } as ResultMem);
  },
};

const sizeLoopHandler: LoopHandler<SizeMainBenchmarkInfo> = {
  iterationCount(_info, opts, _cfg) {
    return opts.numIterationsForSizeBenchmark;
  },
  initialBatchSize() {
    return 1;
  },
  async writeResults(resultsDir, framework, info, results) {
    await writeResults(resultsDir, {
      framework,
      benchmark: info,
      results: results as SizeBenchmarkResult[],
      type: BenchmarkType.SIZE,
    } as ResultSize);
  },
};

async function runBenchmarkLoop<T extends BenchmarkInfo>(
  handler: LoopHandler<T>,
  framework: FrameworkData,
  benchmarkInfo: T,
  benchmarkOptions: BenchmarkOptions,
  cfg: Readonly<Config>
): Promise<{ errors: string[]; warnings: string[] }> {
  let warnings: string[] = [];
  let errors: string[] = [];
  let results: any[] = [];

  const count = handler.iterationCount(benchmarkInfo, benchmarkOptions, cfg);
  let batchSize = handler.initialBatchSize(benchmarkInfo, benchmarkOptions, count, cfg);
  benchmarkOptions.batchSize = batchSize;

  console.log("runBenchmarkLoop", framework.name, benchmarkInfo.id, "count=", count, "batchSize=", batchSize);

  while (results.length < count) {
    benchmarkOptions.batchSize = Math.min(benchmarkOptions.batchSize, count - results.length);
    console.log("FORKING:", benchmarkInfo.id, "BatchSize", benchmarkOptions.batchSize);

    let res = await forkAndCallBenchmark(framework, benchmarkInfo, benchmarkOptions, cfg);

    if (Array.isArray(res.result)) {
      results = results.concat(res.result);
    } else if (res.result !== undefined) {
      results.push(res.result);
    }
    if (res.warnings) {
      warnings = warnings.concat(res.warnings);
    }
    if (res.error) {
      console.log(`Executing ${framework.uri} and benchmark ${benchmarkInfo.id} failed: ` + res.error);
      errors.push(`Executing ${framework.uri} and benchmark ${benchmarkInfo.id} failed: ` + res.error);
      break;
    }
  }

  if (cfg.WRITE_RESULTS) {
    try {
      await handler.writeResults(benchmarkOptions.resultsDirectory, framework, benchmarkInfo, results);
    } catch (e) {
      console.error(e);
      errors.push(`Executing ${framework.uri} and benchmark ${benchmarkInfo.id} failed: ` + e);
    }
  }

  return { errors, warnings };
}

// ---- runBench orchestrator ----

async function runBench(
  runFrameworks: FrameworkData[],
  benchmarkInfos: BenchmarkInfo[],
  benchmarkOptions: BenchmarkOptions,
  cfg: Readonly<Config>
) {
  let errors: string[] = [];
  let warnings: string[] = [];

  let restart: string | undefined = undefined;
  let index = runFrameworks.findIndex((f) => f.fullNameWithKeyedAndVersion === restart);
  if (index > -1) {
    runFrameworks = runFrameworks.slice(index);
  }

  console.log(
    "Frameworks that will be benchmarked",
    runFrameworks.map((f) => f.fullNameWithKeyedAndVersion)
  );
  console.log(
    "Benchmarks that will be run",
    benchmarkInfos.map((b) => b.id)
  );

  let plausibilityCheck = new PlausibilityCheck();

  for (let j = 0; j < benchmarkInfos.length; j++) {
    const startTime = performance.now();
    for (let i = 0; i < runFrameworks.length; i++) {
      try {
        let result;
        const bi = benchmarkInfos[j];

        if (bi.type == BenchmarkType.SIZE_MAIN) {
          // Size benchmarks are dispatched via their sub-benchmarks
          // The loop handler iterates numIterationsForSizeBenchmark times
          result = await runBenchmarkLoop(
            sizeLoopHandler,
            runFrameworks[i],
            bi as SizeMainBenchmarkInfo,
            benchmarkOptions,
            cfg
          );
        } else if (bi.type == BenchmarkType.CPU) {
          result = await runBenchmarkLoop(
            cpuLoopHandler,
            runFrameworks[i],
            bi as CPUBenchmarkInfo,
            benchmarkOptions,
            cfg
          );
        } else {
          result = await runBenchmarkLoop(
            memLoopHandler,
            runFrameworks[i],
            bi as MemBenchmarkInfo,
            benchmarkOptions,
            cfg
          );
        }
        errors = errors.concat(result.errors);
        warnings = warnings.concat(result.warnings);
      } catch (error) {
        console.log("UNHANDELED ERROR", error);
        errors.push(error as string);
      }
    }
    const duration = performance.now() - startTime;
    console.log(`==> Duration for benchmark ${benchmarkInfos[j].id}: ${duration.toFixed(2)} ms`);
  }

  if (warnings.length > 0) {
    console.log("================================");
    console.log("The following warnings were logged:");
    console.log("================================");
    warnings.forEach((e) => {
      console.log(e);
    });
  }

  plausibilityCheck.print();

  if (errors.length > 0) {
    console.log("================================");
    console.log("The following benchmarks failed:");
    console.log("================================");
    errors.forEach((e) => {
      console.log(e);
    });
    throw "Benchmarking failed with errors";
  }
}

// ---- main ----

async function main() {
  console.error("PLEASE MAKE SURE THAT YOUR MOUSE IS OUTSIDE OF THE BROWSER WINDOW - and sorry for shouting :-) ");

  const args = parseArgs();
  console.log("args", args);

  const runner = resolveRunner(args.runner);
  console.log(`INFO: Using ${runner} benchmark runner`);

  console.log("HEADLESS***", args.headless);

  // Build an initial config, then derive benchmarkOptions from it
  const cfg = createConfig({
    BENCHMARK_RUNNER: runner,
    PUPPETEER_WAIT_MS: args.puppeteerSleep ?? 0,
    NUM_ITERATIONS_FOR_BENCHMARK_CPU_DROP_SLOWEST_COUNT: args.count ? 0 : 0,
  });

  let benchmarkOptions: BenchmarkOptions = {
    port: 8080,
    host: "localhost",
    browser: args.browser,
    remoteDebuggingPort: 9999,
    chromePort: 9998,
    headless: args.headless,
    chromeBinaryPath: args.chromeBinary,
    numIterationsForCPUBenchmarks:
      cfg.NUM_ITERATIONS_FOR_BENCHMARK_CPU + cfg.NUM_ITERATIONS_FOR_BENCHMARK_CPU_DROP_SLOWEST_COUNT,
    numIterationsForMemBenchmarks: cfg.NUM_ITERATIONS_FOR_BENCHMARK_MEM,
    numIterationsForStartupBenchmark: cfg.NUM_ITERATIONS_FOR_BENCHMARK_STARTUP,
    numIterationsForSizeBenchmark: cfg.NUM_ITERATIONS_FOR_BENCHMARK_SIZE,
    batchSize: 1,
    resultsDirectory: "results",
    tracesDirectory: "traces",
    allowThrottling: !args.nothrottling,
    puppeteerSleep: args.puppeteerSleep ?? 0,
  };

  if (args.count) {
    benchmarkOptions.numIterationsForCPUBenchmarks = args.count;
    benchmarkOptions.numIterationsForMemBenchmarks = args.count;
    benchmarkOptions.numIterationsForStartupBenchmark = args.count;
  }

  let frameworkArgument = args.framework ? args.framework : args.positionalArgs;
  console.log("frameworkArgument", frameworkArgument);

  if (process.env.HOST) {
    benchmarkOptions.host = process.env.HOST;
    console.log(`INFO: Using host ${benchmarkOptions.host} instead of localhost`);
  }
  console.log("benchmarkOptions", benchmarkOptions);

  const runBenchmarksArgs: string[] = args.benchmark && args.benchmark.length > 0 ? args.benchmark : [""];
  const runBenchmarks = filterBenchmarks(benchmarkInfos, runBenchmarksArgs, runner);

  const frameworks = await initializeFrameworks(benchmarkOptions, undefined, cfg);
  let runFrameworks = filterFrameworks(frameworks, frameworkArgument, args.type, runner);

  // Smoketest overrides — build a new config with overrides
  let finalCfg = cfg;
  if (args.smoketest) {
    cpuBenchmarkInfosArray.forEach((b) => {
      b.additionalNumberOfRuns = 0;
    });
    finalCfg = createConfig({
      ...cfg,
      WRITE_RESULTS: false,
      EXIT_ON_ERROR: true,
      NUM_ITERATIONS_FOR_BENCHMARK_CPU_DROP_SLOWEST_COUNT: 0,
    });
    benchmarkOptions.numIterationsForCPUBenchmarks = 1;
    benchmarkOptions.numIterationsForMemBenchmarks = 1;
    benchmarkOptions.numIterationsForStartupBenchmark = 1;
    console.log("Using smoketest config", JSON.stringify(finalCfg));
  }

  if (finalCfg.BENCHMARK_RUNNER == BenchmarkRunner.WEBDRIVER_AFTERFRAME) {
    benchmarkOptions.resultsDirectory = "results_client_" + benchmarkOptions.browser;
  }
  if (!fs.existsSync(benchmarkOptions.resultsDirectory)) fs.mkdirSync(benchmarkOptions.resultsDirectory);
  if (!fs.existsSync(benchmarkOptions.tracesDirectory)) fs.mkdirSync(benchmarkOptions.tracesDirectory);

  if (!args.help) {
    return runBench(runFrameworks, runBenchmarks, benchmarkOptions, finalCfg);
  }
}

main()
  .then(() => {
    console.log("successful run");
    process.exit(0);
  })
  .catch((error) => {
    console.log("run was not completely sucessful", error);
    process.exit(1);
  });
