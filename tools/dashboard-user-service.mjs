#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_UNIT_NAME = 'ascrybe-dashboard.service';

function unitValue(path) {
  if (!path.startsWith('/')) throw new Error(`systemd paths must be absolute: ${path}`);
  return path.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

export function renderDashboardUserService({ checkout = root } = {}) {
  const absoluteCheckout = resolve(checkout);
  const runtimeConfig = join(absoluteCheckout, 'ascrybe.config.json');
  const environmentFile = join(absoluteCheckout, '.env');
  const server = join(absoluteCheckout, 'tools', 'estate-dashboard-server.mjs');
  return `[Unit]\nDescription=Ascrybe dashboard\n\n[Service]\nType=simple\nWorkingDirectory=${unitValue(absoluteCheckout)}\nEnvironmentFile=${unitValue(environmentFile)}\nExecStart=/usr/bin/env node ${unitValue(server)} --runtime-config ${unitValue(runtimeConfig)}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}

export function installDashboardUserService({ checkout = root, environment = process.env, unitName = DEFAULT_UNIT_NAME } = {}) {
  const directory = join(environment.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
  const unitPath = join(directory, unitName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(unitPath, renderDashboardUserService({ checkout }), { mode: 0o644 });
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  return { unit_path: unitPath, manual_enable: `systemctl --user enable --now ${unitName}`, manual_remove: `rm ${unitPath} && systemctl --user daemon-reload` };
}

export function runDashboardUserServiceCli(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === '--render') return renderDashboardUserService({ checkout: argv[1] || root });
  if (argv[0] === '--install') return JSON.stringify(installDashboardUserService({ checkout: argv[1] || root }), null, 2);
  throw new Error('usage: dashboard-user-service [--render [checkout] | --install [checkout]]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(runDashboardUserServiceCli()); }
  catch (error) { console.error(`dashboard user service: ${error.message}`); process.exitCode = 1; }
}
