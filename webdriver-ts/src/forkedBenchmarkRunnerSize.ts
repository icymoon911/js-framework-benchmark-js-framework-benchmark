import { Browser, Page } from "puppeteer-core";
import { SizeInfoJSON } from "./benchmarksCommon.js";
import { BenchmarkSize, SizeBenchmarkResult, benchmarks } from "./benchmarksSize.js";
import { BenchmarkOptions, Config, ErrorAndWarning, FrameworkData } from "./common.js";
import { checkElementContainsText, checkElementExists, clickElement, startBrowser } from "./puppeteerAccess.js";
import { convertError, setupForkedRunner } from "./forkedRunnerCommon.js";

async function runSizeBenchmark(
  framework: FrameworkData,
  benchmarks: BenchmarkSize,
  benchmarkOptions: BenchmarkOptions,
  cfg: Readonly<Config>
): Promise<ErrorAndWarning<SizeBenchmarkResult>> {
  let warnings: string[] = [];
  let results: SizeBenchmarkResult[] = [];

  console.log("size benchmarking", framework);
  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    browser = await startBrowser(benchmarkOptions);
    page = await browser.newPage();
    page.on("console", (msg) => {
      for (let i = 0; i < msg.args().length; ++i) console.log(`BROWSER: ${msg.args()[i]}`);
    });
    for (let i = 0; i < benchmarkOptions.batchSize; i++) {
      let enableCompressionResponse = await fetch(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/enableCompression`);
      if (enableCompressionResponse.status !== 200) throw new Error("Could not enable compression");
      if (await enableCompressionResponse.text() !== "OK") throw new Error("Could not enable compression - OK missing");

      await page.goto(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`, {
        waitUntil: "networkidle0",
      });

      await checkElementExists(page, "pierce/#run");
      await clickElement(page, "pierce/#run");
      await checkElementContainsText(page, "pierce/tbody>tr:nth-of-type(1)>td:nth-of-type(1)", (i*1000+1).toFixed());

      let paintEvents = JSON.parse(await page.evaluate(`JSON.stringify(performance.getEntriesByType("paint"))`) as string);
      console.log("paintEvents", paintEvents);

      let sizeInfoResponse = await fetch(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/sizeInfo`);
      if (sizeInfoResponse.status !== 200) throw new Error("Could not enable compression");
      let sizeInfo = (await sizeInfoResponse.json()) as SizeInfoJSON;
      console.log("sizeInfo", sizeInfo);
      sizeInfo.fp = paintEvents.find((e: any) => e.name === "first-paint").startTime;

      results = benchmarks.subbenchmarks.map((b) => ({
          benchmark: b,
          result: b.fn(sizeInfo)
        }));
    }
    return { error: undefined, warnings, result: results };
  } catch (error) {
    console.log("ERROR", error);
    return { error: convertError(error), warnings };
  } finally {
    let disableCompressionResponse = await fetch(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/disableCompression`);
    if (disableCompressionResponse.status !== 200) console.log("ERROR - Could not disable compression");
    if (await disableCompressionResponse.text() !== "OK") console.log("ERROR - Could not disable compression - OK missing");
    try {
      if (browser) {
        await browser.close();
      }
    } catch (error) {
      console.log("ERROR cleaning up driver", error);
    }
  }
}

async function executeBenchmark(
  framework: FrameworkData,
  benchmarkId: string,
  benchmarkOptions: BenchmarkOptions,
  cfg: Readonly<Config>
): Promise<ErrorAndWarning<any>> {
  let runBenchmarks: Array<BenchmarkSize> = benchmarks.filter(
    (b) =>
      benchmarkId === b.benchmarkInfo.id && (b instanceof BenchmarkSize)
  ) as Array<BenchmarkSize>;
  if (runBenchmarks.length != 1) throw `Benchmark name ${benchmarkId} is not unique (size)`;

  let benchmark = runBenchmarks[0];
  return await runSizeBenchmark(framework, benchmark, benchmarkOptions, cfg);
}

setupForkedRunner("Size", executeBenchmark);
