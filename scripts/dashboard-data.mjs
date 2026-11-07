// Intent: Shape GitHub's calendar and public repositories into Line's dashboard.
// Status: Pure, fixture-tested transformations. Next: Keep API validation at this boundary. Confidence: Covered by node:test.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const LEVEL_COLORS = {
  NONE: '#24133a', FIRST_QUARTILE: '#3a1f41', SECOND_QUARTILE: '#7d2554',
  THIRD_QUARTILE: '#a855f7', FOURTH_QUARTILE: '#ff4ecd',
};

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label} count.`);
  return value;
}

export function calendarGrid(weeks) {
  if (!Array.isArray(weeks) || !weeks.length || weeks.length > 54) {
    throw new Error('Missing or invalid contribution calendar weeks.');
  }
  let previousDate;
  return Array.from({ length: Math.max(53, weeks.length) }, (_, column) => {
    const slots = Array(7).fill(null);
    if (column >= weeks.length) return slots;
    const days = weeks[column]?.contributionDays;
    if (!Array.isArray(days) || !days.length) throw new Error('Missing contribution days.');
    let weekStart;
    for (const day of days) {
      const timestamp = Date.parse(`${day.date}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(timestamp)
          || new Date(timestamp).toISOString().slice(0, 10) !== day.date
          || day.weekday !== new Date(timestamp).getUTCDay()
          || (previousDate && day.date <= previousDate)) {
        throw new Error('Invalid contribution date or weekday order.');
      }
      const start = timestamp - day.weekday * 86400000;
      if (weekStart !== undefined && weekStart !== start) throw new Error('Invalid calendar week grouping.');
      weekStart = start;
      count(day.contributionCount, 'contribution');
      if (!Object.hasOwn(LEVEL_COLORS, day.contributionLevel)) throw new Error('Invalid contribution level.');
      slots[day.weekday] = { ...day };
      previousDate = day.date;
    }
    return slots;
  });
}

export function contributionStats(collection, days) {
  return {
    contributions: count(collection.contributionCalendar.totalContributions, 'calendar'),
    commits: count(collection.totalCommitContributions, 'commit'),
    pullRequests: count(collection.totalPullRequestContributions, 'pull request'),
    issues: count(collection.totalIssueContributions, 'issue'),
    reviews: count(collection.totalPullRequestReviewContributions, 'review'),
    restricted: count(collection.restrictedContributionsCount, 'restricted contribution'),
    activeDays: days.filter(day => day.contributionCount > 0).length,
  };
}

export function monthlyTotals(days) {
  const months = new Map();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    if (!months.has(key)) months.set(key, { key, label: MONTHS[Number(key.slice(5)) - 1], count: 0 });
    months.get(key).count += day.contributionCount;
  }
  return [...months.values()];
}

export function weekdayTotals(days) {
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(label => ({ label, count: 0 }));
  for (const day of days) weekdays[(day.weekday + 6) % 7].count += day.contributionCount;
  return weekdays;
}

export function repositorySplit(repositories) {
  const forked = repositories.filter(repo => repo.isFork).length;
  return { total: repositories.length, original: repositories.length - forked, forked };
}

export function languageMix(repositories) {
  const languages = new Map();
  let repoCount = 0;
  for (const repo of repositories) {
    if (repo.isFork || !repo.primaryLanguage) continue;
    const { name, color } = repo.primaryLanguage;
    if (!languages.has(name)) languages.set(name, { name, color: color || '#8b7aa8', count: 0 });
    languages.get(name).count++;
    repoCount++;
  }
  const items = [...languages.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  // Allocate tenths by largest remainder so displayed percentages total exactly 100%.
  const tenths = items.map(item => Math.floor(item.count * 1000 / repoCount));
  const order = items.map((item, index) => ({ index, remainder: item.count * 1000 / repoCount - tenths[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const remaining = items.length ? 1000 - tenths.reduce((total, value) => total + value, 0) : 0;
  for (let index = 0; index < remaining; index++) tenths[order[index].index]++;
  return { repoCount, items: items.map((item, index) => ({ ...item, percentage: tenths[index] / 10 })) };
}

export function shapeDashboard(payload) {
  if (payload?.errors?.length) throw new Error(`GitHub GraphQL: ${payload.errors.map(error => error.message).join('; ')}`);
  const user = payload?.data?.user;
  if (!user) throw new Error('GitHub user was not found or is inaccessible.');
  const collection = user.contributionsCollection;
  if (!collection?.contributionCalendar) throw new Error('Missing contribution calendar.');
  const calendar = calendarGrid(collection.contributionCalendar.weeks);
  const days = calendar.flat().filter(Boolean);
  const stats = contributionStats(collection, days);
  if (days.reduce((total, day) => total + day.contributionCount, 0) !== stats.contributions) {
    throw new Error('Contribution day counts do not match the calendar total.');
  }
  const repositories = user.repositories;
  if (!Array.isArray(repositories?.nodes)
      || repositories.nodes.length !== count(repositories.totalCount, 'repository')) {
    throw new Error('Incomplete public repository list; pagination is required above 100 repositories.');
  }
  for (const repo of repositories.nodes) {
    if (!repo || typeof repo.isFork !== 'boolean'
        || (repo.primaryLanguage !== null && (!repo.primaryLanguage?.name
          || typeof repo.primaryLanguage.name !== 'string'
          || (repo.primaryLanguage.color !== null && !/^#[\da-f]{6}$/i.test(repo.primaryLanguage.color))))) {
      throw new Error('Invalid public repository or primary language.');
    }
  }
  return {
    from: days[0].date, to: days.at(-1).date, stats, calendar,
    months: monthlyTotals(days), weekdays: weekdayTotals(days),
    repositories: repositorySplit(repositories.nodes), languages: languageMix(repositories.nodes),
  };
}
