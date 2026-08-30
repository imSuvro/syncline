// Records docs/media/revoke.gif: the revoke moment against a running demo,
// driving two isolated browser contexts (= two devices) and compositing
// their viewports side by side into an animated GIF.
//
// Deliberately not a workspace package — its dependencies are heavy and
// only needed to regenerate one image. To run it:
//
//   mkdir /tmp/rec && cd /tmp/rec
//   npm init -y && npm i playwright gifenc pngjs && npx playwright install chromium
//   cp <repo>/scripts/record-revoke.mjs .
//   # serve the demo somewhere (pnpm --filter syncline-demo dev), then:
//   DEMO_URL=http://localhost:5173 OUT=revoke.gif node record-revoke.mjs
//
// The scene assumes Maya is a member of Acme Launch; if a previous run
// revoked her, re-invite her first (as Priya, in the app).
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { writeFileSync } from 'node:fs';

const BASE = process.env.DEMO_URL ?? 'http://localhost:4173';
// Wider than the 720px breakpoint so both panes render the desktop layout
// (sidebar beside the list, not stacked above it).
const PANE = { width: 830, height: 620 };
const LABEL_H = 34;
const GAP = 10;
const OUT_W = PANE.width * 2 + GAP;
const OUT_H = PANE.height + LABEL_H;

const frames = []; // { rgba: Uint8Array, delay: number }
const stamps = []; // ms since the revoke click, for verifying the cascade

/** Draw a filled rect into an RGBA buffer. */
const fill = (buf, w, x0, y0, x1, y1, [r, g, b]) => {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
};

/** Blit a decoded PNG into the composite at (dx, dy). */
const blit = (dst, dstW, src, srcW, srcH, dx, dy) => {
  for (let y = 0; y < srcH; y++) {
    const dRow = ((y + dy) * dstW + dx) * 4;
    const sRow = y * srcW * 4;
    dst.set(src.subarray(sRow, sRow + srcW * 4), dRow);
  }
};

// A 5x7 pixel font, enough for the two pane labels. Keeps the recorder
// dependency-free rather than pulling in a canvas stack for 20 characters.
const GLYPHS = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  C: ['01110','10001','10000','10000','10000','10001','01110'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','11011','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  '(': ['00110','01000','10000','10000','10000','01000','00110'],
  ')': ['11000','00100','00010','00010','00010','00100','11000'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
};

const drawText = (buf, w, text, x0, y0, scale, [r, g, b]) => {
  let cx = x0;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' '];
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        fill(buf, w, cx + gx * scale, y0 + gy * scale, cx + (gx + 1) * scale, y0 + (gy + 1) * scale, [r, g, b]);
      }
    }
    cx += 6 * scale;
  }
};

const composite = (leftPng, rightPng) => {
  const buf = new Uint8Array(OUT_W * OUT_H * 4);
  fill(buf, OUT_W, 0, 0, OUT_W, OUT_H, [16, 18, 22]); // page ground
  const left = PNG.sync.read(leftPng);
  const right = PNG.sync.read(rightPng);
  blit(buf, OUT_W, left.data, left.width, Math.min(left.height, PANE.height), 0, LABEL_H);
  blit(buf, OUT_W, right.data, right.width, Math.min(right.height, PANE.height), PANE.width + GAP, LABEL_H);
  drawText(buf, OUT_W, 'PRIYA (OWNER)', 14, 11, 2, [124, 147, 255]);
  drawText(buf, OUT_W, 'MAYA (EDITOR)', PANE.width + GAP + 14, 11, 2, [52, 211, 153]);
  return buf;
};

const capture = async (pageL, pageR, delay) => {
  const [l, r] = await Promise.all([pageL.screenshot({ type: 'png' }), pageR.screenshot({ type: 'png' })]);
  frames.push({ rgba: composite(l, r), delay });
  process.stdout.write('.');
};

const signIn = async (page, name) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('button.person', { hasText: name }).click();
  await page.waitForSelector('.issue', { timeout: 30000 });
  await page.waitForTimeout(1200);
};

