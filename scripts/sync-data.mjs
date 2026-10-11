import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, readdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REGIONS = { JEJU: 'jeju.json', NATIONAL: 'national.json' };
const ROW_KEYS = ['no', 'type', 'name', 'nameVerified', 'address', 'subregion', 'sido', 'sigungu', 'menu', 'score', 'status', 'confidence', 'rating', 'review', 'note', 'closedDays', 'hours', 'lat', 'lng', 'verifiedAt', 'category'];
const STRING_LIMITS = { type: 64, name: 200, nameVerified: 2000, address: 2000, subregion: 200, sido: 200, sigungu: 200, menu: 10000, status: 200, confidence: 200, rating: 2000, review: 20000, note: 20000, closedDays: 2000, hours: 2000, verifiedAt: 2000, category: 200 };
// Narrow provider shapes, not property labels, business numbers or generic entropy.
// Reviewed against Gitleaks' primary GitHub/GCP/OpenAI rules; not a complete scanner.
const CREDENTIAL_PATTERNS = [
  /(?:^|[^A-Za-z0-9_])gh[pousr]_[A-Za-z0-9_]{36,}(?![A-Za-z0-9_])/,
  /(?:^|[^A-Za-z0-9_])github_pat_[A-Za-z0-9_]{82}(?![A-Za-z0-9_])/,
  /(?:^|[^A-Za-z0-9_])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/,
  /(?:^|[^A-Za-z0-9_])sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})(?![A-Za-z0-9_-])/,
  /(?:^|[^A-Za-z0-9_])sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}(?![A-Za-z0-9_])/,
];
function requireThat(condition, message) {
  if (!condition) throw new Error(`Validation failed: ${message}`);
}
function exactKeys(value, keys, label) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value);
  requireThat(actual.length === keys.length && actual.every(key => keys.includes(key)), `${label} has missing or unrecognized keys`);
}
function timestamp(value, label) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, `${label} must be a canonical ISO UTC timestamp`);
}
function coordinate(value, min, max, label) {
  requireThat(typeof value === 'number' && Number.isFinite(value) && value !== 0 && value >= min && value <= max, `${label} must be a nonzero finite number within geographic bounds`);
}
function validateRows(rows, region) {
  requireThat(Array.isArray(rows) && rows.length <= 20000, `${region} must be a bounded row array`);
  const ids = new Set();
  return rows.map(row => {
    exactKeys(row, ROW_KEYS, `${region} row`);
    requireThat(Number.isSafeInteger(row.no) && row.no >= 2, 'no must be a safe integer >= 2');
    requireThat(!ids.has(row.no), `${region} row ids must be unique`);
    ids.add(row.no);
    for (const [key, limit] of Object.entries(STRING_LIMITS)) {
      requireThat(typeof row[key] === 'string' && row[key].length <= limit, `${key} must be bounded text`);
      requireThat(!CREDENTIAL_PATTERNS.some(pattern => pattern.test(row[key])), `${key} contains a recognizable credential shape`);
    }
    requireThat(row.name.trim().length > 0 && row.type.trim().length > 0, 'name and type must be nonempty');
    requireThat(typeof row.score === 'number' && Number.isFinite(row.score) && row.score > 0 && row.score <= 10, 'score must be a finite number > 0 and <= 10');
    coordinate(row.lat, -90, 90, 'lat');
    coordinate(row.lng, -180, 180, 'lng');
    return Object.fromEntries(ROW_KEYS.map(key => [key, row[key]]));
  });
}
function validateSource(source) {
  exactKeys(source, ['schemaVersion', 'exportedAt', 'regions'], 'source');
  requireThat(source.schemaVersion === 1, 'unsupported schemaVersion');
  timestamp(source.exportedAt, 'exportedAt');
  exactKeys(source.regions, Object.keys(REGIONS), 'regions');
  return { ...source, regions: Object.fromEntries(Object.keys(REGIONS).map(region => [region, validateRows(source.regions[region], region)])) };
}
const versionFor = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function requireCanonicalJson(text, value) {
  // Parsed hashes cannot detect overwritten members carrying private raw bytes.
  requireThat(text === json(value), 'public JSON must use canonical publisher serialization');
}
function renderIndex(status) {
  return `<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Jeju Place public data</title><h1>Jeju Place public data</h1><p>Latest successful validation: <a href="status.json">status.json</a>. Latest Pages deployment verification: <a href="health.json">health.json</a> (lastVerifiedAt).</p><ul>${Object.entries(REGIONS).map(([region, file]) => `<li><a href="${file}">${region}</a>: ${status.regions[region].rowCount} rows; content exported at ${status.regions[region].generatedAt}; SHA-256 ${status.regions[region].version}</li>`).join('')}</ul><p>Times are UTC. Snapshot generatedAt changes only with row contents. CDN caches may lag; fetch status.json to inspect freshness.</p></html>\n`;
}
function validateUrl(value, allowInsecureLocalhost, isSource = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid source/redirect URL'); }
  const local = allowInsecureLocalhost && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const google = url.protocol === 'https:' && ['script.google.com', 'script.googleusercontent.com'].includes(url.hostname) && (url.port === '' || url.port === '443');
  requireThat((local || google) && !url.username && !url.password && !url.hash, 'source/redirect URL must use approved hosts without credentials');
  if (isSource && !local) requireThat(url.hostname === 'script.google.com' && /^\/macros\/s\/[^/]+\/exec$/.test(url.pathname), 'source must be a deployed GAS /exec endpoint');
  return url;
}
async function fetchSource({ sourceUrl, allowInsecureLocalhost = false, timeoutMs = 30000, maxBytes = 10 * 1024 * 1024, maxRedirects = 5 }) {
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120000, 'invalid timeoutMs');
  requireThat(Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 100 * 1024 * 1024, 'invalid maxBytes');
  requireThat(Number.isSafeInteger(maxRedirects) && maxRedirects >= 0 && maxRedirects <= 10, 'invalid maxRedirects');
  let url = validateUrl(sourceUrl, allowInsecureLocalhost, true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      requireThat(location !== null && redirects < maxRedirects, 'missing redirect location or too many redirects');
      url = validateUrl(new URL(location, url).href, allowInsecureLocalhost);
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Source HTTP error ${response.status}`); }
    requireThat(/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || ''), 'source is not application/json');
    const length = response.headers.get('content-length');
    requireThat(length === null || (/^\d+$/.test(length) && Number(length) <= maxBytes), 'source exceeds byte cap');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      requireThat(bytes <= maxBytes, 'source exceeds byte cap');
      chunks.push(chunk);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    let source;
    try { source = JSON.parse(text); } catch { throw new Error('Source is not valid JSON'); }
    return validateSource(source);
  } catch (error) {
    controller.abort();
    if (error.name === 'AbortError') throw new Error('Source request timed out or aborted');
    // Do not print URLs, response text, or upstream errors containing private data.
    if (error.message.startsWith('Validation failed:') || error.message.startsWith('Source ')) throw error;
    throw new Error('Source request failed');
  } finally {
    clearTimeout(timer);
  }
}
function validateSnapshot(snapshot, region) {
  exactKeys(snapshot, ['schemaVersion', 'region', 'version', 'generatedAt', 'rows'], 'snapshot');
  requireThat(snapshot.schemaVersion === 1 && snapshot.region === region, 'snapshot schema/region mismatch');
  timestamp(snapshot.generatedAt, 'generatedAt');
  const rows = validateRows(snapshot.rows, region);
  requireThat(snapshot.version === versionFor(rows), 'snapshot hash mismatch');
  return snapshot;
}
async function readOptional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function validateHealth(health) {
  exactKeys(health, ['schemaVersion', 'lastVerifiedAt'], 'health');
  requireThat(health.schemaVersion === 1, 'health schema mismatch');
  timestamp(health.lastVerifiedAt, 'lastVerifiedAt');
  return health;
}
const PUBLIC_FILES = ['.nojekyll', 'health.json', 'index.html', 'jeju.json', 'national.json', 'status.json'];
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
async function inspectDirectory(publicDir, complete = false) {
  let info;
  try { info = await lstat(publicDir); } catch (error) {
    if (error.code === 'ENOENT' && !complete) return;
    throw error;
  }
  requireThat(info.isDirectory() && !info.isSymbolicLink(), 'public directory must not be a symlink');
  const entries = await readdir(publicDir, { withFileTypes: true });
  requireThat(entries.every(entry => PUBLIC_FILES.includes(entry.name) && entry.isFile() && !entry.isSymbolicLink()), 'public directory contains unexpected or non-regular assets');
  if (complete) requireThat(entries.length === PUBLIC_FILES.length, 'public directory is incomplete');
  for (const entry of entries) {
    const size = (await lstat(join(publicDir, entry.name))).size;
    const isSnapshot = Object.values(REGIONS).includes(entry.name);
    requireThat(size <= (isSnapshot ? MAX_SNAPSHOT_BYTES : MAX_ASSET_BYTES),
      isSnapshot ? `${entry.name} snapshot exceeds 4 MiB` : 'public asset exceeds size cap');
  }
}
function validateAssets(files) {
  exactKeys(files, PUBLIC_FILES, 'public assets');
  for (const file of Object.values(REGIONS)) {
    requireThat(typeof files[file] === 'string' && Buffer.byteLength(files[file], 'utf8') <= MAX_SNAPSHOT_BYTES,
      `${file} snapshot exceeds 4 MiB`);
  }
  const snapshots = Object.fromEntries(Object.entries(REGIONS).map(([region, file]) => [region, validateSnapshot(JSON.parse(files[file]), region)]));
  const status = JSON.parse(files['status.json']);
  exactKeys(status, ['schemaVersion', 'checkedAt', 'exportedAt', 'regions'], 'status');
  requireThat(status.schemaVersion === 1, 'status schema mismatch');
  timestamp(status.checkedAt, 'checkedAt');
  timestamp(status.exportedAt, 'exportedAt');
  exactKeys(status.regions, Object.keys(REGIONS), 'status regions');
  for (const region of Object.keys(REGIONS)) {
    const metadata = status.regions[region];
    exactKeys(metadata, ['version', 'generatedAt', 'rowCount'], 'status region metadata');
    const snapshot = snapshots[region];
    requireThat(metadata.version === snapshot.version && metadata.generatedAt === snapshot.generatedAt && metadata.rowCount === snapshot.rows.length, 'status metadata does not match snapshots');
  }
  const health = validateHealth(JSON.parse(files['health.json']));
  requireThat(health.lastVerifiedAt <= status.checkedAt, 'health cannot be newer than successful Pages validation');
  requireThat(files['.nojekyll'] === '', '.nojekyll must be empty');
  requireThat(files['index.html'] === renderIndex(status), 'index must contain only generated status markup');
  for (const [region, file] of Object.entries(REGIONS)) requireCanonicalJson(files[file], snapshots[region]);
  requireCanonicalJson(files['status.json'], status);
  requireCanonicalJson(files['health.json'], health);
  return status;
}
export async function validatePublicDirectory(publicDir) {
  await inspectDirectory(publicDir, true);
  const files = Object.fromEntries(await Promise.all(PUBLIC_FILES.map(async file => [file, await readFile(join(publicDir, file), 'utf8')])));
  return validateAssets(files);
}
async function publishFiles(publicDir, files) {
  const changes = [];
  for (const [file, data] of Object.entries(files)) {
    const previous = await readOptional(join(publicDir, file));
    if (previous !== data) changes.push({ file, data, previous });
  }
  if (changes.length === 0) return;
  await mkdir(publicDir, { recursive: true });
  // Stage next to public/, never inside the Pages artifact; rename is same-filesystem.
  const stage = await mkdtemp(join(dirname(publicDir), '.publisher-'));
  const replaced = [];
  try {
    for (const change of changes) {
      await writeFile(join(stage, `new-${change.file}`), change.data, { flag: 'wx', mode: 0o644 });
      if (change.previous !== null) await writeFile(join(stage, `old-${change.file}`), change.previous, { flag: 'wx', mode: 0o644 });
    }
    await inspectDirectory(publicDir);
    for (const change of changes) {
      await rename(join(stage, `new-${change.file}`), join(publicDir, change.file));
      replaced.push(change);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const change of replaced.reverse()) {
      try {
        if (change.previous === null) await rm(join(publicDir, change.file));
        else await rename(join(stage, `old-${change.file}`), join(publicDir, change.file));
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Publishing and rollback failed; do not deploy this directory');
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export async function syncData(options) {
  const { publicDir } = options;
  await inspectDirectory(publicDir);
  const source = await fetchSource(options);
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const status = { schemaVersion: 1, checkedAt, exportedAt: source.exportedAt, regions: {} };
  const files = {};
  for (const [region, file] of Object.entries(REGIONS)) {
    const rows = source.regions[region];
    let snapshot = { schemaVersion: 1, region, version: versionFor(rows), generatedAt: source.exportedAt, rows };
    const previous = await readOptional(join(publicDir, file));
    let retained = false;
    if (previous !== null) {
      try {
        const old = validateSnapshot(JSON.parse(previous), region);
        requireCanonicalJson(previous, old);
        if (old.version === snapshot.version) { snapshot = old; retained = true; }
      } catch { /* A valid real source can repair a corrupt local snapshot. */ }
    }
    files[file] = retained ? previous : json(snapshot);
    status.regions[region] = { version: snapshot.version, generatedAt: snapshot.generatedAt, rowCount: rows.length };
  }
  files['status.json'] = json(status);
  files['health.json'] = json({ schemaVersion: 1, lastVerifiedAt: checkedAt });
  const previousHealth = await readOptional(join(publicDir, 'health.json'));
  if (previousHealth !== null) {
    try {
      const health = validateHealth(JSON.parse(previousHealth));
      requireCanonicalJson(previousHealth, health);
      if (health.lastVerifiedAt.slice(0, 10) === checkedAt.slice(0, 10) && health.lastVerifiedAt <= checkedAt) files['health.json'] = previousHealth;
    } catch { /* Repair malformed metadata only following a valid source fetch. */ }
  }
  files['index.html'] = renderIndex(status);
  files['.nojekyll'] = '';
  validateAssets(files);
  await publishFiles(publicDir, files);
  return status;
}

export async function preparePagesPublication(options) {
  const { publicDir } = options;
  await inspectDirectory(publicDir);
  const snapshots = {};
  for (const [region, file] of Object.entries(REGIONS)) {
    const raw = await readOptional(join(publicDir, file));
    requireThat(raw !== null, `${file} is missing; GAS must push snapshots first`);
    let snapshot;
    try { snapshot = JSON.parse(raw); } catch { throw new Error(`Validation failed: ${file} is not valid JSON`); }
    validateSnapshot(snapshot, region);
    requireCanonicalJson(raw, snapshot);
    snapshots[region] = { snapshot, raw };
  }
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  timestamp(checkedAt, 'checkedAt');
  const exportedAt = Object.values(snapshots).map(value => value.snapshot.generatedAt).sort().pop();
  const status = { schemaVersion: 1, checkedAt, exportedAt, regions: {} };
  const files = {};
  for (const [region, file] of Object.entries(REGIONS)) {
    const snapshot = snapshots[region].snapshot;
    files[file] = snapshots[region].raw;
    status.regions[region] = { version: snapshot.version, generatedAt: snapshot.generatedAt, rowCount: snapshot.rows.length };
  }
  files['status.json'] = json(status);
  files['health.json'] = json({ schemaVersion: 1, lastVerifiedAt: checkedAt });
  files['index.html'] = renderIndex(status);
  files['.nojekyll'] = '';
  validateAssets(files);
  await publishFiles(publicDir, files);
  return status;
}

async function main() {
  const args = process.argv.slice(2);
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  if (args.length === 1 && args[0] === '--prepare') {
    const status = await preparePagesPublication({ publicDir });
    console.log(`Prepared validated Pages artifact at ${status.checkedAt}; JEJU ${status.regions.JEJU.rowCount} rows; NATIONAL ${status.regions.NATIONAL.rowCount} rows`);
    return;
  }
  if (args.length === 1 && args[0] === '--validate') {
    await validatePublicDirectory(publicDir);
    console.log('Validated public Pages assets');
    return;
  }
  throw new Error('Usage: node scripts/sync-data.mjs --prepare|--validate');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch (error) {
    // Never dump arbitrary JSON parse errors, paths, source URLs or upstream content.
    const safe = /^(Validation failed:|Source |PUBLIC_DATA_SOURCE_URL|Usage:)/.test(error.message);
    console.error(safe ? error.message : 'Publisher failed; previous deployment remains live. Inspect input contract and filesystem permissions.');
    process.exitCode = 1;
  }
}
