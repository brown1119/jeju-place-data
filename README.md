# jeju-place-data

제주·전국 장소 웹앱의 **공개 데이터 전용** GitHub Pages publisher.

This public repository contains the publisher, its tests, and approved public snapshots. The original `brown1119/jeju-place` repository must remain **private**. Do not copy its Apps Script source, spreadsheet credentials, API keys, AI raw facts, or private columns here. Test fixtures are synthetic and stay in `test/` / temporary test directories; they are never published. No placeholder dataset is checked in: `public/` is created only after an actual source response passes validation.

## Setup and manual updates

1. Keep this repository public and the original application repository private.
2. In **Settings → Secrets and variables → Actions → Variables**, set the repository variable `PUBLIC_DATA_SOURCE_URL` to the deployed, unauthenticated, **public-only** GAS `/exec` exporter URL. This is a nonsecret variable, not a credential. A query string selecting the public export is supported. Never put an API key or other secret in the URL.
3. The GAS exporter must emit `application/json` and only already-visible approved public fields, in the contract below. Pages must use **GitHub Actions** as its build/deployment source. If main is protected, permit the workflow's `GITHUB_TOKEN` to push the approved generated files; no PAT is used. A denied or non-fast-forward push fails the job rather than publishing an inconsistent revision.
4. Review these changes before committing/pushing them. Once enabled on `main`, use **Actions → Publish public place data → Run workflow**, selecting `main`, to request a manual update. Reruns check out current `main`, fetch again, and can deploy valid unchanged assets without needing a new snapshot commit.

Local checks require Node LTS; there are no npm dependencies:

```sh
node --test test/*.test.mjs
PUBLIC_DATA_SOURCE_URL='https://script.google.com/macros/s/DEPLOYMENT_ID/exec' node scripts/sync-data.mjs
node scripts/sync-data.mjs --validate
```

The example URL is a syntax example, not a live endpoint. The CLI writes only this repository's `public/`; it does not commit, push, change settings, or deploy. Do not run a fixture exporter into that directory. A missing URL, network error, invalid response, or failed validation exits nonzero; the workflow stops before commits/artifact upload/deployment, so the previous Pages deployment stays live.

## Source contract and publication boundary

The source object has **exactly** `schemaVersion: 1`, `exportedAt` (canonical ISO UTC timestamp, `YYYY-MM-DDTHH:mm:ss.sssZ`), and `regions`. `regions` has exactly `JEJU` and `NATIONAL`, each an array. A legitimate empty region is accepted only from a validated source; it is not manufactured as a fallback.

Every row must have exactly these keys, with no additional or missing keys:

```text
no,type,name,nameVerified,address,subregion,sido,sigungu,menu,score,status,confidence,rating,review,note,closedDays,hours,lat,lng,verifiedAt,category
```

Validation is intentionally fail-closed, not a best-effort filter:

- `no`: safe integer **>= 2**, unique within each region (spreadsheet row identity). The same number may appear once in each of JEJU and NATIONAL.
- `nameVerified`: confirmed-name string, not a boolean; `rating`: formatted display string, not a number; `verifiedAt`: date/display string, not necessarily ISO. Empty strings are valid for all three. Preserve the exporter/client's displayed values exactly.
- `type`: nonempty string, at most 64 UTF-16 code units; `name`: nonempty string, at most 200.
- `score`: finite JSON number in **(0,10]**: zero is rejected, ten is accepted. No `null`, numeric strings, booleans or nonfinite numbers.
- `lat` / `lng`: **nonzero** finite numbers in `[-90,90]` / `[-180,180]`. Zero (including negative zero), `null`, numeric strings, missing coordinates and out-of-range values are rejected, not coerced.
- All fields except `no`, `score`, `lat` and `lng` are bounded **strings**, not objects/arrays/numbers/booleans/null. `confidence` is textual (up to 200), not an arbitrary nested AI result. Empty text is allowed except `name` and `type`. Strings are never trimmed, truncated or silently converted.
- Additional text bounds (UTF-16 code units): `nameVerified`, `rating`, `verifiedAt`, `address`, `closedDays`, `hours` up to 2,000; `menu` up to 10,000; `review`, `note` up to 20,000; `subregion`, `sido`, `sigungu`, `status`, `confidence`, `category` up to 200. The canonical ISO UTC timestamp rule applies to top-level `exportedAt`, snapshot `generatedAt`, and freshness metadata, **not** row `verifiedAt`.
- Approved text fields are also checked for recognizable GitHub token, Google `AIza` API-key, and legacy/project/service-account/admin OpenAI key shapes. A match rejects the entire response/artifact without logging its value. Plain labels such as `API_KEY` or `GITHUB_TOKEN`, ordinary business/phone numbers and prices are not credentials. This is **not a complete secret scanner**: arbitrary private text, unknown token formats and encoded/fragmented secrets still require exporter-owner review. Detection does not authenticate any token or prove whether it is live.
- At most 100,000 rows per region. The complete HTTP response is capped at **10 MiB** (including streamed/decompressed bytes); declared oversized responses are rejected early.

