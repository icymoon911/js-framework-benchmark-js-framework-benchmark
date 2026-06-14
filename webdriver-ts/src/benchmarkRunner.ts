import yargs from "yargs";
import {
  BenchmarkOptions,
  BenchmarkRunner,
  createConfig,
  Config,
  ReadonlyConfig,
  ErrorAndWarning,
  FrameworkData,
  initializeFrameworks,
  config,
  setGlobalConfig,
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
  StartupBenchmarkInfo,
} from "./benchmarksCommon.js";
import { StartupBenchmarkResult } from "./benchmarksLighthouse.js";
import { writeResults } from "./writeResults.js";
import { PlausibilityCheck } from "./plausibilityCheck.js";
import { SizeBenchmarkResult } from "./benchmarksSize.js";

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

export interface BenchmarkCLIArgs {
  headless: boolean;
  smoketest: boolean;
  type?: string;
  nothrottling: boolean;
  runner: string;
  browser: string;
  framework?: (string | number)[];
  benchmark?: (string | number)[];
  count?: number;
  puppeteerSleep?: number;
  chromeBinary?: string;
  help?: boolean;
  _: (string | number)[];
}

/**
 * Parse command-line arguments with proper TypeScript types.
 */
export function parseArgs(argv: string[]): BenchmarkCLIArgs {
  const args = yargs(argv)
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

  return args as unknown as BenchmarkCLIArgs;
}

const VALID_RUNNERS: BenchmarkRunner[] = [
  BenchmarkRunner.WEBDRIVER_CDP,
  BenchmarkRunner.WEBDRIVER_AFTERFRAME,
  BenchmarkRunner.PLAYWRIGHT,
  BenchmarkRunner.PUPPETEER,
];

/**
 * Validate and resolve the runner type from CLI args.
 */
function resolveRunner(runnerArg: string): BenchmarkRunner {
  if (VALID_RUNNERS.includes(runnerArg as BenchmarkRunner)) {
    console.log(`INFO: Using ${runnerArg} benchmark runner`);
    return runnerArg as BenchmarkRunner;
  }
  console.log("ERROR: argument driver has illegal value " + runnerArg, VALID_RUNNERS);
  process.exit(1);
}

// ─── Framework & Benchmark Filtering ─────────────────────────────────────────

/**
 * Filter frameworks based on CLI arguments (directory names, --type flag, --framework flag).
 */
export function filterFrameworks(
  frameworks: FrameworkData[],
  frameworkArg: (string | number)[],
  typeFilter: string | undefined,
  runner: BenchmarkRunner
): FrameworkData[] {
  let filtered = frameworks;

  // Afterframe currently only supports keyed frameworks
  if (runner === BenchmarkRunner.WEBDRIVER_AFTERFRAME) {
    filtered = filtered.filter((f) => f.keyed);
  }

  if (typeFilter === "keyed") {
    console.log("run only keyed frameworks");
    filtered = filtered.filter((f) => f.keyed);
  } else if (typeFilter === "non-keyed") {
    console.log("run only non-keyed frameworks");
    filtered = filtered.filter((f) => !f.keyed);
  }

  return filtered;
}

/**
 * Filter benchmarks based on CLI arguments and runner type.
 */
export function filterBenchmarks(
  allBenchmarks: BenchmarkInfo[],
  benchmarkArgs: (string | number)[],
  runner: BenchmarkRunner
): BenchmarkInfo[] {
  const filterNames: string[] = benchmarkArgs.length > 0
    ? benchmarkArgs.map(String)
    : [""];

  return allBenchmarks.filter(
    (b) =>
      // afterframe currently only targets CPU benchmarks
      (runner !== BenchmarkRunner.WEBDRIVER_AFTERFRAME || b.type === BenchmarkType.CPU) &&
      filterNames.some((name) => b.id.toLowerCase().includes(name.toLowerCase()))
  );
}

// ─── Forked Process Communication ────────────────────────────────────────────

type ForkResult = ErrorAndWarning<number | CPUBenchmarkResult | StartupBenchmarkResult | SizeBenchmarkResult>;

/**
 * Fork a child process to run a benchmark and communicate via IPC.
 * Includes a timeout mechanism: if the child process doesn't respond within
 * config.TIMEOUT milliseconds, it is killed and an error is returned.
 */
