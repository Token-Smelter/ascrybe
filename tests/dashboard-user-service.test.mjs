import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDashboardUserService } from '../tools/dashboard-user-service.mjs';

test('dashboard user service renders an absolute non-destructive runtime command', () => {
  const rendered = renderDashboardUserService({ checkout: '/opt/ascrybe' });
  assert.match(rendered, /^WorkingDirectory=\/opt\/ascrybe$/mu);
  assert.match(rendered, /^EnvironmentFile=\/opt\/ascrybe\/\.env$/mu);
  assert.match(rendered, /^ExecStart=\/usr\/bin\/env node \/opt\/ascrybe\/tools\/estate-dashboard-server\.mjs --runtime-config \/opt\/ascrybe\/ascrybe\.config\.json$/mu);
  assert.match(rendered, /^Restart=on-failure$/mu);
  assert.match(rendered, /^WantedBy=default\.target$/mu);
  assert.equal(/sudo|--promote|projection|secret/i.test(rendered), false);
});
