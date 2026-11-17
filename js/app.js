import {
  MIN, CONSTANTS, parseReadingsCsv, dedupeReadings, importSummary, evaluateTest, rankFoods, prickSchedule,
  nextPrick, formatCountdown, foodNames, normFood, validateBackup, daysSince, round1,
} from './logic.js';
import { readReadingsCsvFromZip } from './zip.js';
import * as db from './db.js';

// ---------- tiny DOM helpers ----------
const SVGNS = 'http://www.w3.org/2000/svg';
function build(el, props, kids) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const h = (tag, props, ...kids) => build(document.createElement(tag), props, kids);
const s = (tag, props, ...kids) => build(document.createElementNS(SVGNS, tag), props, kids);

// ---------- state ----------
let state = null;       // loaded data
let cleanup = [];       // timers to clear on route change
const view = document.getElementById('view');

const fmtTime = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDate = ms => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDT = ms => `${fmtDate(ms)} ${fmtTime(ms)}`;
const pad = n => String(n).padStart(2, '0');
const toLocalInput = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const RATING_LABEL = { green: 'Green', amber: 'Amber', red: 'Red' };

const profile = () => state.profiles.find(p => p.id === state.selectedProfile) || state.profiles[0];
const myTests = () => state.tests.filter(t => t.profileId === profile().id).sort((a, b) => b.start - a.start);
const evalT = t => evaluateTest(t, state.readings, profile(), Number(state.settings.offsetMin) || 0);

function badge(score) {
  return score
    ? h('span', { class: 'badge ' + score.rating }, `${RATING_LABEL[score.rating]} +${score.rise.toFixed(1)}`)
    : h('span', { class: 'badge grey' }, 'Incomplete');
}

function toast(msg) {
  const el = h('div', { class: 'toast', role: 'alert' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 8000);
  el.addEventListener('click', () => el.remove());
}

function errorCard(e) {
  return h('div', { class: 'card err', role: 'alert' }, h('strong', null, 'Something went wrong. '), e.message || String(e));
}

async function reload() { state = await db.loadAll(); }

// ---------- notifications ----------
async function notify(title, body) {
  toast(`${title} - ${body}`);
  try { navigator.vibrate?.([200, 100, 200]); } catch {}
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag: 'prick' });
    else new Notification(title, { body, icon: 'icons/icon-192.png' });
  } catch { try { new Notification(title, { body }); } catch {} }
}

