# jeju-place-data

제주·전국 장소 웹앱의 **공개 데이터 전용** GitHub Pages publisher.

This public repository contains the publisher, tests, and current approved public snapshots. The original `brown1119/jeju-place` repository must remain **private**. Do not copy its Apps Script source, spreadsheet credentials, API keys, AI raw facts, or private columns here. Test fixtures are synthetic and stay in `test/` / temporary test directories; they are never published.

## Setup and manual updates

1. Keep this repository public and the original application repository private.
2. In this repository, open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. The current repository setting is already `workflow`.
3. The existing private GAS project contains the read-only snapshot builder and publisher. It pushes only `public/jeju.json` and `public/national.json`; there is no anonymous GAS export URL.
4. Create a fine-grained GitHub token limited to this repository with **Contents: Read and write** and no Actions permission. Add it in the existing GAS project’s **Project Settings → Script Properties** as `PUBLIC_DATA_GITHUB_TOKEN`. Do not put the token in source, this repository, Actions variables, or chat.
5. As the owner, run `publishPublicDataNow()` once in the existing GAS editor to seed both snapshot files. Automatic publishing is disabled. To remove a previously installed publisher timer, run `removePublicDataPublisherTrigger()` once; if it reports another publishing operation holds the lock, retry after that operation finishes. For later updates, run `publishPublicDataNow()` or choose the spreadsheet Support menu item. Identical snapshots do not create a commit.
6. Each token-authenticated data push triggers **GitHub Actions**, which tests the publisher contract, validates committed snapshots, creates Pages metadata locally, validates the complete public artifact, and deploys only `public/` to Pages. A manual workflow run republishes the latest committed snapshots and requires both snapshot files to exist; it does not read GAS.

Local checks require Node LTS; there are no npm dependencies:

```sh
node --test test/*.test.mjs
node scripts/sync-data.mjs --prepare
node scripts/sync-data.mjs --validate
```

These CLI commands operate only on the checked-out repository. They do not read the spreadsheet, call GAS, commit, push, change settings, or deploy. `--prepare` requires valid committed `public/jeju.json` and `public/national.json`; missing or invalid snapshots fail closed. A rejected GAS export never reaches GitHub, and a rejected commit never reaches Pages. The previous Pages deployment remains live when validation or deployment fails.

## Source contract and publication boundary

Each committed region snapshot has exactly `{schemaVersion:1, region:'JEJU'|'NATIONAL', version, generatedAt, rows}`. GAS reads both regions together, uses canonical field order, validates both before any Git write, and pushes changed files together in one non-force Git commit. Snapshot timestamps are per-region: when a region's rows are unchanged, its previous bytes and `generatedAt` remain untouched. `version` is the lowercase SHA-256 of UTF-8 `JSON.stringify(rows)` after canonicalizing each row's keys in the allowlist order. Array/row order remains source order; meaningful row ordering changes update the version.

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
- Additional text bounds (UTF-16 code units): `nameVerified`, `rating`, `verifiedAt`, `address`, `closedDays`, `hours` up to 2,000; `menu` up to 10,000; `review`, `note` up to 20,000; `subregion`, `sido`, `sigungu`, `status`, `confidence`, `category` up to 200. The canonical ISO UTC timestamp rule applies to snapshot `generatedAt` and freshness metadata, **not** row `verifiedAt`.
- Approved text fields are also checked for recognizable GitHub token, Google `AIza` API-key, and legacy/project/service-account/admin OpenAI key shapes. A match rejects the entire response/artifact without logging its value. Plain labels such as `API_KEY` or `GITHUB_TOKEN`, ordinary business/phone numbers and prices are not credentials. This is **not a complete secret scanner**: arbitrary private text, unknown token formats and encoded/fragmented secrets still require owner review. Detection does not authenticate any token or prove whether it is live.
- At most 20,000 rows per region, matching the GAS publisher and client validator. Each snapshot file is capped at **4 MiB**; oversized snapshots are rejected before the Git API write or Pages deployment.

The existing GAS publisher uses the exact Reader display contract above; it does not expose an anonymous export endpoint. If the sheet schema changes, review both the GAS snapshot validator and this Pages validator, update tests first, and never silently widen the row allowlist. Source text and credential values are not printed in logs.

