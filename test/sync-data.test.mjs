import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, readdir, stat, writeFile, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

// Synthetic fixtures stay in tests, never in public/ or deployed artifacts.
const fixtureRow = () => ({
  no: 2, type: '식당', name: '테스트', nameVerified: '테스트 확인 상호',
  address: '제주', subregion: '', sido: '제주', sigungu: '', menu: '',
  score: 8.8, status: '', confidence: 'high', rating: '4.5 / 5', review: '', note: '',
  closedDays: '', hours: '', lat: 33.4, lng: 126.5, verifiedAt: '', category: '',
});
const fixtureSource = () => ({ schemaVersion: 1, exportedAt: '2026-10-09T00:00:00.000Z',
  regions: { JEJU: [fixtureRow()], NATIONAL: [] } });
async function implementation() {
  const module = await import('../scripts/sync-data.mjs').catch(() => null);
  assert.ok(module?.syncData, 'publisher syncData must exist');
  return module;
}
async function sandbox(t) {
  // TMPDIR is the profile scratch directory in this environment.
  const root = await mkdtemp(join(tmpdir(), 'publisher-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'public');
}
async function server(t, handler) {
  const s = createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { s.close(resolve); s.closeAllConnections(); }));
  return `http://127.0.0.1:${s.address().port}`;
}
function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function options(sourceUrl, publicDir, extra = {}) {
  return { sourceUrl, publicDir, allowInsecureLocalhost: true, ...extra };
}

test('preserves GAS confirmed-name text instead of requiring a boolean', async t => {
  const { syncData } = await implementation();
  const publicDir = await sandbox(t);
  const body = fixtureSource();
  body.regions.JEJU[0].nameVerified = '확인된 상호 (합성 테스트)';
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  assert.equal(JSON.parse(await readFile(join(publicDir, 'jeju.json'), 'utf8')).rows[0].nameVerified, body.regions.JEJU[0].nameVerified);
});

test('preserves GAS formatted rating text without numeric coercion', async t => {
  const { syncData } = await implementation();
  const publicDir = await sandbox(t);
  const body = fixtureSource();
  body.regions.JEJU[0].rating = '4.5 / 5 (합성 후기 123개)';
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  assert.equal(JSON.parse(await readFile(join(publicDir, 'jeju.json'), 'utf8')).rows[0].rating, body.regions.JEJU[0].rating);
});

test('preserves GAS display dates including empty verifiedAt without ISO conversion or truncation', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  const body = fixtureSource();
  const url = await server(t, (_req, res) => sendJson(res, body));
  for (const value of ['2026. 10. 09', '2026-10-09', '2026년 10월 9일 현장 확인 (합성 표시 날짜)'.repeat(10), '']) {
    body.regions.JEJU[0].verifiedAt = value;
    await syncData(options(url, publicDir));
    assert.equal(JSON.parse(await readFile(join(publicDir, 'jeju.json'), 'utf8')).rows[0].verifiedAt, value);
    await validatePublicDirectory(publicDir);
  }
});

test('requires unique spreadsheet row ids >= 2 within each region, not across regions', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  body.regions.NATIONAL = [fixtureRow()];
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  const before = await fileBytes(publicDir);
  for (const region of ['JEJU', 'NATIONAL']) {
    for (const no of [1, 0, -1, 2.5, Number.MAX_SAFE_INTEGER + 1, '2', null, Infinity]) {
      body = fixtureSource(); body.regions[region] = [{ ...fixtureRow(), no }];
      await assert.rejects(syncData(options(url, publicDir)), /Validation failed: no/, `${region} ${no}`);
      assert.deepEqual(await fileBytes(publicDir), before);
    }
    body = fixtureSource(); body.regions[region] = [fixtureRow(), fixtureRow()];
    await assert.rejects(syncData(options(url, publicDir)), /Validation failed:.*unique/, region);
    assert.deepEqual(await fileBytes(publicDir), before);
    const file = region === 'JEJU' ? 'jeju.json' : 'national.json';
    const snapshot = JSON.parse(before[file]);
    snapshot.rows.push(fixtureRow());
    snapshot.version = createHash('sha256').update(JSON.stringify(snapshot.rows)).digest('hex');
    await writeFile(join(publicDir, file), JSON.stringify(snapshot));
    await assert.rejects(validatePublicDirectory(publicDir), /Validation failed:.*unique/);
    await writeFile(join(publicDir, file), before[file]);
  }
  body = fixtureSource();
  body.regions.JEJU.push({ ...fixtureRow(), no: Number.MAX_SAFE_INTEGER });
  body.regions.NATIONAL = [fixtureRow()];
  await syncData(options(url, publicDir));
  await validatePublicDirectory(publicDir);
});