The private exporter owner must emit the actual GAS Reader/client public contract above; the publisher must not substitute invented boolean/numeric/ISO types for displayed text. If the public source contract changes, review both sides and update tests first; never silently widen the row allowlist. Source text is deliberately not printed in failure logs.

The publisher accepts HTTPS `script.google.com/macros/s/.../exec` as the source, follows at most five ContentService redirects only to approved Google hosts, and has one **30-second timeout across redirects and body reads**, enforced with `AbortController`. Loopback HTTP is an explicit library-only test option, not a CLI setting. It parses and validates both regions and every generated asset before touching existing public files. New contents are staged next to (not inside) `public/`, then replaced using same-filesystem atomic file renames; caught write errors attempt rollback. This is not a crash-proof multi-file filesystem transaction: power loss or SIGKILL during renames can interrupt it. The workflow revalidates the complete directory before upload and never deploys after a failed sync.

## Generated assets and freshness

The only permitted Pages assets are:

| Asset | Meaning | Tracked in git? |
| --- | --- | --- |
| `jeju.json`, `national.json` | Approved region snapshots | Yes |
| `index.html`, `.nojekyll` | Generated status/index markup and Pages marker | Yes |
| `health.json` | Successful verification heartbeat, at most once per UTC calendar date | Yes |
| `status.json` | Latest successful fetch's `checkedAt`, source `exportedAt`, and region versions/timestamps/counts | No; regenerated and deployed each successful run |

Each region snapshot has exactly `{schemaVersion:1, region:'JEJU'|'NATIONAL', version, generatedAt, rows}`. `version` is the lowercase SHA-256 of UTF-8 `JSON.stringify(rows)` after canonicalizing each row's keys in the allowlist order. Array/row order remains source order; meaningful row ordering changes update the version.

When row contents/version are unchanged, snapshot **bytes, file modification times, and `generatedAt` remain unchanged**. `generatedAt` records the source export timestamp used when that content version was first published; it is **not** the last verification timestamp. The client consumes only region snapshots and must **not age-expire unchanged data based on `generatedAt`**.

`health.json` contains exactly `{schemaVersion:1,lastVerifiedAt}`. It advances on the first successful, fully validated fetch on a new UTC date; failed fetches do not advance it. Its periodic commits keep stable datasets generating repository activity without churning region snapshots. `status.json` reports each run's finer-grained verification metadata without generating a commit every 15 minutes. The status page links both metadata files plus each snapshot's timestamp, row count, and hash. Click those JSON links to inspect freshness; metadata does not attest that every individual place was recently reviewed.

Pages/CDN/browser caches can serve an earlier deployment temporarily. After a manual run, inspect the workflow's successful deployment and `status.json` / `health.json`; a cache-busting query or browser cache bypass can help diagnose old cached responses, but is not a consistency or freshness guarantee. There is no promised propagation delay or speed improvement.

## Workflow and schedule caveats

`.github/workflows/publish.yml` runs on `push` to `main`, manual dispatch, and UTC cron `7,22,37,52 * * * *`. A shared concurrency group serializes publishing/deploying, with `cancel-in-progress: false`. GitHub may replace pending runs within a concurrency group; this is not a guaranteed queue of every tick.

