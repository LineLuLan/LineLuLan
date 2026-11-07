// Intent: Prove Line's dashboard totals and safe rendering without network access.
// Status: Fixture-based regression coverage. Next: Run with node --test. Confidence: Executed checks govern readiness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { shapeDashboard } from './dashboard-data.mjs';
import { fetchGitHub, renderDashboard } from './build-dashboard.mjs';

const fixtureText = await readFile(new URL('./fixtures/github-sample.json', import.meta.url), 'utf8');
const fixture = JSON.parse(fixtureText.replace(/^\uFEFF/, ''));
const collection = fixture.data.user.contributionsCollection;
const days = collection.contributionCalendar.weeks.flatMap(week => week.contributionDays);
const model = shapeDashboard(fixture);
const sum = items => items.reduce((total, item) => total + item.count, 0);

test('headline numbers preserve GitHub totals, including private counts', () => {
  assert.equal(model.stats.contributions, 1543);
  assert.equal(model.stats.commits, 466);
  assert.equal(model.stats.pullRequests, 37);
  assert.equal(model.stats.issues, collection.totalIssueContributions);
  assert.equal(model.stats.reviews, collection.totalPullRequestReviewContributions);
  assert.equal(model.stats.restricted, collection.restrictedContributionsCount);
  assert.equal(model.stats.activeDays, days.filter(day => day.contributionCount > 0).length);
  assert.equal(model.stats.activeDays, 97);
});

test('monthly buckets preserve years, partial months, and all contributions', () => {
  assert.equal(sum(model.months), collection.contributionCalendar.totalContributions);
  assert.equal(model.months.length, 13);
  assert.equal(model.months[0].key, '2025-11');
  assert.equal(model.months.at(-1).key, '2026-11');
  for (const month of model.months) {
    assert.equal(month.count, days.filter(day => day.date.startsWith(month.key))
      .reduce((total, day) => total + day.contributionCount, 0));
  }
});

