import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDashboardUserService } from '../tools/dashboard-user-service.mjs';

test('dashboard user service renders an absolute non-destructive runtime command', () => {
  const rendered = renderDashboardUserService({ checkout: '/opt/estate-map-runner' });
  assert.match(rendered, /^WorkingDirectory=\/opt\/estate-map-runner$/mu);
  assert.match(rendered, /^EnvironmentFile=\/opt\/estate-map-runner\/\.env$/mu);
  assert.match(rendered, /^ExecStart=\/usr\/bin\/env node \/opt\/estate-map-runner\/tools\/estate-dashboard-server\.mjs --runtime-config \/opt\/estate-map-runner\/ascrybe\.config\.json$/mu);
  assert.match(rendered, /^Restart=on-failure$/mu);
  assert.match(rendered, /^WantedBy=default\.target$/mu);
  assert.equal(/sudo|--promote|projection|secret/i.test(rendered), false);
});