test('requires finite numeric scores greater than zero and at most ten', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  const before = await fileBytes(publicDir);
  for (const score of [0, -0, -1, 10.01, 11, 100, null, '8.8', false, NaN, Infinity]) {
    body = fixtureSource(); body.regions.JEJU[0].score = score;
    await assert.rejects(syncData(options(url, publicDir)), /Validation failed: score/);
    assert.deepEqual(await fileBytes(publicDir), before);
    const snapshot = JSON.parse(before['jeju.json']);
    snapshot.rows[0].score = score;
    snapshot.version = createHash('sha256').update(JSON.stringify(snapshot.rows)).digest('hex');
    await writeFile(join(publicDir, 'jeju.json'), JSON.stringify(snapshot));
    await assert.rejects(validatePublicDirectory(publicDir), /Validation failed: score/);
    await writeFile(join(publicDir, 'jeju.json'), before['jeju.json']);
  }
  for (const score of [0.1, 8.8, 10]) {
    body = fixtureSource(); body.regions.JEJU[0].score = score;
    await syncData(options(url, publicDir));
    await validatePublicDirectory(publicDir);
    assert.equal(JSON.parse(await readFile(join(publicDir, 'jeju.json'), 'utf8')).rows[0].score, score);
  }
});

test('requires nonzero finite coordinates within geographic bounds in source and artifact', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  const before = await fileBytes(publicDir);
  for (const [lat, lng] of [[0, 126.5], [33.4, 0], [-0, -0], [null, null], [null, 126.5], [33.4, null], [91, 126.5], [-91, 126.5], [33.4, 181], [33.4, -181], ['33.4', 126.5], [33.4, '126.5'], [Infinity, 126.5], [33.4, NaN]]) {
    body = fixtureSource(); Object.assign(body.regions.JEJU[0], { lat, lng });
    await assert.rejects(syncData(options(url, publicDir)), /Validation failed: (lat|lng)/);
    assert.deepEqual(await fileBytes(publicDir), before);
    const snapshot = JSON.parse(before['jeju.json']);
    Object.assign(snapshot.rows[0], { lat, lng });
    snapshot.version = createHash('sha256').update(JSON.stringify(snapshot.rows)).digest('hex');
    await writeFile(join(publicDir, 'jeju.json'), JSON.stringify(snapshot));
    await assert.rejects(validatePublicDirectory(publicDir), /Validation failed: (lat|lng)/);
    await writeFile(join(publicDir, 'jeju.json'), before['jeju.json']);
  }
  for (const [lat, lng] of [[-90, -180], [90, 180], [-33.4, -126.5], [0.1, 0.1]]) {
    body = fixtureSource(); Object.assign(body.regions.JEJU[0], { lat, lng });
    await syncData(options(url, publicDir));
    await validatePublicDirectory(publicDir);
  }
});

test('rejects recognizable credential shapes inside approved text before writes or upload without logging values', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  const before = await fileBytes(publicDir);
  // Obviously synthetic, never copied credentials; exact provider-shaped lengths.
  const fake = length => 'SYNTHETICNONREALTOKEN'.repeat(20).slice(0, length);
  const google = `AIza${fake(35)}`;
  const tokens = [
    ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'].map(prefix => prefix + fake(36)),
    `ghs_${fake(200)}`, `github_pat_${fake(82)}`, google,
    `sk-${fake(20)}T3BlbkFJ${fake(20)}`,
    ...['proj', 'svcacct', 'admin'].flatMap(kind => [58, 74].map(length => `sk-${kind}-${fake(length)}T3BlbkFJ${fake(length)}`)),
  ];
  const fields = Object.keys(fixtureRow()).filter(key => typeof fixtureRow()[key] === 'string');
  const cases = [...fields.map(field => [field, google]), ...tokens.map(token => ['note', `합성 credential: "${token}"`])];
  for (const [field, value] of cases) {
    body = fixtureSource(); body.regions.JEJU[0][field] = value;
    await assert.rejects(syncData(options(url, publicDir)), error => {
      assert.match(error.message, /Validation failed:.*credential/);
      assert.ok(!error.message.includes(value), 'never log matched text');
      return true;
    }, field);
    assert.deepEqual(await fileBytes(publicDir), before);
    const snapshot = JSON.parse(before['jeju.json']);
    snapshot.rows[0][field] = value;
    snapshot.version = createHash('sha256').update(JSON.stringify(snapshot.rows)).digest('hex');
    await writeFile(join(publicDir, 'jeju.json'), JSON.stringify(snapshot));
    await assert.rejects(validatePublicDirectory(publicDir), /Validation failed:.*credential/);
    await writeFile(join(publicDir, 'jeju.json'), before['jeju.json']);
  }
  body = fixtureSource();
  body.regions.JEJU[0].note = 'API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, private_key are plain property labels; 사업자번호 123-45-67890; 전화 064-123-4567; 메뉴 15,000원.';
  await syncData(options(url, publicDir));
  await validatePublicDirectory(publicDir);
  assert.equal(JSON.parse(await readFile(join(publicDir, 'jeju.json'), 'utf8')).rows[0].note, body.regions.JEJU[0].note);
});

