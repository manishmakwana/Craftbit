#!/usr/bin/env node
/**
 * Measures achieved frame rate while simulating a viewport orbit drag.
 * M0 skeleton for the perf harness described in spec §8 / perf/README.md.
 *
 * Usage: node perf/measure-fps.mjs <url> [durationMs]
 */
import { chromium } from "playwright";

const url = process.argv[2];
const durationMs = Number(process.argv[3] ?? 2000);

if (!url) {
  console.error("Usage: node perf/measure-fps.mjs <url> [durationMs]");
  process.exit(1);
}

const launchOptions = {
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"],
};
if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
}

const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page
    .waitForFunction(() => !document.querySelector(".loading-overlay"), { timeout: 25000 })
    .catch(() => {
      console.warn("Warning: loading overlay never disappeared; measuring anyway.");
    });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.__frameCount = 0;
    const tick = () => {
      window.__frameCount++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("No <canvas> found in the page.");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const start = Date.now();
  let t = 0;
  while (Date.now() - start < durationMs) {
    t += 4;
    await page.mouse.move(cx + Math.sin(t / 30) * 200, cy + Math.cos(t / 30) * 100);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();

  const frames = await page.evaluate(() => window.__frameCount);
  const elapsedMs = Date.now() - start;
  const fps = (frames / elapsedMs) * 1000;

  console.log(JSON.stringify({ url, frames, elapsedMs, fps: Number(fps.toFixed(1)) }, null, 2));

  const BUDGET_FPS = 60;
  if (fps < BUDGET_FPS * 0.9) {
    console.error(`Below budget: ${fps.toFixed(1)} fps (target ${BUDGET_FPS} fps, spec §8)`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
