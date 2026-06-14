import { Config, ErrorAndWarning, FrameworkData, BenchmarkOptions, config as defaultConfig, setGlobalConfig } from "./common.js";

/**
 * Shared IPC message shape sent from main process to forked runner.
 */
export interface ForkedRunnerMessage {
  config: Config;
  framework: FrameworkData;
  benchmarkId: string;
  benchmarkOptions: BenchmarkOptions;
}

/**
 * Convert any error value into a human-readable string.
 * Shared across all forked runners.
 */
export function convertError(error: unknown): string {
  console.log(
    "ERROR in run Benchmark: |",
    error,
    "| type:",
    typeof error,
    "instance of Error",
    error instanceof Error,
    "Message:",
    error instanceof Error ? error.message : undefined
  );
  if (typeof error === "string") {
    console.log("Error is string");
    return error;
  } else if (error instanceof Error) {
    console.log("Error is instanceof Error");
    return error.message;
  } else {
    console.log("Error is unknown type");
    return String(error);
  }
}

/**
 * Execute a benchmark in the forked runner process and send results back to the main process.
 * This is the shared entry point that all forked runners use.
 *
 * @param runnerName - Human-readable name of this runner (for log messages)
 * @param executeBenchmark - The runner-specific benchmark execution function
 */
export function startForkedRunner(
  runnerName: string,
  executeBenchmark: (
    framework: FrameworkData,
    benchmarkId: string,
    benchmarkOptions: BenchmarkOptions
  ) => Promise<ErrorAndWarning<any>>
): void {
  process.on("message", (msg: ForkedRunnerMessage) => {
    // Update the global config from the main process
    setGlobalConfig(msg.config);
    console.log(`START BENCHMARK [${runnerName}]. Write results?`, msg.config.WRITE_RESULTS);

    const { framework, benchmarkId, benchmarkOptions } = msg;

    executeBenchmark(framework, benchmarkId, benchmarkOptions)
      .then((result) => {
        process.send!(result);
        process.exit(0);
      })
      .catch((error) => {
        console.log(`CATCH: Error in ${runnerName}`);
        process.send!({ error: convertError(error) });
        process.exit(0);
      });
  });
}