function hiddenArtifactCases(pristine) {
  const marker = 'SYNTHETIC_PRIVATE_FACTS_NOT_REAL';
  const credential = `AIza${'SYNTHETICNONREALTOKEN'.repeat(2).slice(0, 35)}`;
  const hide = (file, member, value, label) => ({ file, label,
    bytes: pristine[file].replace(member, `${value},\n${member}`) });
  return [
    hide('jeju.json', '"note": ""', '"note": 123', 'overwritten wrong scalar type'),
    hide('jeju.json', '"note": ""', `"note": {"privateFacts": "${marker}", "token": "${credential}"}`, 'overwritten private object'),
    hide('jeju.json', '"note": ""', `"note": "${credential}"`, 'overwritten credential text'),
    hide('jeju.json', '"note": ""', `"note": {"privateFacts": "${marker}", "privateFacts": "${credential}"}`, 'nested duplicate members'),
    hide('jeju.json', '"note": ""', `"no\\u0074e": {"privateFacts": "${marker}"}`, 'escaped duplicate member name'),
    hide('national.json', '"rows": []', `"rows": [{"privateFacts": "${marker}"}]`, 'overwritten top-level rows'),
    hide('status.json', '"rowCount": 1', `"rowCount": {"privateFacts": "${marker}"}`, 'overwritten nested status metadata'),
    hide('health.json', '"lastVerifiedAt":', `"lastVerifiedAt": {"privateFacts": "${marker}", "token": "${credential}"}`, 'overwritten health timestamp'),
  ];
}

test('pre-upload validation rejects hidden duplicate JSON members without exposing their contents', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  const url = await server(t, (_req, res) => sendJson(res, fixtureSource()));
  await syncData(options(url, publicDir));
  const pristine = await fileBytes(publicDir);
  for (const { file, bytes, label } of hiddenArtifactCases(pristine)) {
    await t.test(label, async () => {
      assert.deepEqual(JSON.parse(bytes), JSON.parse(pristine[file]), 'parsed data conceals raw duplicate members');
      await writeFile(join(publicDir, file), bytes);
      try {
        await assert.rejects(validatePublicDirectory(publicDir), error => {
          assert.match(error.message, /Validation failed:.*canonical/);
          assert.ok(!error.message.includes('SYNTHETIC'), 'error must not expose hidden values');
          return true;
        });
      } finally { await writeFile(join(publicDir, file), pristine[file]); }
    });
  }
});

test('a valid source repairs noncanonical snapshots instead of retaining hidden raw members', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  const url = await server(t, (_req, res) => sendJson(res, body));
  const run = () => syncData(options(url, publicDir, { now: () => new Date('2026-10-09T02:00:00.000Z') }));
  await run();
  const pristine = await fileBytes(publicDir);
  const cases = hiddenArtifactCases(pristine).filter(({ file }) => ['jeju.json', 'national.json'].includes(file));
  for (const { file, bytes, label } of cases) {
    await t.test(label, async () => {
      for (const [name, contents] of Object.entries(pristine)) await writeFile(join(publicDir, name), contents);
      await writeFile(join(publicDir, file), bytes);
      const before = await fileBytes(publicDir);
      const mtime = (await stat(join(publicDir, file))).mtimeMs;
      body = { error: 'synthetic failed export' };
      await assert.rejects(run());
      assert.deepEqual(await fileBytes(publicDir), before, 'failed source must not repair or erase old assets');
      assert.equal((await stat(join(publicDir, file))).mtimeMs, mtime);
      await assert.rejects(validatePublicDirectory(publicDir), /Validation failed:.*canonical/);
      body = fixtureSource();
      body.exportedAt = '2026-10-09T01:00:00.000Z';
      await run();
      const repaired = await readFile(join(publicDir, file), 'utf8');
      assert.ok(repaired !== bytes, 'hidden raw bytes must not survive a valid sync');
      assert.ok(!repaired.includes('SYNTHETIC') && !repaired.includes('privateFacts'), 'hidden content must be absent');
      const snapshot = JSON.parse(repaired);
      assert.equal(snapshot.version, JSON.parse(pristine[file]).version);
      assert.equal(snapshot.generatedAt, body.exportedAt, 'corrupt artifacts are regenerated from the validated source');
      assert.equal(repaired, `${JSON.stringify(snapshot, null, 2)}\n`);
      const untouched = file === 'jeju.json' ? 'national.json' : 'jeju.json';
      assert.equal(await readFile(join(publicDir, untouched), 'utf8'), pristine[untouched]);
      await validatePublicDirectory(publicDir);
    });
  }
});