// ---------- chart ----------
function chart(match) {
  const pts = [...(match.baseline ? [match.baseline] : []), ...match.post];
  if (!pts.length) return null;
  const W = 320, H = 190, L = 34, R = 10, T = 12, B = 26;
  const xmin = Math.min(0, ...pts.map(p => p.min)), xmax = Math.max(130, ...pts.map(p => p.min));
  const vals = pts.map(p => p.value);
  const ymin = Math.floor(Math.min(...vals) - 0.5), ymax = Math.ceil(Math.max(...vals) + 0.5);
  const X = m => L + (m - xmin) / (xmax - xmin) * (W - L - R);
  const Y = v => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': 'Glucose readings against minutes from the first bite' });
  const step = ymax - ymin > 8 ? 2 : 1;
  for (let v = ymin; v <= ymax; v += step) {
    svg.append(s('line', { class: 'axis', x1: L, x2: W - R, y1: Y(v), y2: Y(v) }),
      s('text', { class: 'txt', x: L - 5, y: Y(v) + 3, 'text-anchor': 'end' }, String(v)));
  }
  for (let m = Math.ceil(xmin / 30) * 30; m <= xmax; m += 30) {
    svg.append(s('text', { class: 'txt', x: X(m), y: H - 8, 'text-anchor': 'middle' }, String(m)));
  }
  svg.append(s('text', { class: 'txt', x: W - R, y: H - 8, 'text-anchor': 'end' }, 'min'));
  if (match.baseline) svg.append(s('line', { class: 'base', x1: L, x2: W - R, y1: Y(match.baseline.value), y2: Y(match.baseline.value) }));
  svg.append(s('polyline', { class: 'line', points: pts.map(p => `${X(p.min).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ') }));
  let peak = null;
  if (match.complete) peak = match.post.reduce((a, b) => (b.value > a.value ? b : a));
  for (const p of pts) {
    svg.append(s('circle', { class: p === peak ? 'peak' : 'dot', cx: X(p.min), cy: Y(p.value), r: p === peak ? 5 : 3.5 }));
  }
  return svg;
}

// ---------- shared pieces ----------
function testRow(t) {
  const { score, match } = evalT(t);
  return h('a', { class: 'row-link', href: `#/test/${t.id}` },
    h('div', { class: 'main' }, h('strong', null, t.food), h('span', { class: 'sub' }, fmtDT(t.start))),
    h('div', { class: 'right' }, badge(score),
      score ? null : h('span', { class: 'sub' }, match.baseline ? 'needs more readings' : 'no readings yet')));
}

function backupNotice() {
  const hasData = state.tests.length || state.readings.length;
  if (!hasData) return null;
  const now = Date.now();
  if (!state.lastBackup) {
    return h('div', { class: 'card warn' }, 'You have not made a backup yet. ', h('a', { href: '#/settings' }, 'Make one in Settings.'));
  }
  const d = daysSince(state.lastBackup, now);
  if (d > CONSTANTS.BACKUP_WARN_DAYS) {
    return h('div', { class: 'card warn' }, `Your last backup was ${d} days ago. `, h('a', { href: '#/settings' }, 'Back up now.'));
  }
  return null;
}

// ---------- views ----------
function homeView() {
  const now = Date.now();
  const tests = myTests();
  const active = tests.find(t => now < t.start + (CONSTANTS.PRICK_OFFSETS_MIN.at(-1) + 5) * MIN);
  const nodes = [h('h2', null, `Hi ${profile().name}`), backupNotice()];
  if (active) {
    nodes.push(h('a', { class: 'row-link', href: `#/test/${active.id}` },
      h('div', { class: 'main' }, h('strong', null, 'Test in progress: ' + active.food), h('span', { class: 'sub' }, 'Tap for the prick schedule')),
      h('span', { class: 'badge amber' }, 'Open')));
  }
  nodes.push(
    h('a', { class: 'btn', href: '#/new' }, 'Start a test'),
    h('a', { class: 'btn secondary', href: '#/import' }, 'Import meter readings'),
  );
  if (!tests.length) {
    nodes.push(h('div', { class: 'card' }, h('strong', null, 'First time? '),
      'Read ', h('a', { href: '#/help' }, 'How to test'), ', then start a test just before you eat.'));
  } else {
    nodes.push(h('h3', null, 'Recent tests'), tests.slice(0, 3).map(testRow),
      h('a', { class: 'btn secondary', href: '#/tests' }, 'All tests'));
  }
  nodes.push(h('p', { class: 'help' }, state.lastBackup ? `Last backup: ${fmtDT(state.lastBackup)}` : 'Last backup: never'),
    h('p', { class: 'help' }, h('a', { href: '#/help' }, 'How to test'), ' - This is not medical advice.'));
  return nodes;
}

function testsView() {
  const tests = myTests();
  return [h('h2', null, `${profile().name}'s tests`),
    h('a', { class: 'btn', href: '#/new' }, 'Start a test'),
    tests.length ? tests.map(testRow) : h('p', { class: 'help' }, 'No tests yet.')];
}

function foodsView() {
  const tests = myTests();
  const ranked = rankFoods(tests.map(t => ({ food: t.food, start: t.start, rise: evalT(t).score?.rise })));
  const incomplete = tests.filter(t => !evalT(t).complete).length;
  const nodes = [h('h2', null, `${profile().name}'s foods`),
    h('p', { class: 'help' }, 'Best (lowest average rise) first. Only complete tests count.')];
  if (!ranked.length) nodes.push(h('div', { class: 'card' }, 'No complete tests yet. Import your meter readings after a test to see results.'));
  for (const f of ranked) {
    nodes.push(h('a', { class: 'row-link', href: `#/food/${encodeURIComponent(f.key)}` },
      h('div', { class: 'main' }, h('strong', null, f.name),
        h('span', { class: 'sub' }, `${f.count} complete test${f.count === 1 ? '' : 's'}`)),
      h('div', { class: 'right' }, h('span', { class: 'badge ' + f.rating }, `${RATING_LABEL[f.rating]} +${f.avgRise.toFixed(1)}`),
        f.lowConfidence ? h('span', { class: 'sub' }, 'Low confidence') : null)));
  }
  if (incomplete) nodes.push(h('p', { class: 'help' }, `${incomplete} incomplete test${incomplete === 1 ? ' is' : 's are'} not ranked. See the Tests tab.`));
  return nodes;
}

function foodView(key) {
  const tests = myTests().filter(t => normFood(t.food) === key);
  if (!tests.length) return [h('p', null, 'No tests for this food.'), h('a', { class: 'btn secondary', href: '#/foods' }, 'Back to foods')];
  return [h('h2', null, tests[0].food), tests.map(testRow), h('a', { class: 'btn secondary', href: '#/foods' }, 'Back to foods')];
}

function testView(id) {
  const t = state.tests.find(x => x.id === id);
  if (!t) return [h('p', null, 'Test not found.'), h('a', { class: 'btn secondary', href: '#/tests' }, 'Back')];
  const { match, score } = evalT(t);
  const nodes = [h('h2', null, t.food),
    h('p', { class: 'help' }, `${fmtDT(t.start)}${t.note ? ' - ' + t.note : ''}`)];

  // prick schedule
  const sched = prickSchedule(t.start);
  const endAt = sched.at(-1).at + 5 * MIN;
  if (Date.now() < endAt && profile().id === t.profileId) {
    const countdown = h('div', { class: 'big', 'aria-live': 'off' });
    const nextLabel = h('p', { class: 'help' });
    const items = sched.map(p => h('li', null, h('span', null, p.label), h('span', null, fmtTime(p.at))));
    const fired = new Set();
    const tick = () => {
      const now = Date.now();
      sched.forEach((p, i) => {
        items[i].className = p.at <= now ? 'done' : '';
        if (p.at <= now && now - p.at < 2 * 60000 && !fired.has(p.at)) {
          fired.add(p.at);
          notify(`Prick now: ${t.food}`, p.offsetMin === 0 ? 'Baseline reading before you eat' : `${p.offsetMin} min after the first bite`);
        }
      });
      const nx = nextPrick(t.start, now);
      if (nx) { items[sched.indexOf(nx)].className = 'next'; countdown.textContent = formatCountdown(nx.at - now); nextLabel.textContent = `until: ${nx.label} (${fmtTime(nx.at)})`; }
      else { countdown.textContent = 'Done'; nextLabel.textContent = 'All pricks done. Tag each reading with your name on the meter.'; }
    };
    tick();
    cleanup.push(clearInterval.bind(null, setInterval(tick, 1000)));
    sched.forEach(p => { const d = p.at - Date.now(); if (d > 0 && d < 2 ** 31 - 1) cleanup.push(clearTimeout.bind(null, setTimeout(tick, d + 50))); });
    nodes.push(h('div', { class: 'card' }, h('h3', null, 'Prick schedule'), countdown, nextLabel, h('ul', { class: 'sched' }, items),
      notifButton(),
      h('p', { class: 'help' }, 'Keep this app open for alerts. Phones may pause it when the screen is off, so also set a phone timer.')));
  }

  // result
  nodes.push(h('h3', null, 'Result'));
  if (score) {
    nodes.push(h('div', { class: 'card' }, badge(score),
      h('div', { class: 'stats' },
        stat(`+${score.rise.toFixed(1)}`, 'peak rise mmol/L'),
        stat(`${score.timeToPeak} min`, 'time to peak'),
        stat(score.recoveryMin == null ? 'No' : `${score.recoveryMin} min`, score.recoveryMin == null ? 'back to baseline' : 'to baseline')),
      score.recoveryMin == null ? h('p', { class: 'help' }, 'Not back to baseline within the readings found.') : null,
      chart(match)));
  } else {
    nodes.push(h('div', { class: 'card' }, h('strong', null, 'Incomplete. '),
      match.baseline || match.post.length ? '' : 'No readings found for this time yet. ',
      'Missing: ', h('ul', { class: 'plain' }, match.missing.map(m => h('li', null, m))),
      h('p', { class: 'help' }, 'Import your meter readings after the test, and check the meter clock offset in Settings.'),
      chart(match)));
  }
  const rows = [...(match.baseline ? [['Baseline', match.baseline]] : []), ...match.post.map(p => [null, p])];
  if (rows.length) {
    nodes.push(h('table', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Min'), h('th', null, 'mmol/L')),
      rows.map(([lbl, r]) => h('tr', null, h('td', null, fmtTime(r.ts)), h('td', null, `${Math.round(r.min)}${lbl ? ' (base)' : ''}`), h('td', null, round1(r.value).toFixed(1))))));
  }
  nodes.push(h('div', { class: 'actions' },
    h('a', { class: 'btn secondary', href: `#/edit/${t.id}` }, 'Edit'),
    h('button', { class: 'btn danger', onclick: async () => {
      if (!confirm(`Delete the test "${t.food}"? This cannot be undone.`)) return;
      try { await db.del('tests', t.id); await reload(); location.hash = '#/tests'; } catch (e) { toast(e.message); }
    } }, 'Delete')));
  return nodes;
}
const stat = (v, l) => h('div', { class: 'stat' }, h('b', null, v), h('span', null, l));

function notifButton() {
  if (typeof Notification === 'undefined') return h('p', { class: 'help' }, 'Notifications are not supported here. Alerts will show inside the app.');
  if (Notification.permission === 'granted') return h('p', { class: 'help' }, 'Notifications are on.');
  if (Notification.permission === 'denied') return h('p', { class: 'help' }, 'Notifications are blocked in your browser settings. Alerts will show inside the app.');
  return h('button', { class: 'btn secondary', onclick: async e => {
    try { await Notification.requestPermission(); } catch {}
    e.target.replaceWith(notifButton());
  } }, 'Turn on notifications');
}

function testFormView(id) {
  const existing = id ? state.tests.find(x => x.id === id) : null;
  if (id && !existing) return [h('p', null, 'Test not found.')];
  const names = foodNames(state.tests.filter(t => t.profileId === profile().id));
  const food = h('input', { id: 'food', required: true, list: 'foods', autocomplete: 'off', autocapitalize: 'sentences', value: existing?.food || '' });
  const start = h('input', { id: 'start', type: 'datetime-local', required: true, value: toLocalInput(existing?.start ?? Date.now()) });
  const note = h('textarea', { id: 'note', rows: 2 }, existing?.note || '');
  const err = h('div', { role: 'alert' });
  const form = h('form', { onsubmit: async e => {
    e.preventDefault();
    const st = new Date(start.value).getTime();
    if (!food.value.trim()) { err.replaceChildren(h('p', { class: 'help' }, 'Enter a food name.')); return; }
    if (!Number.isFinite(st)) { err.replaceChildren(h('p', { class: 'help' }, 'Enter a valid start time.')); return; }
    // reuse the existing spelling of a food that matches case-insensitively
    const match = names.find(n => normFood(n) === normFood(food.value));
    const rec = existing ? { ...existing } : { id: uid(), profileId: profile().id, created: Date.now() };
    Object.assign(rec, { food: match || food.value.trim().replace(/\s+/g, ' '), start: st, note: note.value.trim() });
    try { await db.put('tests', rec); await reload(); location.hash = `#/test/${rec.id}`; }
    catch (ex) { err.replaceChildren(errorCard(ex)); }
  } },
    h('label', { for: 'food' }, 'Food'), food, h('datalist', { id: 'foods' }, names.map(n => h('option', { value: n }))),
    h('label', { for: 'start' }, 'Start time (first bite)'), start,
    h('p', { class: 'help' }, 'Prick your finger just before eating for the baseline.'),
    h('label', { for: 'note' }, 'Note (optional)'), note, err,
    h('button', { class: 'btn', type: 'submit' }, existing ? 'Save changes' : 'Start test'),
    h('a', { class: 'btn secondary', href: existing ? `#/test/${existing.id}` : '#/' }, 'Cancel'));
  return [h('h2', null, existing ? 'Edit test' : `New test for ${profile().name}`), form];
}

function importView() {
  const out = h('div');
  const input = h('input', { type: 'file', id: 'file', accept: '.csv,.zip,text/csv,application/zip,application/x-zip-compressed' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    out.replaceChildren(h('p', null, 'Reading file...'));
    try {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, 2);
      const isZip = /\.zip$/i.test(file.name) || (head[0] === 0x50 && head[1] === 0x4b);
      const text = isZip ? await readReadingsCsvFromZip(buf) : new TextDecoder().decode(buf);
      const { readings, invalid } = parseReadingsCsv(text);
      const { fresh, duplicates } = dedupeReadings(readings, state.readings.map(r => r.id));
      await db.putMany('readings', fresh);
      await reload();
      const sum = importSummary(fresh, duplicates, invalid, state.profiles);
      out.replaceChildren(h('div', { class: 'card' }, h('h3', null, 'Import finished'),
        h('ul', { class: 'plain' },
          h('li', null, `New readings: ${sum.newReadings}`),
          h('li', null, `Duplicates skipped: ${sum.duplicates}`),
          sum.invalid ? h('li', null, `Unreadable rows skipped: ${sum.invalid}`) : null,
          state.profiles.map(p => h('li', null, `${p.name} (tag "${p.tag}"): ${sum.perProfile[p.id]}`)),
          h('li', null, `Untagged readings (stored, not used): ${sum.untagged}`),
          sum.otherTags ? h('li', null, `Readings with other tags (stored, not used): ${sum.otherTags}`) : null),
        h('a', { class: 'btn', href: '#/tests' }, 'See tests')));
    } catch (e) { out.replaceChildren(errorCard(e)); }
    input.value = '';
  });
  return [h('h2', null, 'Import meter readings'),
    h('p', null, 'In the Keto-Mojo app, export your data, then choose the zip file or the readings.csv inside it. Importing the same file again is safe: duplicates are skipped.'),
    h('label', { for: 'file' }, 'Choose readings.csv or the export .zip'), input, out];
}

function foodHelp() {
  return h('ol', { class: 'plain' },
    h('li', null, 'Test one food at least 3 hours after your last meal.'),
    h('li', null, 'Prick before eating (baseline), then 30, 60 and 120 minutes after the first bite.'),
    h('li', null, 'Tag each reading on the meter with your name (Chris or Lea) so it goes to the right person.'),
    h('li', null, 'Repeat each food 2-3 times. One test is only a hint; averages are more reliable.'),
    h('li', null, 'Import the meter export into the app after the test. The app matches readings to tests by time.'),
    h('li', null, 'Add this app to your home screen. On iPhone, Safari may delete data from sites not opened for 7 days unless the app has been added to the home screen. Make backups regularly anyway.'));
}
function helpView() {
  return [h('h2', null, 'How to test'), foodHelp(),
    h('div', { class: 'card' }, h('strong', null, 'This is not medical advice. '),
      'Talk to a doctor or dietitian about your health and diet.'),
    h('h3', null, 'How results are scored'),
    h('ul', { class: 'plain' },
      h('li', null, `Peak rise = highest reading in the 3 hours after eating minus your baseline.`),
      h('li', null, `Green: under ${CONSTANTS.GREEN_BELOW}. Amber: ${CONSTANTS.GREEN_BELOW} to ${CONSTANTS.AMBER_UP_TO}. Red: over ${CONSTANTS.AMBER_UP_TO} mmol/L.`),
      h('li', null, 'A test is complete with a baseline, at least 2 readings after eating, and one of them 45-75 minutes after the first bite.')),
    h('p', null, h('a', { href: '#/settings' }, 'Back to settings'))];
}

function settingsView() {
  const nodes = [h('h2', null, 'Settings')];

  // profiles
  const pinputs = state.profiles.map(p => ({
    p, name: h('input', { value: p.name, 'aria-label': 'Name', maxlength: 30 }),
    tag: h('input', { value: p.tag, 'aria-label': 'Meter tag', maxlength: 30, autocapitalize: 'none' }),
  }));
  const pmsg = h('div', { role: 'status' });
  nodes.push(h('div', { class: 'card' }, h('h3', null, 'Profiles'),
    h('p', { class: 'help' }, 'The tag is the name you type on the meter for each reading. Readings are matched by tag, ignoring case.'),
    pinputs.map(x => h('div', null, h('label', null, 'Name'), x.name, h('label', null, 'Meter tag'), x.tag)),
    pmsg,
    h('button', { class: 'btn', onclick: async () => {
      const updated = pinputs.map(x => ({ id: x.p.id, name: x.name.value.trim(), tag: x.tag.value.trim().toLowerCase() }));
      if (updated.some(u => !u.name || !u.tag)) { pmsg.replaceChildren(h('p', { class: 'help' }, 'Every profile needs a name and a tag.')); return; }
      if (new Set(updated.map(u => u.tag)).size !== updated.length) { pmsg.replaceChildren(h('p', { class: 'help' }, 'Tags must be different.')); return; }
      try { await db.setMeta('profiles', updated); await reload(); renderSwitcher(); pmsg.replaceChildren(h('p', { class: 'help' }, 'Saved.')); }
      catch (e) { pmsg.replaceChildren(errorCard(e)); }
    } }, 'Save profiles')));

  // offset
  const off = h('input', { type: 'number', inputmode: 'numeric', step: '1', value: String(state.settings.offsetMin ?? 0), id: 'offset' });
  const omsg = h('div', { role: 'status' });
  nodes.push(h('div', { class: 'card' }, h('h3', null, 'Meter clock offset (minutes)'), h('label', { for: 'offset' }, 'Offset in minutes'), off,
    h('p', { class: 'help' }, 'If your meter clock is ahead, enter a negative number. Example: meter shows 17:14 when the real time is 15:14 → enter -120.'),
    omsg,
    h('button', { class: 'btn', onclick: async () => {
      const v = Number(off.value);
      if (off.value.trim() === '' || !Number.isFinite(v)) { omsg.replaceChildren(h('p', { class: 'help' }, 'Enter a number of minutes, for example -120.')); return; }
      try { await db.setMeta('settings', { ...state.settings, offsetMin: v }); await reload(); omsg.replaceChildren(h('p', { class: 'help' }, 'Saved. All tests re-scored.')); }
      catch (e) { omsg.replaceChildren(errorCard(e)); }
    } }, 'Save offset')));

  // backup
  const bmsg = h('div', { role: 'status' });
  const restoreInput = h('input', { type: 'file', id: 'restore', accept: '.json,application/json' });
  restoreInput.addEventListener('change', async () => {
    const f = restoreInput.files[0];
    if (!f) return;
    try {
      let obj;
      try { obj = JSON.parse(await f.text()); } catch { throw new Error('That file is not valid JSON.'); }
      const v = validateBackup(obj);
      if (!v.ok) throw new Error(v.error);
      const when = obj.exportedAt ? new Date(obj.exportedAt).toLocaleString() : 'unknown date';
      if (!confirm(`Replace ALL data on this device with the backup from ${when}?\n\n${obj.tests.length} tests, ${obj.readings.length} readings.\nCurrent data will be lost.`)) { restoreInput.value = ''; return; }
      await db.restoreBackup(obj);
      await reload(); renderSwitcher();
      bmsg.replaceChildren(h('p', { class: 'help' }, 'Backup restored.'));
    } catch (e) { bmsg.replaceChildren(errorCard(e)); }
    restoreInput.value = '';
  });
  nodes.push(h('div', { class: 'card' }, h('h3', null, 'Backup'),
    h('p', { class: 'help' }, state.lastBackup ? `Last backup: ${fmtDT(state.lastBackup)}` : 'No backup yet.'),
    h('p', { class: 'help' }, `${state.tests.length} tests, ${state.readings.length} readings stored on this device.`),
    bmsg,
    h('button', { class: 'btn', onclick: () => downloadBackup(bmsg) }, 'Download backup'),
    h('label', { for: 'restore' }, 'Restore backup'), restoreInput));

  nodes.push(h('div', { class: 'card' }, h('h3', null, 'Help'),
    h('a', { class: 'btn secondary', href: '#/help' }, 'How to test'),
    h('a', { class: 'btn secondary', href: '#/import' }, 'Import meter readings')));
  return nodes;
}

async function downloadBackup(msgEl) {
  try {
    const data = await db.exportBackup();
    const name = `glucose-track-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const file = new File([blob], name, { type: 'application/json' });
    let done = false;
    if (navigator.canShare?.({ files: [file] })) {   // iPhone: lets you pick "Save to Files"
      try { await navigator.share({ files: [file], title: name }); done = true; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    if (!done) {
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a); a.click(); a.remove();
    }
    await db.setMeta('lastBackup', Date.now());
    await reload();
    msgEl.replaceChildren(h('p', { class: 'help' }, `Backup saved as ${name}.`));
  } catch (e) { msgEl.replaceChildren(errorCard(e)); }
}

// ---------- router ----------
function renderSwitcher() {
  const sw = document.getElementById('switcher');
  sw.replaceChildren(...state.profiles.map(p => h('button', {
    role: 'tab', 'aria-selected': String(p.id === profile().id),
    onclick: async () => { try { await db.setMeta('selectedProfile', p.id); await reload(); renderSwitcher(); render(); } catch (e) { toast(e.message); } },
  }, p.name)));
}

function route() {
  const [, a, b] = (location.hash || '#/').split('/');
  switch (a) {
    case 'tests': return ['tests', testsView()];
    case 'foods': return ['foods', foodsView()];
    case 'food': return ['foods', foodView(decodeURIComponent(b || ''))];
    case 'test': return ['tests', testView(b)];
    case 'new': return ['home', testFormView()];
    case 'edit': return ['tests', testFormView(b)];
    case 'import': return ['home', importView()];
    case 'settings': return ['settings', settingsView()];
    case 'help': return ['settings', helpView()];
    default: return ['home', homeView()];
  }
}

function render() {
  cleanup.forEach(f => f()); cleanup = [];
  if (!state) return;
  let nav, nodes;
  try { [nav, nodes] = route(); } catch (e) { nav = 'home'; nodes = [errorCard(e)]; }
  view.replaceChildren(...[nodes].flat(Infinity).filter(Boolean));
  document.querySelectorAll('.tabs a').forEach(a => {
    if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
}

async function start() {
  try {
    await db.checkStorage();
    await reload();
    if (!state.selectedProfile) await db.setMeta('selectedProfile', state.profiles[0].id);
    try { navigator.storage?.persist?.(); } catch {}
    renderSwitcher();
    render();
  } catch (e) {
    view.replaceChildren(h('div', { class: 'card err', role: 'alert' },
      h('strong', null, 'Storage is not available. '), e.message,
      h('p', null, 'Glucose Track keeps all data on this device, so it cannot work without browser storage. Try a normal (non-private) browser window and make sure site data is allowed.')));
  }
}

window.addEventListener('hashchange', render);
start();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