function forkAndCallBenchmark(
  cfg: ReadonlyConfig,
  framework: FrameworkData,
  benchmarkInfo: BenchmarkInfo,
  benchmarkOptions: BenchmarkOptions
): Promise<ForkResult> {
  return new Promise((resolve, reject) => {
    let forkedRunner: string;
    if (benchmarkInfo.type === BenchmarkType.STARTUP_MAIN) {
      forkedRunner = "dist/forkedBenchmarkRunnerLighthouse.js";
    } else if (benchmarkInfo.type === BenchmarkType.SIZE_MAIN) {
      forkedRunner = "dist/forkedBenchmarkRunnerSize.js";
    } else if (cfg.BENCHMARK_RUNNER === BenchmarkRunner.WEBDRIVER_CDP) {
      forkedRunner = "dist/forkedBenchmarkRunnerWebdriverCDP.js";
    } else if (cfg.BENCHMARK_RUNNER === BenchmarkRunner.PLAYWRIGHT) {
      forkedRunner = "dist/forkedBenchmarkRunnerPlaywright.js";
    } else if (cfg.BENCHMARK_RUNNER === BenchmarkRunner.WEBDRIVER_AFTERFRAME) {
      forkedRunner = "dist/forkedBenchmarkRunnerWebdriverAfterframe.js";
    } else {
      forkedRunner = "dist/forkedBenchmarkRunnerPuppeteer.js";
    }
    console.log("forking", forkedRunner);
    const forked: ChildProcess = fork(forkedRunner);
    if (cfg.LOG_DETAILS) console.log("FORKING: forked child process");

    // Timeout mechanism
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      console.log(`TIMEOUT: killing child process after ${cfg.TIMEOUT}ms for ${benchmarkInfo.id}`);
      forked.kill("SIGKILL");
      resolve({
        error: `Benchmark ${benchmarkInfo.id} timed out after ${cfg.TIMEOUT}ms`,
        warnings: [],
      });
    }, cfg.TIMEOUT);

    forked.send({
      config: cfg,
      framework,
      benchmarkId: benchmarkInfo.id,
      benchmarkOptions,
    });

    forked.on("message", (msg: ForkResult) => {
      if (cfg.LOG_DETAILS) console.log("FORKING: main process got message from child", msg);
      clearTimeout(timeoutId);
      resolve(msg);
    });

    forked.on("close", (msg) => {
      if (cfg.LOG_DETAILS) console.log("FORKING: child closed", msg);
    });

    forked.on("error", (msg) => {
      if (cfg.LOG_DETAILS) console.log("FORKING: child error", msg);
      clearTimeout(timeoutId);
      reject(msg);
    });

    forked.on("exit", (code, signal) => {
      if (cfg.LOG_DEBUG) console.log("child exit", code, signal);
      if (timedOut) {
        // Already resolved via timeout
      } else {
        clearTimeout(timeoutId);
      }
    });
  });
}

// ─── Benchmark Execution Loop (Strategy Pattern) ─────────────────────────────

/**
 * Handler interface for the unified benchmark loop.
 * Each benchmark type (CPU, MEM, SIZE) provides its own handler.
 */
interface BenchmarkLoopHandler {
  /** Determine the number of iterations needed */
  getIterationCount(benchmarkInfo: BenchmarkInfo, options: BenchmarkOptions, cfg: ReadonlyConfig): number;
  /** Determine the batch size for each iteration */
  getBatchSize(benchmarkInfo: BenchmarkInfo, options: BenchmarkOptions, cfg: ReadonlyConfig, remainingCount: number): number;
  /** Write results after the loop completes */
  writeResults(
    resultsDir: string,
    framework: FrameworkData,
    benchmarkInfo: BenchmarkInfo,
    results: any[],
    cfg: ReadonlyConfig
  ): Promise<void>;
}

const cpuHandler: BenchmarkLoopHandler = {
  getIterationCount(info, options, cfg) {
    const cpuInfo = info as CPUBenchmarkInfo;
    return options.numIterationsForCPUBenchmarks + cpuInfo.additionalNumberOfRuns;
  },
  getBatchSize(info, options, cfg, remaining) {
    const cpuInfo = info as CPUBenchmarkInfo;
    const total = this.getIterationCount(info, options, cfg);
    const initial = cfg.ALLOW_BATCHING && cpuInfo.allowBatching ? total : 1;
    return Math.min(initial, remaining);
  },
  async writeResults(resultsDir, framework, info, results) {
    await writeResults(resultsDir, {
      framework,
      benchmark: info,
      results: results as CPUBenchmarkResult[],
      type: BenchmarkType.CPU,
    });
  },
};