test('a valid same-day source repairs hidden health metadata rather than retaining its raw bytes', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  let valid = true;
  const url = await server(t, (_req, res) => sendJson(res, valid ? fixtureSource() : { error: 'synthetic failed export' }));
  const run = at => syncData(options(url, publicDir, { now: () => new Date(at) }));
  await run('2026-10-09T01:00:00.000Z');
  const pristine = await fileBytes(publicDir);
  const mtimes = Object.fromEntries(await Promise.all(['jeju.json', 'national.json', 'index.html', '.nojekyll'].map(async file => [file, (await stat(join(publicDir, file))).mtimeMs])));
  const { bytes } = hiddenArtifactCases(pristine).find(({ file }) => file === 'health.json');
  await writeFile(join(publicDir, 'health.json'), bytes);
  const before = await fileBytes(publicDir);
  valid = false;
  await assert.rejects(run('2026-10-09T01:15:00.000Z'));
  assert.deepEqual(await fileBytes(publicDir), before);
  await assert.rejects(validatePublicDirectory(publicDir), /Validation failed:.*canonical/);
  valid = true;
  await run('2026-10-09T01:15:00.000Z');
  const repaired = await readFile(join(publicDir, 'health.json'), 'utf8');
  assert.ok(!repaired.includes('SYNTHETIC') && !repaired.includes('privateFacts'));
  assert.equal(JSON.parse(repaired).lastVerifiedAt, '2026-10-09T01:15:00.000Z');
  for (const [file, mtime] of Object.entries(mtimes)) {
    assert.equal(await readFile(join(publicDir, file), 'utf8'), pristine[file]);
    assert.equal((await stat(join(publicDir, file))).mtimeMs, mtime);
  }
  await validatePublicDirectory(publicDir);
});

test('a valid source rebuilds hidden status metadata without changing canonical snapshots', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  let valid = true;
  const url = await server(t, (_req, res) => sendJson(res, valid ? fixtureSource() : { error: 'synthetic failed export' }));
  await syncData(options(url, publicDir));
  const pristine = await fileBytes(publicDir);
  const { bytes } = hiddenArtifactCases(pristine).find(({ file }) => file === 'status.json');
  await writeFile(join(publicDir, 'status.json'), bytes);
  const before = await fileBytes(publicDir);
  valid = false;
  await assert.rejects(syncData(options(url, publicDir)));
  assert.deepEqual(await fileBytes(publicDir), before);
  await assert.rejects(validatePublicDirectory(publicDir), /Validation failed:.*canonical/);
  valid = true;
  await syncData(options(url, publicDir));
  const repaired = await readFile(join(publicDir, 'status.json'), 'utf8');
  assert.ok(!repaired.includes('SYNTHETIC') && !repaired.includes('privateFacts'));
  for (const file of ['jeju.json', 'national.json']) assert.equal(await readFile(join(publicDir, file), 'utf8'), pristine[file]);
  await validatePublicDirectory(publicDir);
});

test('follows ContentService-style redirects and publishes both snapshots plus status assets', async t => {
  const { syncData } = await implementation();
  const publicDir = await sandbox(t);
  const body = fixtureSource();
  const url = await server(t, (req, res) => {
    if (req.url === '/export') { res.writeHead(302, { Location: '/content' }); res.end(); }
    else sendJson(res, body);
  });
  await syncData(options(`${url}/export`, publicDir));
  const jeju = JSON.parse(await readFile(join(publicDir, 'jeju.json'), 'utf8'));
  const national = JSON.parse(await readFile(join(publicDir, 'national.json'), 'utf8'));
  assert.deepEqual(Object.keys(jeju), ['schemaVersion', 'region', 'version', 'generatedAt', 'rows']);
  assert.equal(jeju.region, 'JEJU');
  assert.deepEqual(jeju.rows, body.regions.JEJU);
  assert.equal(jeju.version, createHash('sha256').update(JSON.stringify(jeju.rows)).digest('hex'));
  assert.equal(jeju.generatedAt, body.exportedAt);
  assert.equal(national.region, 'NATIONAL');
  assert.deepEqual(national.rows, []);
  assert.match(await readFile(join(publicDir, 'index.html'), 'utf8'), /jeju\.json/);
  assert.equal(await readFile(join(publicDir, '.nojekyll'), 'utf8'), '');
  const status = JSON.parse(await readFile(join(publicDir, 'status.json'), 'utf8'));
  assert.equal(status.exportedAt, body.exportedAt);
  assert.equal(status.regions.JEJU.version, jeju.version);
});

test('preserves exactly the Reader public fields and bounded display strings without coercion or truncation', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  // Public Reader schema, not private implementation or production rows.
  const keys = 'no,type,name,nameVerified,address,subregion,sido,sigungu,menu,score,status,confidence,rating,review,note,closedDays,hours,lat,lng,verifiedAt,category'.split(',');
  const limits = { type: 64, name: 200, nameVerified: 2000, address: 2000, subregion: 200, sido: 200, sigungu: 200, menu: 10000, status: 200, confidence: 200, rating: 2000, review: 20000, note: 20000, closedDays: 2000, hours: 2000, verifiedAt: 2000, category: 200 };
  assert.deepEqual(Object.keys(body.regions.JEJU[0]), keys);
  for (const [key, limit] of Object.entries(limits)) body.regions.JEJU[0][key] = ` ${'합'.repeat(limit - 2)} `;
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  const before = await fileBytes(publicDir);
  const row = JSON.parse(before['jeju.json']).rows[0];
  assert.deepEqual(Object.keys(row), keys);
  assert.deepEqual(row, body.regions.JEJU[0], 'displayed strings retain whitespace and full length');
  await validatePublicDirectory(publicDir);
  for (const [key, limit] of Object.entries(limits)) {
    for (const bad of [true, 4.5, null, {}, [], '합'.repeat(limit + 1)]) {
      body = fixtureSource(); body.regions.JEJU[0][key] = bad;
      await assert.rejects(syncData(options(url, publicDir)), /Validation failed:.*bounded text/, key);
      assert.deepEqual(await fileBytes(publicDir), before);
    }
  }
});

