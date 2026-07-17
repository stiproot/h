// Headless driver for the viz (bun + playwright):
//   bun scripts/snap.js <url> <out.png> [--click "<node label>"] [--settle <ms>]
//
// Loads the page, waits `--settle` ms (default 9000 — one data sweep + force-layout settle),
// optionally clicks the graph node whose label contains the given text (opens the details
// panel), and writes a PNG. Also the seed of E2E coverage: everything here goes through the
// same selectors a user's click does.
import { chromium } from "playwright";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const [url, out] = positional;
if (!url || !out) {
  console.error('usage: bun scripts/snap.js <url> <out.png> [--click "<node label>"] [--settle <ms>]');
  process.exit(1);
}
const settle = Number(flag("settle") ?? 9000);
const clickText = flag("click");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(settle);
if (clickText) {
  await page.locator("g.node", { hasText: clickText }).first().click();
  await page.waitForTimeout(800);
}
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}${clickText ? ` (clicked "${clickText}")` : ""}`);
