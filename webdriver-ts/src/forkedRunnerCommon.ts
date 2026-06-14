import { Config, ErrorAndWarning, FrameworkData, BenchmarkOptions } from "./common.js";

/**
 * Convert an unknown error type to a string for reporting.
 * Shared across all forked benchmark runners.
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
    (error as any)?.message
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
 * Message sent from the main process to a forked runner via IPC.
 */
export interface ForkedRunnerMessage {
  config: Readonly<Config>;
  framework: FrameworkData;
  benchmarkId: string;
  benchmarkOptions: BenchmarkOptions;
}

/**
 * Generic IPC message handler for forked benchmark runners.
 * Each runner calls this in its entry point, providing its own
 * `executeBenchmark` implementation.
 */
export function setupForkedRunner<T>(
  runnerName: string,
  executeBenchmark: (
    framework: FrameworkData,
    benchmarkId: string,
    benchmarkOptions: BenchmarkOptions,
    config: Readonly<Config>
  ) => Promise<ErrorAndWarning<T>>
): void {
  process.on("message", (msg: ForkedRunnerMessage) => {
    const receivedConfig: Readonly<Config> = Object.freeze({ ...msg.config });
    console.log(`START ${runnerName} BENCHMARK. Write results?`, receivedConfig.WRITE_RESULTS);

    const { framework, benchmarkId, benchmarkOptions } = msg;

    executeBenchmark(framework, benchmarkId, benchmarkOptions, receivedConfig)
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