const run = async () => {
  const browser = await chromium.launch();
  // Separate contexts => separate localStorage and IndexedDB => two devices.
  const ctxA = await browser.newContext({ viewport: PANE, deviceScaleFactor: 1, colorScheme: 'dark' });
  const ctxB = await browser.newContext({ viewport: PANE, deviceScaleFactor: 1, colorScheme: 'dark' });
  const priya = await ctxA.newPage();
  const maya = await ctxB.newPage();

  await signIn(priya, 'Priya');
  await signIn(maya, 'Maya');

  // Maya may hold several workspaces; make sure she is looking at Acme.
  const acme = maya.locator('.ws-item', { hasText: 'Acme' });
  if (await acme.count()) {
    await acme.click();
    await maya.waitForTimeout(2500);
  }
  await maya.waitForSelector('.issue');

  console.log('\nboth live, recording');
  await capture(priya, maya, 900);
  await capture(priya, maya, 700);

  // Priya opens the confirm dialog.
  const mayaRow = priya.locator('.member', { hasText: 'Maya' });
  await mayaRow.locator('.revoke-btn').click();
  await priya.waitForSelector('.modal');
  await capture(priya, maya, 1100);
  await capture(priya, maya, 900);

  // The revoke itself, then a dense burst through Maya's dissolve.
  const t0 = Date.now();
  await priya.locator('.modal .btn.danger').click();

  // Two frames of Priya's side reacting, then wait for the forget to
  // actually reach Maya. Capturing on a fixed timer misses the cascade
  // entirely — the round trip is ~1s and the animation only ~0.9s.
  await capture(priya, maya, 260);
  await capture(priya, maya, 260);
  await maya.waitForSelector('.issue.dissolving', { timeout: 20000 });
  stamps.push(Date.now() - t0);
  for (let i = 0; i < 11; i++) {
    await capture(priya, maya, 100);
    stamps.push(Date.now() - t0);
  }
  await maya.waitForSelector('.removed-card', { timeout: 15000 });
  await capture(priya, maya, 500);
  await capture(priya, maya, 2800); // hold on the result

  await browser.close();

  // --- encode -------------------------------------------------------------
  console.log(`\nencoding ${frames.length} frames at ${OUT_W}x${OUT_H}`);
  const gif = GIFEncoder();
  // One palette for the whole clip: the UI is a fixed set of flat colors, so
  // a shared palette avoids inter-frame flicker and shrinks the file.
  const sample = new Uint8Array(frames.length * 4 * 6000);
  frames.forEach((f, i) => {
    const stride = Math.max(4, Math.floor(f.rgba.length / 4 / 6000) * 4);
    let o = i * 4 * 6000;
    for (let p = 0; p < f.rgba.length && o < (i + 1) * 4 * 6000; p += stride, o += 4) {
      sample.set(f.rgba.subarray(p, p + 4), o);
    }
  });
  const palette = quantize(sample, 128, { format: 'rgb444' });
  for (const f of frames) {
    gif.writeFrame(applyPalette(f.rgba, palette, 'rgb444'), OUT_W, OUT_H, {
      palette,
      delay: f.delay,
      transparent: false,
    });
  }
  gif.finish();
  const bytes = gif.bytes();
  writeFileSync(process.env.OUT ?? 'revoke.gif', bytes);
  console.log(`wrote ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
  console.log('burst timing (ms after click):', stamps.join(', '));

  // Dump a few frames so the cascade can be eyeballed without a GIF player.
  for (const idx of [5, 7, 9, 11, frames.length - 1]) {
    const f = frames[idx];
    if (!f) continue;
    const png = new PNG({ width: OUT_W, height: OUT_H });
    png.data = Buffer.from(f.rgba);
    writeFileSync(`frame-${idx}.png`, PNG.sync.write(png));
  }
};

run().catch((e) => { console.error(e); process.exit(1); });
