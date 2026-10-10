import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repoFile = path => new URL(`../${path}`, import.meta.url);
test('workflow gates Pages on tests plus real source validation and uses only the bounded public artifact', async () => {
  const workflow = await readFile(repoFile('.github/workflows/publish.yml'), 'utf8').catch(() => '');
  assert.ok(workflow, 'publishing workflow must exist');
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cron: '7,22,37,52 \* \* \* \*'/);
  assert.match(workflow, /concurrency:\s*\n\s*group: public-data-pages\s*\n\s*cancel-in-progress: false/);
  for (const permission of ['contents', 'pages', 'id-token']) assert.match(workflow, new RegExp(`${permission}: write`));
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7/);
  assert.match(workflow, /node-version: 'lts\/\*'/);
  const tests = workflow.indexOf('node --test test/*.test.mjs');
  const fetch = workflow.indexOf('run: node scripts/sync-data.mjs\n');
  const validate = workflow.indexOf('run: node scripts/sync-data.mjs --validate');
  const upload = workflow.indexOf('uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5');
  const deploy = workflow.indexOf('uses: actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5');
  const actions = [...workflow.matchAll(/uses: (\S+)/g)].map(match => match[1]);
  assert.equal(actions.length, 4);
  assert.ok(actions.every(action => /^actions\/[a-z-]+@[a-f0-9]{40}$/.test(action)), 'every action must have a reviewed immutable full-SHA pin');
  assert.ok(tests >= 0 && fetch > tests && validate > fetch && upload > validate && deploy > upload);
  assert.match(workflow, /PUBLIC_DATA_SOURCE_URL: \$\{\{ vars\.PUBLIC_DATA_SOURCE_URL \}\}/);
  assert.match(workflow, /path: public\//);
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /git add -- public\/jeju\.json public\/national\.json public\/index\.html public\/\.nojekyll public\/health\.json/);
  assert.match(workflow, /git diff --cached --quiet/);
  assert.match(workflow, /git push origin HEAD:main/);
  const lastValidate = workflow.lastIndexOf('run: node scripts/sync-data.mjs --validate');
  assert.ok(lastValidate > workflow.indexOf('git push origin HEAD:main') && lastValidate < upload, 'revalidate after commit and immediately before public-only upload');
  assert.doesNotMatch(workflow, /git add (?:-A|\.)|force|secrets\.(?!GITHUB_TOKEN)|continue-on-error|if:.*changed/);
  const afterUpload = workflow.slice(upload);
  assert.doesNotMatch(afterUpload, /if:/, 'unchanged valid assets still deploy');
  assert.match(workflow, /name: github-pages/);
  const ignores = await readFile(repoFile('.gitignore'), 'utf8');
  assert.match(ignores, /^\/public\/status\.json$/m, 'per-fetch status is deployed, not committed');
  assert.doesNotMatch(ignores, /^\/public\/health\.json$/m, 'daily heartbeat must be tracked');
});

test('README documents the actual Reader contract and reviewed immutable action pins', async () => {
  const readme = await readFile(repoFile('README.md'), 'utf8');
  for (const contract of [
    '`no`: safe integer **>= 2**, unique within each region',
    '`nameVerified`: confirmed-name string',
    '`rating`: formatted display string',
    '`verifiedAt`: date/display string',
    '`score`: finite JSON number in **(0,10]**',
    'not a complete secret scanner',
  ]) assert.ok(readme.includes(contract), contract);
  for (const sha of ['3d3c42e5aac5ba805825da76410c181273ba90b1', '949feb2413d6458794dcd2491c4babbbce0c15c1', 'fc324d3547104276b827a68afc52ff2a11cc49c9', '368f82528645a54fb793d4d04e342629a3f51346']) assert.ok(readme.includes(sha), sha);
});
