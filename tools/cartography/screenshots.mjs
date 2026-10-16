#!/usr/bin/env node
// Headless screenshot capture for the Cartography Spine v0 evaluation package.
// Renders the BUILT atlas HTML in headless Chromium and captures the nine named views as PNGs.
// Run from client/ so the bare `playwright` import resolves: cd client && node ../tools/estate-map/cartography/screenshots.mjs <atlas.html> <out-dir>
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Resolve Playwright from the client workspace's node_modules (it is a client dev-dep, not a
// root/tools dep) so this script runs regardless of the caller's cwd.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const requireFromClient = createRequire(path.join(REPO_ROOT, 'client', 'package.json'));
// The client workspace ships Playwright as @playwright/test (which re-exports chromium).
const { chromium } = requireFromClient('@playwright/test');

const VIEWS = [
  ['01-root-default', 'view-root-default'],
  ['02-root-event-flow', 'view-root-event-flow'],
  ['03-root-coupling-matrix', 'view-root-coupling-matrix'],
  ['04-unknown-frontier', 'view-unknown-frontier'],
  ['05-context-interior', 'view-context-interior'],
  ['06-component-contract', 'view-component-contract'],
  ['07-module-dsm', 'view-module-dsm'],
  ['08-node-dossier', 'view-node-dossier'],
  ['09-build-diff', 'view-build-diff'],
];

const [htmlPath, outDir] = process.argv.slice(2);
if (!htmlPath || !outDir) { console.error('usage: screenshots.mjs <atlas.html> <out-dir>'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { waitUntil: 'load' });
const captured = [];
for (const [name, id] of VIEWS) {
  const el = page.locator(`#${id}`);
  await el.scrollIntoViewIfNeeded();
  await el.screenshot({ path: path.join(outDir, `${name}.png`) });
  captured.push(name);
}
await browser.close();
console.log(JSON.stringify({ captured, environment: { engine: 'chromium', viewport: '1440x900', headless: true } }, null, 2));
