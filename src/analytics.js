// Admin > Analytics. Built from three sources:
//   visits  - one row per browser per UTC day (counted on every page load)
//   events  - page views, clicks and the sign-up / wallet screens opening,
//             sent by public/js/track.js
//   users, ledger, games - what accounts actually went on to do
// Browsers that an admin has ever signed in on are left out everywhere.

const DAY = 86_400_000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

// Furthest step an account has reached, in order.
export const STAGES = ['signed_up', 'wallet', 'deposited', 'played', 'regular'];
const REGULAR_GAMES = 5;

export async function analytics(db, { days = 30, now = Date.now() } = {}) {
  const fromDay = isoDay(now - (days - 1) * DAY);
  const since = Date.parse(`${fromDay}T00:00:00Z`);
  const sinceDate = new Date(since);
  const dayList = Array.from({ length: days }, (_, i) => isoDay(since + i * DAY));

  const adminIds = (await db.users.find({ is_admin: { $in: [1, true] } }, { projection: { _id: 1 } })).map((u) => u.id);
  const adminDevices = (await db.user_devices.find({ user_id: { $in: adminIds } }, { projection: { device_id: 1 } })).map((d) => d.device_id);
  const device = { $nin: adminDevices };

  // ---- visitors ----
  const visits = await db.visits.find({ day: { $gte: fromDay }, device }, { projection: { day: 1, device: 1 } });
  const visitorSet = new Set(visits.map((v) => v.device));
  const visitorsByDay = count(visits, (v) => v.day);

  // ---- events ----
  const events = await db.events.find(
    { at: { $gte: sinceDate }, device },
    { projection: { kind: 1, device: 1, user_id: 1, session: 1, path: 1, label: 1, ref: 1, mobile: 1, at: 1 }, sort: { at: 1 } },
  );
  const first = await db.events.findOne({}, { projection: { at: 1 }, sort: { at: 1 } });
  const openedSignup = new Set(events.filter((e) => e.kind === 'auth_open' && e.label === 'register').map((e) => e.device));

  // Where each browser came from (first view with a source in the range)
  // and whether it was last seen on a phone-sized screen.
  const sourceOf = new Map();
  const mobileOf = new Map();
  for (const e of events) {
    if (e.kind !== 'view') continue;
    if (e.ref && !sourceOf.has(e.device)) sourceOf.set(e.device, e.ref);
    mobileOf.set(e.device, !!e.mobile);
  }
  const seenDevices = new Set(events.map((e) => e.device));
  const sourceName = (dev) => (!dev || !seenDevices.has(dev) ? null : sourceOf.get(dev) || 'Direct');

  // ---- accounts made in the range ----
  const users = await db.users.find(
    { created_at: { $gte: since }, is_admin: { $nin: [1, true] } },
    { projection: { username: 1, created_at: 1, device_id: 1, status: 1, last_seen: 1 }, sort: { _id: -1 } },
  );
  const ids = users.map((u) => u.id);
  const [walletEvents, deposits, games] = await Promise.all([
    db.events.aggregate([{ $match: { kind: 'wallet_open', user_id: { $in: ids } } }, { $group: { _id: '$user_id' } }]),
    db.ledger.aggregate([
      { $match: { kind: 'deposit', user_id: { $in: ids } } },
      { $group: { _id: '$user_id', total: { $sum: '$amount' }, n: { $sum: 1 }, first: { $min: '$created_at' } } },
    ]),
    db.games.aggregate([
      { $match: { status: 'finished', $or: [{ white_id: { $in: ids } }, { black_id: { $in: ids } }] } },
      { $project: { p: ['$white_id', '$black_id'] } },
      { $unwind: '$p' },
      { $match: { p: { $in: ids } } },
      { $group: { _id: '$p', n: { $sum: 1 } } },
    ]),
  ]);
  const opened = new Set(walletEvents.map((w) => w._id));
  const dep = new Map(deposits.map((d) => [d._id, d]));
  const played = new Map(games.map((g) => [g._id, g.n]));

  const players = users.map((u) => {
    const d = dep.get(u.id);
    const n = played.get(u.id) || 0;
    // A deposit or a game means the earlier screens were seen, even if that
    // happened before tracking started.
    const stage = n >= REGULAR_GAMES ? 'regular' : n ? 'played' : d ? 'deposited' : opened.has(u.id) ? 'wallet' : 'signed_up';
    return {
      id: u.id, username: u.username, createdAt: u.created_at, lastSeen: u.last_seen, status: u.status,
      stage, deposited: d?.total || 0, deposits: d?.n || 0, firstDepositAt: d?.first || null, games: n,
      source: sourceName(u.device_id), mobile: mobileOf.get(u.device_id) ?? null,
    };
  });
  const reached = (s) => players.filter((p) => STAGES.indexOf(p.stage) >= STAGES.indexOf(s)).length;

  const funnel = [
    { key: 'visited', label: 'Visited the site', n: visitorSet.size, unit: 'browsers' },
    { key: 'signup_open', label: 'Opened the sign-up form', n: openedSignup.size, unit: 'browsers' },
    { key: 'signed_up', label: 'Created an account', n: players.length, unit: 'accounts' },
    { key: 'wallet', label: 'Opened the wallet', n: reached('wallet'), unit: 'accounts' },
    { key: 'deposited', label: 'Made a deposit', n: reached('deposited'), unit: 'accounts' },
    { key: 'played', label: 'Played a game', n: reached('played'), unit: 'accounts' },
    { key: 'regular', label: `Played ${REGULAR_GAMES}+ games`, n: reached('regular'), unit: 'accounts' },
  ];

  // ---- day by day ----
  const signupsByDay = count(users, (u) => isoDay(u.created_at));
  const firstDeposits = await db.ledger.aggregate([
    { $match: { kind: 'deposit', user_id: { $nin: [null, ...adminIds] } } },
    { $sort: { created_at: 1 } },
    { $group: { _id: '$user_id', first: { $first: '$created_at' }, amount: { $first: '$amount' } } },
    { $match: { first: { $gte: since } } },
  ]);
  const firstDepByDay = count(firstDeposits, (d) => isoDay(d.first));
  const depositSum = await db.ledger.aggregate([
    { $match: { kind: 'deposit', created_at: { $gte: since }, user_id: { $nin: [null, ...adminIds] } } },
    { $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 }, people: { $addToSet: '$user_id' } } },
  ]);
  const daily = dayList.map((day) => ({
    day, visitors: visitorsByDay.get(day) || 0, signups: signupsByDay.get(day) || 0, firstDeposits: firstDepByDay.get(day) || 0,
  }));

  // ---- visits (browser tab sessions) ----
  const sessions = new Map();
  for (const e of events) {
    if (!e.session) continue;
    let s = sessions.get(e.session);
    if (!s) sessions.set(e.session, (s = { views: 0, clicks: 0, start: +e.at, end: +e.at, last: null }));
    s.end = +e.at;
    if (e.kind === 'view') { s.views++; s.last = e.path; }
    if (e.kind === 'click') s.clicks++;
  }
  const list = [...sessions.values()].filter((s) => s.views);
  const lengths = list.filter((s) => s.end > s.start).map((s) => s.end - s.start).sort((a, b) => a - b);
  const depth = [
    { label: '1 page', n: list.filter((s) => s.views === 1).length },
    { label: '2 pages', n: list.filter((s) => s.views === 2).length },
    { label: '3 to 5 pages', n: list.filter((s) => s.views >= 3 && s.views <= 5).length },
    { label: '6 or more', n: list.filter((s) => s.views >= 6).length },
  ];

  // ---- pages, exits, clicks ----
  const views = events.filter((e) => e.kind === 'view');
  const exits = count(list, (s) => s.last);
  const pages = groupRows(views, (e) => e.path).map((r) => ({ ...r, exits: exits.get(r.key) || 0 }));
  const clicks = groupRows(events.filter((e) => e.kind === 'click' && e.label), (e) => `${e.label}\u0000${e.path}`)
    .slice(0, 30).map((r) => { const [label, path] = r.key.split('\u0000'); return { label, path, n: r.n, people: r.people }; });

  // ---- sources and screen size ----
  const bySource = new Map();
  for (const dev of visitorSet) {
    const s = sourceName(dev);
    if (!s) continue;
    const row = bySource.get(s) || bySource.set(s, { source: s, visitors: 0, signups: 0, depositors: 0 }).get(s);
    row.visitors++;
  }
  for (const p of players) {
    if (!p.source) continue;
    const row = bySource.get(p.source) || bySource.set(p.source, { source: p.source, visitors: 0, signups: 0, depositors: 0 }).get(p.source);
    row.signups++;
    if (p.deposits) row.depositors++;
  }
  const screen = [true, false].map((m) => {
    const devs = [...visitorSet].filter((d) => mobileOf.get(d) === m);
    const ps = players.filter((p) => p.mobile === m);
    return { label: m ? 'Phone or tablet' : 'Computer', visitors: devs.length, signups: ps.length, depositors: ps.filter((p) => p.deposits).length };
  });

  const ds = depositSum[0];
  return {
    days, from: fromDay, to: isoDay(now),
    trackingSince: first?.at ? +first.at : null,
    funnel, daily, players: players.slice(0, 500),
    money: {
      total: ds?.total || 0, deposits: ds?.n || 0, depositors: ds?.people.length || 0,
      firstDepositors: firstDeposits.length,
      avgFirst: firstDeposits.length ? Math.round(firstDeposits.reduce((s, d) => s + d.amount, 0) / firstDeposits.length) : 0,
    },
    visits: {
      count: list.length,
      bounce: list.length ? list.filter((s) => s.views === 1 && !s.clicks).length / list.length : 0,
      pagesPer: list.length ? views.length / list.length : 0,
      medianMs: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0,
      depth,
    },
    pages: pages.slice(0, 20), clicks,
    sources: [...bySource.values()].sort((a, b) => b.visitors - a.visitors || b.signups - a.signups).slice(0, 20),
    screen,
  };
}

function count(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (k != null) m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

// [{ key, n, people }] sorted by n, where people = distinct browsers.
function groupRows(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const g = m.get(k) || m.set(k, { key: k, n: 0, devs: new Set() }).get(k);
    g.n++;
    g.devs.add(r.device);
  }
  return [...m.values()].map((g) => ({ key: g.key, n: g.n, people: g.devs.size })).sort((a, b) => b.n - a.n);
}