const memHandler: BenchmarkLoopHandler = {
  getIterationCount(_info, options) {
    return options.numIterationsForMemBenchmarks;
  },
  getBatchSize(_info, _options, _cfg, _remaining) {
    return 1;
  },
  async writeResults(resultsDir, framework, info, results) {
    await writeResults(resultsDir, {
      framework,
      benchmark: info,
      results: results as number[],
      type: BenchmarkType.MEM,
    });
  },
};

const sizeHandler: BenchmarkLoopHandler = {
  getIterationCount(_info, options) {
    return options.numIterationsForSizeBenchmark;
  },
  getBatchSize(_info, _options, _cfg, _remaining) {
    return 1;
  },
  async writeResults(resultsDir, framework, info, results) {
    await writeResults(resultsDir, {
      framework,
      benchmark: info,
      results: results as SizeBenchmarkResult[],
      type: BenchmarkType.SIZE,
    });
  },
};

function getHandlerForBenchmark(benchmarkInfo: BenchmarkInfo): BenchmarkLoopHandler {
  switch (benchmarkInfo.type) {
    case BenchmarkType.CPU:
      return cpuHandler;
    case BenchmarkType.MEM:
      return memHandler;
    case BenchmarkType.SIZE_MAIN:
      return sizeHandler;
    default:
      // STARTUP and others use a simple default
      return memHandler;
  }
}

/**
 * Unified benchmark execution loop.
 * Handles all benchmark types (CPU, MEM, SIZE) through a strategy handler.
 * Core loop logic is written once: iteration, result collection, error handling, writeResults.
 */
async function runBenchmarkLoop(
  cfg: ReadonlyConfig,
  framework: FrameworkData,
  benchmarkInfo: BenchmarkInfo,
  benchmarkOptions: BenchmarkOptions,
  plausibilityCheck?: PlausibilityCheck
): Promise<{ errors: string[]; warnings: string[] }> {
  const handler = getHandlerForBenchmark(benchmarkInfo);
  let warnings: string[] = [];
  let errors: string[] = [];
  let results: any[] = [];

  const count = handler.getIterationCount(benchmarkInfo, benchmarkOptions, cfg);
  benchmarkOptions.batchSize = handler.getBatchSize(benchmarkInfo, benchmarkOptions, cfg, count);

  console.log("runBenchmarkLoop", benchmarkInfo.type, framework, benchmarkInfo.id, "count:", count);

  while (results.length < count) {
    benchmarkOptions.batchSize = handler.getBatchSize(benchmarkInfo, benchmarkOptions, cfg, count - results.length);
    console.log("FORKING:", benchmarkInfo.id, "BatchSize", benchmarkOptions.batchSize);

    let res = await forkAndCallBenchmark(cfg, framework, benchmarkInfo, benchmarkOptions);

    if (Array.isArray(res.result)) {
      results = results.concat(res.result);
    } else if (res.result !== undefined) {
      results.push(res.result);
    }
    if (res.warnings) {
      warnings = warnings.concat(res.warnings);
    }
    if (res.error) {
      const errorMsg = `Executing ${framework.uri} and benchmark ${benchmarkInfo.id} failed: ${res.error}`;
      console.log(errorMsg);
      errors.push(errorMsg);
      break;
    }
  }

  if (cfg.WRITE_RESULTS) {
    try {
      await handler.writeResults(benchmarkOptions.resultsDirectory, framework, benchmarkInfo, results, cfg);
    } catch (e) {
      console.error(e);
      errors.push(`Executing ${framework.uri} and benchmark ${benchmarkInfo.id} failed: ${e}`);
    }
  }

  return { errors, warnings };
}

// ─── Main Orchestrator ───────────────────────────────────────────────────────

async function runBench(
  cfg: ReadonlyConfig,
  runFrameworks: FrameworkData[],
  benchmarkInfos: BenchmarkInfo[],
  benchmarkOptions: BenchmarkOptions
) {
  let errors: string[] = [];
  let warnings: string[] = [];

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
        let result = await runBenchmarkLoop(
          cfg,
          runFrameworks[i],
          benchmarkInfos[j],
          benchmarkOptions,
          plausibilityCheck
        );
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
    warnings.forEach((e) => console.log(e));
  }

  plausibilityCheck.print();

  if (errors.length > 0) {
    console.log("================================");
    console.log("The following benchmarks failed:");
    console.log("================================");
    errors.forEach((e) => console.log(e));
    throw "Benchmarking failed with errors";
  }
}

