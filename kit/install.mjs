#!/usr/bin/env node
// Put the factory's scripts into a project, where its agents can run them.
//
//   node <factory clone>/kit/install.mjs <project root> [--dir scripts/factory] [--force]
//
// Copies the scripts (not their tests) and writes a starter
// factory.config.json when the project has none. Rerun after pulling a newer
// factory to update the scripts; a script the project has edited is left alone
// and reported, unless --force.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_FILE, DEFAULTS } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const force = args.includes('--force');
const dirFlag = args.indexOf('--dir');
const target = args.find((arg, index) => !arg.startsWith('--') && (dirFlag < 0 || index !== dirFlag + 1));
if (!target || !existsSync(target)) {
  console.error('usage: install.mjs <project root> [--dir scripts/factory] [--force]');
  process.exit(2);
}
const relative = dirFlag >= 0 ? args[dirFlag + 1] : 'scripts/factory';
const destination = path.join(target, relative);
mkdirSync(destination, { recursive: true });

const manifestPath = path.join(destination, '.installed.json');
const installed = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const next = {};
for (const file of readdirSync(here).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && name !== 'install.mjs')) {
  const source = readFileSync(path.join(here, file), 'utf8');
  const to = path.join(destination, file);
  // Edited since we installed it: the project owns that change.
  if (existsSync(to) && !force && installed[file] !== undefined && readFileSync(to, 'utf8') !== installed[file] && readFileSync(to, 'utf8') !== source) {
    console.log(`kept      ${path.join(relative, file)} (edited in this project; --force overwrites)`);
    next[file] = installed[file];
    continue;
  }
  copyFileSync(path.join(here, file), to);
  next[file] = source;
  console.log(`installed ${path.join(relative, file)}`);
}
writeFileSync(manifestPath, `${JSON.stringify(next)}\n`);

const configPath = path.join(target, CONFIG_FILE);
if (!existsSync(configPath)) {
  const { bb, ...starter } = DEFAULTS;
  writeFileSync(configPath, `${JSON.stringify(starter, null, 2)}\n`);
  console.log(`wrote     ${CONFIG_FILE} (defaults: set baseBranch, plansDir, ci.check and tracker for this project)`);
} else {
  console.log(`kept      ${CONFIG_FILE}`);
}
