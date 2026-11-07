// Intent: Generate Line's self-hosted GitHub activity SVGs with no dependencies.
// Status: Fixture and authenticated GraphQL modes. Next: Refresh daily through dashboard.yml. Confidence: Fixture-tested; live permissions depend on GitHub.
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LEVEL_COLORS, shapeDashboard } from './dashboard-data.mjs';

export const QUERY = `query Dashboard($login: String!) {
  user(login: $login) {
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel weekday } }
      }
    }
    repositories(first: 100, ownerAffiliations: OWNER, privacy: PUBLIC) {
      totalCount
      nodes { name isFork primaryLanguage { name color } stargazerCount }
    }
  }
}`;

export async function fetchGitHub({ token, login = 'LineLuLan', fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('GITHUB_TOKEN is required when --fixture is not supplied.');
  let response;
  try {
    response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'LineLuLan-dashboard' },
      body: JSON.stringify({ query: QUERY, variables: { login } }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('GitHub GraphQL request failed or timed out. Existing SVGs were preserved.');
  }
  if (!response.ok) throw new Error(`GitHub GraphQL HTTP ${response.status}. Check token permissions and rate limits.`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('GitHub returned invalid JSON.'); }
  if (payload.errors?.length) {
    const message = payload.errors.map(error => error.message).join('; ').split(token).join('[redacted]');
    throw new Error(`GitHub GraphQL: ${message}`);
  }
  return payload;
}

const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[character]);
const number = value => value.toLocaleString('en-US');
const fixed = value => Number(value.toFixed(2));
const text = (x, y, value, attributes = '') => `<text x="${fixed(x)}" y="${fixed(y)}" ${attributes}>${escape(value)}</text>`;
const rect = (x, y, width, height, attributes = '') => `<rect x="${fixed(x)}" y="${fixed(y)}" width="${fixed(width)}" height="${fixed(height)}" ${attributes}/>`;

function renderCalendar(model) {
  const step = 866 / model.calendar.length;
  let lastMonth;
  const parts = [text(32, 222, 'Contribution calendar', 'class="panel-title"')];
  model.calendar.forEach((week, column) => {
    const firstDay = week.find(Boolean);
    const monthDay = week.find(day => day?.date.endsWith('-01')) || (column === 0 ? firstDay : null);
    if (monthDay && monthDay.date.slice(0, 7) !== lastMonth) {
      const month = model.months.find(item => item.key === monthDay.date.slice(0, 7));
      parts.push(text(86 + column * step, 244, month.label, 'class="muted" font-size="10"'));
      lastMonth = month.key;
    }
    week.forEach((day, row) => {
      const tooltip = day ? `${day.date}: ${number(day.contributionCount)} contributions` : 'Outside the reporting period';
      parts.push(`<g class="heat" style="--delay:${fixed(column / Math.max(1, model.calendar.length - 1) * 1.2)}s">`
        + rect(86 + column * step, 254 + row * 16.4, step - 3, 13.4,
          `rx="2.5" fill="${day ? LEVEL_COLORS[day.contributionLevel] : '#24133a'}"${day ? '' : ' opacity="0.25"'}`)
        + `<title>${escape(tooltip)}</title></g>`);
    });
  });
  ['Mon', 'Wed', 'Fri'].forEach((label, index) => parts.push(text(48, 281 + index * 32.8, label, 'font-size="10" class="muted"')));
  parts.push(text(32, 394, `${number(model.stats.activeDays)} days with a contribution`, 'font-size="10" class="muted"'));
  parts.push(text(790, 394, 'Less', 'font-size="10" class="muted"'));
  Object.values(LEVEL_COLORS).forEach((color, index) => parts.push(rect(825 + index * 18, 383, 13, 13, `rx="2.5" fill="${color}"`)));
  parts.push(text(923, 394, 'More', 'font-size="10" class="muted"'));
  return parts.join('\n');
}

function panel(x, title, subtitle) {
  return rect(x, 414, 300, 292, 'rx="12" fill="#140a24" stroke="#3a1f41"')
    + text(x + 18, 444, title, 'class="panel-title"')
    + text(x + 18, 464, subtitle, 'font-size="10" class="muted"');
}

function renderMonths(months) {
  const baseline = 646;
  const maximum = Math.max(1, ...months.map(month => month.count));
  const points = months.map((month, index) => ({
    x: 52 + index * 260 / Math.max(1, months.length - 1), y: baseline - month.count / maximum * 134, month,
  }));
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${fixed(point.x)},${fixed(point.y)}`).join(' ');
  return panel(32, 'Monthly rhythm', 'Contributions by calendar month')
    + `<path d="M52,${baseline} ${path.replace(/^M/, 'L')} L312,${baseline} Z" fill="url(#monthly-fill)"/>`
    + `<path d="${path}" class="monthly-line" pathLength="1" fill="none" stroke="#ff4ecd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<path d="M50,${baseline} H314" stroke="#3a1f41"/>`
    + points.map(({ x, y, month }) => `<circle cx="${fixed(x)}" cy="${fixed(y)}" r="2.6" fill="#ff4ecd"/>`
      + text(x, y - 10, number(month.count), 'font-size="8.5" text-anchor="middle"')
      + text(x, 668, month.label[0], 'font-size="10" text-anchor="middle" class="muted"')
      + `<title>${escape(month.key)}: ${month.count} contributions</title>`).join('')
    + text(50, 689, `${months[0].key} → ${months.at(-1).key}`, 'font-size="9" class="muted"');
}