test('accepts legitimate empty JEJU and NATIONAL only from valid source, never as a fallback', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  body.regions.JEJU = [];
  await syncData(options(url, publicDir));
  await validatePublicDirectory(publicDir);
  const before = await fileBytes(publicDir);
  for (const file of ['jeju.json', 'national.json']) assert.deepEqual(JSON.parse(before[file]).rows, []);
  for (const bad of [undefined, null, {}, Array(100001).fill(null)]) {
    body = fixtureSource(); body.regions.JEJU = bad;
    await assert.rejects(syncData(options(url, publicDir)));
    assert.deepEqual(await fileBytes(publicDir), before);
  }
});

async function fileBytes(publicDir) {
  return Object.fromEntries(await Promise.all((await readdir(publicDir)).sort().map(async name =>
    [name, await readFile(join(publicDir, name), 'utf8')])));
}

test('rejects schema, allowlist, scalar type and numeric bound violations before touching last-good assets', async t => {
  const { syncData } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  const before = await fileBytes(publicDir);
  const cases = [
    s => { s.schemaVersion = 2; },
    s => { s.privateFacts = 'NEVER PUBLISH'; },
    s => { s.exportedAt = 'yesterday'; },
    s => { s.exportedAt = '2026-02-30T00:00:00.000Z'; },
    s => { s.regions.EXTRA = []; },
    s => { delete s.regions.NATIONAL; },
    s => { s.regions.NATIONAL = {}; },
    s => { s.regions.NATIONAL = [{ ...fixtureRow(), privateFacts: 'NEVER PUBLISH' }]; },
    s => { s.regions.JEJU[0].aiRaw = 'NEVER PUBLISH'; },
    s => { delete s.regions.JEJU[0].name; },
    s => { s.regions.JEJU[0].name = { nested: 'NEVER PUBLISH' }; },
    s => { s.regions.JEJU[0].name = ''; },
    s => { s.regions.JEJU[0].name = 'x'.repeat(201); },
    s => { s.regions.JEJU[0].type = 'x'.repeat(65); },
    s => { s.regions.JEJU[0].type = 123; },
    s => { s.regions.JEJU[0].nameVerified = true; },
    s => { s.regions.JEJU[0].no = -1; },
    s => { s.regions.JEJU[0].no = 1.5; },
    s => { s.regions.JEJU[0].lat = 91; },
    s => { s.regions.JEJU[0].lng = -181; },
    s => { s.regions.JEJU[0].lat = '33.4'; },
    s => { s.regions.JEJU[0].lat = null; }, // neither coordinate is nullable
    s => { s.regions.JEJU[0].score = -1; },
    s => { s.regions.JEJU[0].score = 101; },
    s => { s.regions.JEJU[0].score = '8.8'; },
    s => { s.regions.JEJU[0].rating = 5.1; },
    s => { s.regions.JEJU[0].confidence = {}; },
    s => { s.regions.JEJU[0].verifiedAt = 20261009; },
    s => { s.regions.JEJU[0].note = '<script>alert(1)</script>'; s.regions.JEJU[0].private = true; },
  ];
  for (const [i, mutate] of cases.entries()) {
    body = fixtureSource(); mutate(body);
    await assert.rejects(syncData(options(url, publicDir)), undefined, `case ${i} must reject`);
    assert.deepEqual(await fileBytes(publicDir), before, `case ${i} changed last-good assets`);
  }
  for (const bad of [null, [], {}, { error: 'export failed' }]) {
    body = bad;
    await assert.rejects(syncData(options(url, publicDir)));
    assert.deepEqual(await fileBytes(publicDir), before);
  }
});