Before any Git API write, GAS validates both region arrays, exact row keys/types/bounds, recognizable credential-shaped strings, canonical snapshot hashes, and the 4 MiB per-file cap. It compares existing blob contents and keeps prior bytes/timestamps when rows are unchanged. Changed files are written with the Git Data API as one commit and the `main` ref is advanced with `force:false`; a ref conflict is retried from the current head. The token stays in Apps Script Script Properties and is sent only in the GitHub API authorization header. Pages Actions has read-only repository permission and does not fetch or push source data.

## Generated assets and freshness

The only permitted Pages assets are:

| Asset | Meaning | Tracked in git? |
| --- | --- | --- |
| `jeju.json`, `national.json` | Approved region snapshots pushed by the existing GAS project | Yes |
| `index.html`, `.nojekyll` | Generated status/index markup and Pages marker | Yes (seed files; rebuilt in the artifact) |
| `health.json` | Most recent successful Pages validation included in the artifact | Yes (seed file; refreshed in the artifact) |
| `status.json` | Latest validation time, snapshot timestamps, row counts, and hashes | No; generated for every deployment |

Each region snapshot has exactly `{schemaVersion:1, region:'JEJU'|'NATIONAL', version, generatedAt, rows}`. `version` is the lowercase SHA-256 of UTF-8 `JSON.stringify(rows)` after canonicalizing each row's keys in the allowlist order. Array/row order remains source order; meaningful row ordering changes update the version.

When row contents/version are unchanged, snapshot **bytes, file modification times, and `generatedAt` remain unchanged**. `generatedAt` records the source export timestamp used when that content version was first published; it is **not** the last verification timestamp. The client consumes only region snapshots and must **not age-expire unchanged data based on `generatedAt`**.

`health.json` contains exactly `{schemaVersion:1,lastVerifiedAt}` and is set to the time of the most recent successful Pages validation run. It advances when data changes trigger a deployment or when an owner manually dispatches one; it is not a 15-minute heartbeat. `status.json` reports that run's validation time, per-region snapshot timestamps, row counts, and hashes. The status page links both metadata files plus each snapshot's timestamp, row count, and hash. Metadata records publisher validation, not whether every individual place was recently reviewed.

Pages/CDN/browser caches can serve an earlier deployment temporarily. After a GAS push, inspect the workflow's successful deployment and `status.json` / `health.json`; a cache-busting query or browser cache bypass can help diagnose old cached responses, but is not a consistency or freshness guarantee. There is no promised propagation delay or speed improvement.

## Workflow and schedule caveats

The owner runs the existing GAS publisher manually when a refresh is needed. Each changed-data push writes one commit to `main`; identical content produces no commit. `.github/workflows/publish.yml` runs on those data-file pushes and on manual dispatch. A shared concurrency group serializes Pages deployments, with `cancel-in-progress: false`. GitHub Actions is not the data scheduler and has no cron trigger in this design.

If the owner does not publish, the token is revoked, or an Actions deployment fails, no new data becomes live; the last successful Pages deployment remains available. Check Apps Script executions after manual publishing and the repository Actions run after a failure.

The GAS token is a fine-grained credential limited to this data repository's **Contents: Read and write** permission. The workflow has only `contents:read`, `pages:write`, and `id-token:write`; it does not receive the GAS token or write source snapshots. The workflow performs upload and Pages deployment in one run, so the `GITHUB_TOKEN` recursion restriction is not relevant to the source push.

The upload action points **only at `public/`**, never `.` or the repository root. Immediately before upload the validator requires exactly the six allowlisted regular files, rejects unknown files/directories/symlinks and oversized assets, validates all JSON/hash/metadata relationships, and requires the index to match the publisher's generated markup. Only the known empty `.nojekyll` hidden file is included. Scripts, tests, README, `.github`, and source responses are outside the artifact.

## Verification and official references

The Node built-in test suite covers the exact row contract, credential-shaped text rejection, schema/hash/timestamp checks, byte and row limits, local-only legacy importer regression helpers, preparation and validation of committed snapshots, metadata generation, artifact allowlisting, rollback behavior, CLI exits, README and workflow contract. The active CLI/workflow path reads only committed JSON and performs no source-endpoint fetch. Fixtures are isolated in temporary directories; source values and credentials are never printed.

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

Initial end-to-end verification of the existing private GAS GitHub publisher and this Pages workflow still requires owner setup/execution. Unit and integration tests do not substitute for checking that the real source contains only already-approved public data.