GitHub documents that scheduled runs can be **delayed or dropped** under load, and public-repository schedules can be **automatically disabled after 60 days without repository activity**. The daily successful-fetch heartbeat helps maintain activity; it cannot guarantee execution, and prolonged source/workflow failures can still leave the schedule disabled. Monitor failures and re-enable the workflow in Actions if needed. Do not describe this as a guaranteed 15-minute refresh.

The workflow uses only `GITHUB_TOKEN`, with `contents:write`, `pages:write`, and `id-token:write`. It stages only the two snapshots, index, marker, and daily health metadata. No PAT, private-repository checkout, broad `git add`, or credential copied into Pages is needed. Changes made with `GITHUB_TOKEN` do **not** trigger another normal push workflow or Pages build: artifact upload and `deploy-pages` deliberately run **in the same workflow**, including when snapshots are unchanged.

The upload action points **only at `public/`**, never `.` or the repository root. Immediately before upload the validator requires exactly the six allowlisted regular files, rejects unknown files/directories/symlinks and oversized assets, validates all JSON/hash/metadata relationships, and requires the index to match the publisher's generated markup. Only the known empty `.nojekyll` hidden file is included. Scripts, tests, README, `.github`, source responses, and temporary staging are outside the artifact.

## Verification and official references

The Node built-in test suite exercises real local HTTP servers for redirects, actual Reader display-string regressions, exact row keys/text caps, per-region row-id uniqueness, score/coordinate boundaries, legitimate empty regions without fallback, recognizable credential-shaped text (only obviously synthetic nonreal markers), invalid schemas/unknown fields, HTTP/network/timeout/body failures, last-good preservation, deterministic versions, immutable unchanged snapshots, daily successful-only heartbeat, strict artifact validation, write failures, CLI exit behavior, README and the workflow contract. Fixtures are isolated in temporary test directories. Source and pre-upload validation share the same row rules; tests rehash intentionally invalid local snapshots to ensure a valid hash cannot bypass them.

The owner/parent reviewer verified these official action-tag commits read-only on **2026-10-09**. The workflow uses their immutable full-SHA pins, with major-version comments for readability; moving upstream tags do not automatically change executed code. Review upstream changes before updating pins and matching workflow tests:

| Official action tag | Reviewed full commit SHA |
| --- | --- |
| `actions/checkout@v7` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node@v7` | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| `actions/upload-pages-artifact@v5` | `fc324d3547104276b827a68afc52ff2a11cc49c9` |
| `actions/deploy-pages@v5` | `368f82528645a54fb793d4d04e342629a3f51346` |

The upload v5 input `include-hidden-files: true` is set explicitly for `.nojekyll`; strict validation prevents including other hidden files. Narrow credential shapes were reviewed read-only against Gitleaks' primary GitHub, Google and OpenAI detection rules; the publisher deliberately rejects shaped values even when a low-entropy example might be allowed by a general-purpose scanner.

- [Official checkout action at reviewed commit](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1)
- [Official setup-node action at reviewed commit](https://github.com/actions/setup-node/tree/949feb2413d6458794dcd2491c4babbbce0c15c1)
- [Official Pages artifact action at reviewed commit](https://github.com/actions/upload-pages-artifact/tree/fc324d3547104276b827a68afc52ff2a11cc49c9)
- [Official Pages deployment action at reviewed commit](https://github.com/actions/deploy-pages/tree/368f82528645a54fb793d4d04e342629a3f51346)
- [Gitleaks GitHub token rules](https://github.com/gitleaks/gitleaks/blob/master/cmd/generate/config/rules/github.go)
- [Gitleaks Google API-key rules](https://github.com/gitleaks/gitleaks/blob/master/cmd/generate/config/rules/gcp.go)
- [Gitleaks OpenAI API-key rules](https://github.com/gitleaks/gitleaks/blob/master/cmd/generate/config/rules/openai.go)
- [GitHub schedule event, delays, and inactivity behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub token-trigger recursion rules](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
- [Google ContentService redirects](https://developers.google.com/apps-script/guides/content#redirects)

Initial integration with the actual deployed public exporter and GitHub Pages still requires owner review/execution. Unit/integration tests do not substitute for checking that the real source contains only already-approved public data.