test('network, HTTP, redirect, timeout and body-limit failures preserve last-good files', async t => {
  const { syncData } = await implementation();
  const publicDir = await sandbox(t);
  let mode = 'valid';
  let disconnected = false;
  const url = await server(t, (req, res) => {
    if (mode === 'http') { res.writeHead(503); res.end('NEVER LOG THIS'); }
    else if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>login</html>'); }
    else if (mode === 'json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{broken'); }
    else if (mode === 'length') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '99999999' }); res.end('x'); }
    else if (mode === 'chunked') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(' '.repeat(1024)); res.end(' '.repeat(1024)); }
    else if (mode === 'infinity') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(fixtureSource()).replace('"score":8.8', '"score":1e400')); }
    else if (mode === 'loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
    else if (mode === 'redirect-missing') { res.writeHead(302); res.end(); }
    else if (mode === 'redirect-foreign') { res.writeHead(302, { Location: 'https://example.com/private' }); res.end(); }
    else if (mode === 'disconnect') { req.socket.destroy(); }
    else if (mode === 'slow-headers' || mode === 'slow-body') {
      if (mode === 'slow-body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); }
      res.on('close', () => { disconnected = true; });
    } else sendJson(res, fixtureSource());
  });
  await syncData(options(url, publicDir));
  const before = await fileBytes(publicDir);
  for (const value of ['http', 'html', 'json', 'length', 'chunked', 'infinity', 'loop', 'redirect-missing', 'redirect-foreign', 'disconnect', 'slow-headers', 'slow-body']) {
    mode = value;
    disconnected = false;
    const started = Date.now();
    await assert.rejects(syncData(options(url, publicDir, { timeoutMs: 150, maxBytes: 1536, maxRedirects: 3 })), undefined, value);
    assert.ok(Date.now() - started < 3000, `${value} must terminate`);
    if (value.startsWith('slow-')) {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(disconnected, `${value}: abort must close connection`);
    }
    assert.deepEqual(await fileBytes(publicDir), before, value);
  }
});

test('canonical row keys give stable versions and unchanged snapshots keep bytes, timestamps and mtimes', async t => {
  const { syncData } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  const before = await fileBytes(publicDir);
  const mtimes = Object.fromEntries(await Promise.all(['jeju.json', 'national.json', 'index.html', '.nojekyll'].map(async file => [file, (await stat(join(publicDir, file))).mtimeMs])));
  body.exportedAt = '2026-10-09T00:15:00.000Z';
  body.regions.JEJU[0] = Object.fromEntries(Object.entries(body.regions.JEJU[0]).reverse());
  await new Promise(resolve => setTimeout(resolve, 20));
  await syncData(options(url, publicDir));
  for (const [file, mtime] of Object.entries(mtimes)) {
    assert.equal(await readFile(join(publicDir, file), 'utf8'), before[file], file);
    assert.equal((await stat(join(publicDir, file))).mtimeMs, mtime, `${file} must not be rewritten`);
  }
  const status = JSON.parse(await readFile(join(publicDir, 'status.json'), 'utf8'));
  assert.equal(status.exportedAt, body.exportedAt);
  assert.notEqual(status.checkedAt, JSON.parse(before['status.json']).checkedAt);
  body.regions.JEJU[0].name = '새 이름';
  body.exportedAt = '2026-10-09T00:30:00.000Z';
  await syncData(options(url, publicDir));
  assert.notEqual(await readFile(join(publicDir, 'jeju.json'), 'utf8'), before['jeju.json']);
  assert.equal(await readFile(join(publicDir, 'national.json'), 'utf8'), before['national.json']);
  const jeju = JSON.parse(await readFile(join(publicDir, 'jeju.json'), 'utf8'));
  assert.equal(jeju.generatedAt, body.exportedAt);
  await writeFile(join(publicDir, 'jeju.json'), '{corrupt');
  await syncData(options(url, publicDir));
  assert.deepEqual(JSON.parse(await readFile(join(publicDir, 'jeju.json'), 'utf8')).rows, body.regions.JEJU);
});

test('daily health heartbeat advances only after a successful fetch while unchanged snapshots stay immutable', async t => {
  const { syncData } = await implementation();
  const publicDir = await sandbox(t);
  let valid = true;
  const url = await server(t, (_req, res) => sendJson(res, valid ? fixtureSource() : { error: 'bad' }));
  const run = at => syncData(options(url, publicDir, { now: () => new Date(at) }));
  await run('2026-10-09T01:00:00.000Z');
  const before = await fileBytes(publicDir);
  const health = JSON.parse(before['health.json'] ?? 'null');
  assert.equal(health?.lastVerifiedAt, '2026-10-09T01:00:00.000Z');
  await run('2026-10-09T01:15:00.000Z');
  assert.equal(await readFile(join(publicDir, 'health.json'), 'utf8'), before['health.json']);
  valid = false;
  const preFailure = await fileBytes(publicDir);
  await assert.rejects(run('2026-10-10T01:00:00.000Z'));
  assert.deepEqual(await fileBytes(publicDir), preFailure);
  valid = true;
  await run('2026-10-10T01:15:00.000Z');
  assert.equal(JSON.parse(await readFile(join(publicDir, 'health.json'), 'utf8')).lastVerifiedAt, '2026-10-10T01:15:00.000Z');
  for (const file of ['jeju.json', 'national.json', 'index.html', '.nojekyll']) {
    assert.equal(await readFile(join(publicDir, file), 'utf8'), before[file]);
  }
  assert.match(before['index.html'], /health\.json/);
});