function renderLanguages(languages) {
  const radius = 49;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  let output = panel(348, 'Language mix', 'Primary language · original public repos')
    + `<circle cx="498" cy="532" r="${radius}" fill="none" stroke="#24133a" stroke-width="16"/>`;
  for (const language of languages.items) {
    const length = language.count / languages.repoCount * circumference;
    output += `<circle cx="498" cy="532" r="${radius}" fill="none" stroke="${escape(language.color)}" stroke-width="16" stroke-dasharray="${fixed(length)} ${fixed(circumference - length)}" stroke-dashoffset="${fixed(-offset)}" transform="rotate(-90 498 532)"><title>${escape(language.name)}: ${language.count} repos (${language.percentage.toFixed(1)}%)</title></circle>`;
    offset += length;
  }
  output += text(498, 533, number(languages.repoCount), 'text-anchor="middle" font-size="27" fill="#f5d6e8" font-weight="600"')
    + text(498, 551, 'repos', 'text-anchor="middle" font-size="10" class="muted"');
  if (!languages.items.length) return output + text(498, 624, 'No primary languages yet', 'text-anchor="middle" font-size="11"');
  // Switch to two columns if the public language set grows; every name remains in a title.
  const columns = languages.items.length > 4 ? 2 : 1;
  const rows = Math.ceil(languages.items.length / columns);
  const spacing = Math.min(21, 90 / rows);
  languages.items.forEach((language, index) => {
    const x = 366 + Math.floor(index / rows) * 140;
    const y = 610 + index % rows * spacing;
    const label = columns === 1 ? language.name : language.name.length > 13 ? `${language.name.slice(0, 12)}…` : language.name;
    output += `<g><title>${escape(language.name)}: ${language.count} repos (${language.percentage.toFixed(1)}%)</title>`
      + rect(x, y - 8, 7, 7, `rx="2" fill="${escape(language.color)}"`)
      + text(x + 13, y, label, `font-size="${columns === 1 ? 10 : 8}"`)
      + text(columns === 1 ? 630 : x + 130, y + (columns === 1 ? 0 : 9), `${language.count} · ${language.percentage.toFixed(1)}%`, `font-size="${columns === 1 ? 10 : 8}" text-anchor="end"`)
      + '</g>';
  });
  return output;
}

function renderWeekdays(weekdays) {
  const max = Math.max(1, ...weekdays.map(day => day.count));
  return panel(664, 'Weekday pulse', 'Contributions by day of the week')
    + '<path d="M682,646 H946" stroke="#3a1f41"/>'
    + weekdays.map((day, index) => {
      const x = 686 + index * 37;
      const height = day.count / max * 134;
      return rect(x, 646 - height, 24, height, `rx="4" fill="${day.count === max ? '#ff4ecd' : '#a855f7'}" class="pulse-bar"`)
        + text(x + 12, 636 - height, number(day.count), 'font-size="10" text-anchor="middle"')
        + text(x + 12, 668, day.label, 'font-size="9" text-anchor="middle" class="muted"');
    }).join('')
    + text(682, 689, 'One week, a year of activity', 'font-size="9" class="muted"');
}