/**
 * Build benchmark options from CLI args and config.
 */
function buildBenchmarkOptions(args: BenchmarkCLIArgs, cfg: ReadonlyConfig): BenchmarkOptions {
  const options: BenchmarkOptions = {
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

  if (process.env.HOST) {
    options.host = process.env.HOST;
    console.log(`INFO: Using host ${options.host} instead of localhost`);
  }

  return options;
}

async function main() {
  console.error("PLEASE MAKE SURE THAT YOUR MOUSE IS OUTSIDE OF THE BROWSER WINDOW - and sorry for shouting :-) ");

  // 1. Parse CLI arguments
  const args = parseArgs(process.argv);
  console.log("args", args);

  // 2. Resolve runner type
  const runner = resolveRunner(args.runner);

  // 3. Build config (with overrides from CLI)
  let configOverrides: Partial<Config> = {
    BENCHMARK_RUNNER: runner,
    PUPPETEER_WAIT_MS: args.puppeteerSleep ?? 0,
  };

  if (args.count) {
    configOverrides.NUM_ITERATIONS_FOR_BENCHMARK_CPU_DROP_SLOWEST_COUNT = 0;
  }

  // 4. Handle smoketest mode
  if (args.smoketest) {
    configOverrides = {
      ...configOverrides,
      WRITE_RESULTS: false,
      EXIT_ON_ERROR: true,
      NUM_ITERATIONS_FOR_BENCHMARK_CPU_DROP_SLOWEST_COUNT: 0,
    };
    cpuBenchmarkInfosArray.forEach((b) => {
      b.additionalNumberOfRuns = 0;
    });
  }

  const cfg = createConfig(configOverrides);

  // Also update the global config for backward compatibility
  setGlobalConfig({ ...cfg });

  console.log("HEADLESS***", args.headless);

  // 5. Build benchmark options
  let benchmarkOptions = buildBenchmarkOptions(args, cfg);

  if (args.count) {
    benchmarkOptions.numIterationsForCPUBenchmarks = args.count;
    benchmarkOptions.numIterationsForMemBenchmarks = args.count;
    benchmarkOptions.numIterationsForStartupBenchmark = args.count;
  }

  if (args.smoketest) {
    benchmarkOptions.numIterationsForCPUBenchmarks = 1;
    benchmarkOptions.numIterationsForMemBenchmarks = 1;
    benchmarkOptions.numIterationsForStartupBenchmark = 1;
    console.log("Using smoketest config", JSON.stringify(cfg));
  }

  if (cfg.BENCHMARK_RUNNER === BenchmarkRunner.WEBDRIVER_AFTERFRAME) {
    benchmarkOptions.resultsDirectory = "results_client_" + benchmarkOptions.browser;
  }

  console.log("benchmarkOptions", benchmarkOptions);

  // 6. Initialize and filter frameworks
  let allArgs = args._.length <= 2 ? [] : args._.slice(2);
  let frameworkArg: (string | number)[] = args.framework ? args.framework : allArgs;

  const matchesDirectoryArg = (directoryName: string) =>
    frameworkArg.length === 0 || frameworkArg.some((arg) => String(arg) === directoryName);
  const frameworks = await initializeFrameworks(benchmarkOptions, matchesDirectoryArg, cfg);
  const runFrameworks = filterFrameworks(frameworks, frameworkArg, args.type, runner);

  // 7. Filter benchmarks
  let benchmarkArg: (string | number)[] = args.benchmark && args.benchmark.length > 0 ? args.benchmark : [];
  const runBenchmarks = filterBenchmarks(benchmarkInfos, benchmarkArg, runner);

  // 8. Ensure directories exist
  if (!fs.existsSync(benchmarkOptions.resultsDirectory)) fs.mkdirSync(benchmarkOptions.resultsDirectory);
  if (!fs.existsSync(benchmarkOptions.tracesDirectory)) fs.mkdirSync(benchmarkOptions.tracesDirectory);

  // 9. Run benchmarks
  if (!args.help) {
    return runBench(cfg, runFrameworks, runBenchmarks, benchmarkOptions);
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