test('pre-upload validation accepts only complete consistent allowlisted regular public assets', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  assert.equal(typeof validatePublicDirectory, 'function', 'artifact validator must exist');
  const publicDir = await sandbox(t);
  const url = await server(t, (_req, res) => sendJson(res, fixtureSource()));
  await syncData(options(url, publicDir));
  const pristine = await fileBytes(publicDir);
  assert.deepEqual((await readdir(publicDir)).sort(), ['.nojekyll', 'health.json', 'index.html', 'jeju.json', 'national.json', 'status.json']);
  await validatePublicDirectory(publicDir);
  const changes = [
    ['jeju.json', s => { s.rows[0].private = 'NEVER PUBLISH'; }],
    ['jeju.json', s => { s.rows[0].name = 'hash mismatch'; }],
    ['national.json', s => { s.region = 'JEJU'; }],
    ['status.json', s => { s.private = 'NEVER PUBLISH'; }],
    ['status.json', s => { s.regions.JEJU.rowCount = 999; }],
    ['status.json', s => { s.regions.JEJU.version = '0'.repeat(64); }],
    ['health.json', s => { s.lastVerifiedAt = 'yesterday'; }],
    ['health.json', s => { s.private = 'NEVER PUBLISH'; }],
  ];
  for (const [file, mutate] of changes) {
    const value = JSON.parse(pristine[file]); mutate(value);
    await writeFile(join(publicDir, file), JSON.stringify(value));
    await assert.rejects(validatePublicDirectory(publicDir), undefined, file);
    await writeFile(join(publicDir, file), pristine[file]);
  }
  for (const file of ['index.html', '.nojekyll']) {
    await writeFile(join(publicDir, file), 'NEVER PUBLISH');
    await assert.rejects(validatePublicDirectory(publicDir));
    await writeFile(join(publicDir, file), pristine[file]);
  }
  await writeFile(join(publicDir, 'secret.txt'), 'NEVER PUBLISH');
  await assert.rejects(validatePublicDirectory(publicDir));
  await assert.rejects(syncData(options(url, publicDir)));
  await rm(join(publicDir, 'secret.txt'));
  await rm(join(publicDir, 'national.json'));
  await assert.rejects(validatePublicDirectory(publicDir));
  await symlink(join(publicDir, 'jeju.json'), join(publicDir, 'national.json'));
  await assert.rejects(validatePublicDirectory(publicDir));
  await assert.rejects(syncData(options(url, publicDir)));
  await rm(join(publicDir, 'national.json'));
  await syncData(options(url, publicDir));
  await validatePublicDirectory(publicDir);
});

test('write failure leaves existing snapshots intact and removes staging files', async t => {
  const { syncData } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  const before = await fileBytes(publicDir);
  body = fixtureSource();
  body.regions.JEJU[0].name = 'changed';
  body.regions.NATIONAL = [fixtureRow()];
  await chmod(publicDir, 0o500);
  try {
    await assert.rejects(syncData(options(url, publicDir)), undefined, 'replacement requires an atomic directory rename');
    assert.deepEqual(await fileBytes(publicDir), before);
    assert.deepEqual(await readdir(join(publicDir, '..')), ['public']);
  } finally { await chmod(publicDir, 0o700); }
});