test('weekday totals are Monday through Sunday with correct source mapping', () => {
  assert.deepEqual(model.weekdays.map(day => day.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(sum(model.weekdays), collection.contributionCalendar.totalContributions);
  model.weekdays.forEach((day, index) => assert.equal(day.count,
    days.filter(source => source.weekday === (index + 1) % 7)
      .reduce((total, source) => total + source.contributionCount, 0)));
});

test('language mix excludes forks and repositories without a primary language', () => {
  assert.deepEqual(model.repositories, { total: 25, original: 24, forked: 1 });
  assert.equal(model.languages.repoCount, 19);
  assert.deepEqual(model.languages.items.map(({ name, count }) => [name, count]),
    [['Python', 6], ['TypeScript', 6], ['Jupyter Notebook', 4], ['Java', 3]]);
  assert.ok(Math.abs(model.languages.items.reduce((total, item) => total + item.percentage, 0) - 100) <= 0.1);
});

test('calendar retains all days in their GitHub week and weekday positions', () => {
  assert.equal(model.calendar.length, 53);
  assert.ok(model.calendar.every(week => week.length === 7));
  assert.equal(model.from, '2025-11-02');
  assert.equal(model.to, '2026-11-07');
  assert.deepEqual(model.calendar.flat().filter(Boolean), days);
  const partial = structuredClone(fixture);
  partial.data.user.contributionsCollection.contributionCalendar.weeks[0].contributionDays.shift();
  assert.equal(shapeDashboard(partial).calendar[0][0], null);
});

test('zero activity and no language-bearing repositories render finite values', () => {
  const empty = structuredClone(fixture);
  const c = empty.data.user.contributionsCollection;
  for (const key of Object.keys(c)) if (key !== 'contributionCalendar') c[key] = 0;
  c.contributionCalendar.totalContributions = 0;
  c.contributionCalendar.weeks.forEach(week => week.contributionDays.forEach(day => {
    day.contributionCount = 0;
    day.contributionLevel = 'NONE';
  }));
  empty.data.user.repositories = { totalCount: 0, nodes: [] };
  const data = shapeDashboard(empty);
  assert.equal(data.stats.activeDays, 0);
  assert.deepEqual(data.languages, { repoCount: 0, items: [] });
  assert.equal(sum(data.weekdays), 0);
  assert.doesNotMatch(renderDashboard(data), /NaN|undefined|Infinity/);
});

test('rejects errors, missing data, invalid counts, and incomplete repository lists', () => {
  assert.throws(() => shapeDashboard({ errors: [{ message: 'Denied' }] }), /GraphQL/);
  assert.throws(() => shapeDashboard({ data: { user: null } }), /user/i);
  const invalid = structuredClone(fixture);
  invalid.data.user.contributionsCollection.contributionCalendar.weeks[0].contributionDays[0].contributionCount = -1;
  assert.throws(() => shapeDashboard(invalid), /count/i);
  const truncated = structuredClone(fixture);
  truncated.data.user.repositories.totalCount = 101;
  assert.throws(() => shapeDashboard(truncated), /incomplete|pagination/i);
});

test('SVGs are standalone, accessible, escaped, and static means no animation', () => {
  const svg = renderDashboard(model);
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /<\/svg>\s*$/);
  assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 1000 810"/);
  assert.match(svg, /<title[^>]*>.+<\/title>/);
  assert.match(svg, /<desc[^>]*>.+<\/desc>/);
  assert.doesNotMatch(svg, /NaN|undefined|Infinity|@keyframes|animation:|<animate/);
  const animated = renderDashboard(model, { animated: true });
  assert.match(animated, /@media \(prefers-reduced-motion: no-preference\)/);
  assert.match(animated, /@keyframes/);
  const escaped = structuredClone(model);
  escaped.languages.items[0].name = 'A < B & "C"';
  assert.match(renderDashboard(escaped), /A &lt; B &amp; &quot;C&quot;/);
});

test('fetch sends the specified query and reports HTTP and GraphQL errors safely', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => fixture };
  };
  assert.deepEqual(await fetchGitHub({ token: 'test-only', login: 'LineLuLan', fetchImpl }), fixture);
  assert.equal(request.url, 'https://api.github.com/graphql');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-only');
  assert.deepEqual(JSON.parse(request.options.body).variables, { login: 'LineLuLan' });
  assert.match(JSON.parse(request.options.body).query, /restrictedContributionsCount/);
  await assert.rejects(fetchGitHub({ token: '', fetchImpl }), /GITHUB_TOKEN/);
  await assert.rejects(fetchGitHub({ token: 'test-only', fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  await assert.rejects(fetchGitHub({ token: 'test-only', fetchImpl: async () => ({
    ok: true, json: async () => ({ errors: [{ message: 'Permission denied' }] }),
  }) }), /GraphQL.*Permission denied/);
});

test('CLI uses BOM fixture offline; invalid input preserves both existing SVGs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'line-dashboard-test-'));
  try {
    await cp(new URL('./build-dashboard.mjs', import.meta.url), join(directory, 'build-dashboard.mjs'));
    await cp(new URL('./dashboard-data.mjs', import.meta.url), join(directory, 'dashboard-data.mjs'));
    await writeFile(join(directory, 'fixture.json'), fixtureText);
    // A throwing fetch makes accidental network access a deterministic failure.
    await writeFile(join(directory, 'offline.mjs'), 'globalThis.fetch = () => { throw new Error("Network forbidden"); };');
    const args = ['--import', './offline.mjs', './build-dashboard.mjs', '--fixture', './fixture.json'];
    const run = () => spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    const paths = ['github-dashboard.svg', 'github-dashboard-static.svg'].map(name => join(directory, 'assets', name));
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    assert.equal(before[1], renderDashboard(model));
    await writeFile(join(directory, 'fixture.json'), '{"errors":[{"message":"Permission denied"}]}');
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GraphQL/);
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
