import { readFile } from "node:fs/promises";

/**
 * Read a Chrome trace/DevTools performance log JSON file
 * and return the `traceEvents` array.
 */
export async function readTraceFile(fileName: string): Promise<any[]> {
  const contents = await readFile(fileName, { encoding: "utf8" });
  const json = JSON.parse(contents);
  return json["traceEvents"];
}