export function renderDashboard(model, { animated = false, updated = model.to } = {}) {
  const stats = [
    ['Contributions', model.stats.contributions], ['Commits', model.stats.commits],
    ['Pull requests', model.stats.pullRequests], ['Active days', model.stats.activeDays],
  ];
  const { total, original, forked } = model.repositories;
  const animation = animated ? `
@media (prefers-reduced-motion: no-preference) {
  .heat { animation: reveal .5s ease-out var(--delay) both; }
  .pulse-bar { transform-box: fill-box; transform-origin: center bottom; animation: grow .9s ease-out .2s both; }
  .monthly-line { animation: draw 1.6s ease-out both; }
  @keyframes reveal { from { opacity: 0; } to { opacity: 1; } }
  @keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  @keyframes draw { from { stroke-dasharray: 1; stroke-dashoffset: 1; } to { stroke-dasharray: 1; stroke-dashoffset: 0; } }
}` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="810" viewBox="0 0 1000 810" role="img" aria-labelledby="dashboard-title dashboard-desc">
<title id="dashboard-title">GitHub / the work in numbers</title>
<desc id="dashboard-desc">${escape(`${model.from} to ${model.to}: ${number(model.stats.contributions)} contributions, ${number(model.stats.commits)} commits, ${number(model.stats.pullRequests)} pull requests and ${model.stats.activeDays} active days. A contribution calendar, monthly activity, primary languages and weekday totals. ${total} public repositories: ${original} original and ${forked} forked.`)}</desc>
<defs>
  <linearGradient id="monthly-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff4ecd" stop-opacity=".3"/><stop offset="1" stop-color="#ff4ecd" stop-opacity="0"/></linearGradient>
  <clipPath id="repo-clip"><rect x="32" y="754" width="932" height="8" rx="4"/></clipPath>
</defs>
<style>
  text { font-family: 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace; fill: #cbb8e6; }
  .title, .panel-title { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; fill: #f5d6e8; font-weight: 600; }
  .title { font-size: 26px; }
  .panel-title { font-size: 16px; }
  .muted { fill: #8b7aa8; }
  .stat { fill: #ff4ecd; font-size: 35px; font-weight: 600; }
  .updated-dot { fill: #ff4ecd; }
${animation}
</style>
<rect x=".5" y=".5" width="999" height="809" rx="16" fill="#1a0d2e" stroke="#3a1f41"/>
${text(32, 51, 'GitHub / the work in numbers', 'class="title"')}
${text(32, 77, `contributions · ${model.from} → ${model.to}`, 'font-size="12"')}
<text x="964" y="48" text-anchor="end" font-size="11"><tspan class="updated-dot">●</tspan> Updated ${escape(updated)}</text>
${stats.map(([label, value], index) => text(32 + index * 240, 144, number(value), 'class="stat"')
  + text(32 + index * 240, 170, label, 'font-size="12"')
  + (index < 3 ? `<path d="M${252 + index * 240},111 V174" stroke="#3a1f41"/>` : '')).join('\n')}
<path d="M32,192 H964" stroke="#3a1f41"/>
${renderCalendar(model)}
${renderMonths(model.months)}
${renderLanguages(model.languages)}
${renderWeekdays(model.weekdays)}
<path d="M32,722 H964" stroke="#3a1f41"/>
${text(32, 743, 'Repository split', 'font-size="12"')}
${text(964, 743, `${total} public repos · ${original} original · ${forked} forked`, 'font-size="11" text-anchor="end"')}
<g clip-path="url(#repo-clip)">${rect(32, 754, 932, 8, 'fill="#3a1f41"')}${rect(32, 754, total ? original / total * 932 : 0, 8, 'fill="#ff4ecd"')}</g>
${text(32, 790, "Counts from GitHub's contribution calendar, including private activity counts. Languages use public repositories.", 'font-size="10" class="muted"')}
</svg>\n`;
}

async function main(args) {
  if (args.length && (args.length !== 2 || args[0] !== '--fixture' || !args[1])) {
    throw new Error('Usage: node scripts/build-dashboard.mjs [--fixture path/to/github.json]');
  }
  const fixture = args.length === 2;
  let payload;
  if (fixture) {
    const source = await readFile(args[1], 'utf8');
    try { payload = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { throw new Error('Fixture contains invalid JSON.'); }
  } else {
    payload = await fetchGitHub({ token: process.env.GITHUB_TOKEN, login: process.env.GH_LOGIN || 'LineLuLan' });
  }
  const model = shapeDashboard(payload);
  const updated = fixture ? model.to : new Date().toISOString().slice(0, 10);
  const outputs = [
    ['github-dashboard.svg', renderDashboard(model, { animated: true, updated })],
    ['github-dashboard-static.svg', renderDashboard(model, { updated })],
  ];
  // Validate and stage both complete documents before replacing the previous good files.
  for (const [, svg] of outputs) {
    if (!svg.startsWith('<svg') || !svg.endsWith('</svg>\n') || /NaN|undefined|Infinity/.test(svg)) {
      throw new Error('SVG validation failed; existing files were preserved.');
    }
  }
  await mkdir('assets', { recursive: true });
  const temporary = outputs.map(([name]) => resolve('assets', `.${name}.${process.pid}.tmp`));
  try {
    for (let index = 0; index < outputs.length; index++) await writeFile(temporary[index], outputs[index][1], 'utf8');
    for (let index = 0; index < outputs.length; index++) await rename(temporary[index], resolve('assets', outputs[index][0]));
  } finally {
    await Promise.all(temporary.map(path => rm(path, { force: true })));
  }
  for (const [name, svg] of outputs) console.log(`assets/${name}: ${Buffer.byteLength(svg)} bytes`);
  console.log(`${number(model.stats.contributions)} contributions · ${number(model.stats.commits)} commits · ${number(model.stats.pullRequests)} pull requests · ${model.stats.activeDays} active days`);
  console.log(`${totalDescription(model.repositories)} · ${model.languages.repoCount} original repos with a primary language`);
}

function totalDescription({ total, original, forked }) {
  return `${total} public repos · ${original} original · ${forked} forked`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const token = process.env.GITHUB_TOKEN;
    const message = token ? error.message.split(token).join('[redacted]') : error.message;
    console.error(`Dashboard: ${message}`);
    process.exitCode = 1;
  });
}