test('failure after the first replacement rolls back prior bytes and cleans staging', async t => {
  const { syncData, validatePublicDirectory } = await implementation();
  const publicDir = await sandbox(t);
  let body = fixtureSource();
  const url = await server(t, (_req, res) => sendJson(res, body));
  await syncData(options(url, publicDir));
  const before = await fileBytes(publicDir);
  body = fixtureSource();
  body.regions.JEJU[0].name = 'synthetic changed row';
  body.regions.NATIONAL = [fixtureRow()];
  const originalRename = fsPromises.rename;
  const completed = [];
  const renamer = t.mock.method(fsPromises, 'rename', async (from, to) => {
    if (from.endsWith('/new-national.json')) {
      assert.equal(completed.length, 1, 'fault must occur after exactly one successful replacement');
      assert.ok(completed[0].endsWith('/new-jeju.json'));
      throw new Error('Synthetic second replacement failure');
    }
    await originalRename(from, to);
    completed.push(from);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(syncData(options(url, publicDir)), /Synthetic second replacement failure/);
  } finally {
    renamer.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(completed.length, 2, 'replacement and rollback must both complete');
  assert.ok(completed[1].endsWith('/old-jeju.json'), 'restore staged last-good bytes');
  assert.deepEqual(await fileBytes(publicDir), before);
  assert.deepEqual(await readdir(join(publicDir, '..')), ['public']);
  await validatePublicDirectory(publicDir);
});

test('CLI prepares and validates local committed snapshots without a source URL or network access', async t => {
  const publicDir = await sandbox(t);
  const scriptsDir = join(publicDir, '..', 'scripts');
  await mkdir(scriptsDir);
  const script = join(scriptsDir, 'sync-data.mjs');
  await writeFile(script, await readFile(new URL('../scripts/sync-data.mjs', import.meta.url), 'utf8'));
  const run = args => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, PUBLIC_DATA_SOURCE_URL: '' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(run([]).status, 1);
  assert.match(run(['--unknown']).stderr, /Usage/);
  assert.equal(run(['--validate']).status, 1, 'missing assets cannot pass validation');
  assert.equal(run(['--prepare']).status, 1, 'missing snapshots cannot be published');
  await mkdir(publicDir, { recursive: true });
  const source = fixtureSource();
  for (const [region, file] of Object.entries({ JEJU: 'jeju.json', NATIONAL: 'national.json' })) {
    const rows = source.regions[region];
    const snapshot = { schemaVersion: 1, region, version: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), generatedAt: source.exportedAt, rows };
    await writeFile(join(publicDir, file), `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  const prepared = run(['--prepare']);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /Prepared validated Pages artifact/);
  const before = await fileBytes(publicDir);
  assert.equal(run(['--validate']).status, 0);
  assert.deepEqual(await fileBytes(publicDir), before);
  await writeFile(join(publicDir, 'national.json'), '{}');
  assert.equal(run(['--prepare']).status, 1);
});

test('prepares a Pages artifact from valid committed snapshots without fetching a source endpoint', async t => {
  const { preparePagesPublication, validatePublicDirectory } = await implementation();
  assert.equal(typeof preparePagesPublication, 'function', 'local snapshot preparation must exist');
  const publicDir = await sandbox(t);
  await mkdir(publicDir, { recursive: true });
  const source = fixtureSource();
  for (const [region, file] of Object.entries({ JEJU: 'jeju.json', NATIONAL: 'national.json' })) {
    const rows = source.regions[region];
    const version = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const generatedAt = region === 'JEJU' ? source.exportedAt : '2026-10-10T00:00:00.000Z';
    const snapshot = { schemaVersion: 1, region, version, generatedAt, rows };
    await writeFile(join(publicDir, file), `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  await writeFile(join(publicDir, 'health.json'), `${JSON.stringify({schemaVersion:1,lastVerifiedAt:'2026-10-09T00:00:00.000Z'},null,2)}\n`);
  const before = await fileBytes(publicDir);
  const status = await preparePagesPublication({ publicDir, now: () => new Date('2026-10-10T01:15:00.000Z') });
  assert.equal(status.checkedAt, '2026-10-10T01:15:00.000Z');
  assert.equal(status.exportedAt, '2026-10-10T00:00:00.000Z');
  assert.equal(status.regions.JEJU.rowCount, 1);
  assert.equal(status.regions.NATIONAL.rowCount, 0);
  assert.equal(await readFile(join(publicDir, 'jeju.json'), 'utf8'), before['jeju.json']);
  assert.equal(await readFile(join(publicDir, 'national.json'), 'utf8'), before['national.json']);
  assert.equal(JSON.parse(await readFile(join(publicDir, 'health.json'), 'utf8')).lastVerifiedAt, status.checkedAt);
  const index = await readFile(join(publicDir, 'index.html'), 'utf8');
  assert.match(index, /Latest successful validation/);
  assert.match(index, /Latest Pages deployment verification/);
  await validatePublicDirectory(publicDir);
});

test('rejects a valid snapshot larger than 4 MiB before generating Pages metadata', async t => {
  const { preparePagesPublication } = await implementation();
  const publicDir = await sandbox(t);
  await mkdir(publicDir, { recursive: true });
  const generatedAt = '2026-10-10T00:00:00.000Z';
  const rows = Array.from({ length: 300 }, (_, i) => ({ ...fixtureRow(), no: i + 2, note: 'x'.repeat(20000) }));
  for (const [region, file, data] of [
    ['JEJU', 'jeju.json', rows], ['NATIONAL', 'national.json', []]
  ]) {
    const snapshot = { schemaVersion: 1, region, version: createHash('sha256').update(JSON.stringify(data)).digest('hex'), generatedAt, rows: data };
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (region === 'JEJU') assert.ok(Buffer.byteLength(text) > 4 * 1024 * 1024);
    await writeFile(join(publicDir, file), text);
  }
  await assert.rejects(preparePagesPublication({ publicDir }), /snapshot exceeds 4 MiB/);
  assert.deepEqual((await readdir(publicDir)).sort(), ['jeju.json', 'national.json']);
});

test('rejects more than 20,000 source rows before writing any Pages files', async t => {
  const { syncData } = await implementation();
  const publicDir = await sandbox(t);
  const source = fixtureSource();
  source.regions.JEJU = Array.from({ length: 20001 }, (_, i) => ({ ...fixtureRow(), no: i + 2 }));
  const url = await server(t, (_req, res) => sendJson(res, source));
  await assert.rejects(syncData(options(url, publicDir, { maxBytes: 20 * 1024 * 1024 })), /bounded row array/);
  await assert.rejects(readFile(join(publicDir, 'jeju.json'), 'utf8'), { code: 'ENOENT' });
});
