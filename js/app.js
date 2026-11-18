import {
  MIN, CONSTANTS, parseReadingsCsv, dedupeReadings, importSummary, evaluateTest, rankFoods, rankIngredients, prickSchedule,
  formatCountdown, foodNames, parseGlucoseInput, makeManualReading, isManual, normFood, normItems, testLabel, mealKey, validateBackup, daysSince, round1,
  encodeSharedMeal, decodeSharedMeal, validateSync, mergeSync, linkedTests, makeLinkedTest, linkedTestId,
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
    h('div', { class: 'main' }, h('strong', null, testLabel(t)), h('span', { class: 'sub' }, fmtDT(t.start))),
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
      h('div', { class: 'main' }, h('strong', null, 'Test in progress: ' + testLabel(active)), h('span', { class: 'sub' }, 'Tap for the prick schedule')),
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

function foodsTabs(active) {
  const tab = (id, label, href) => h('a', { class: 'seg' + (active === id ? ' on' : ''), href, role: 'tab', 'aria-selected': String(active === id) }, label);
  return h('div', { class: 'segs', role: 'tablist', 'aria-label': 'Foods view' },
    tab('ingredients', 'Ingredients', '#/foods'), tab('meals', 'Meals', '#/foods/meals'));
}

function foodsView(tab) {
  const tests = myTests();
  const evald = tests.map(t => ({ t, score: evalT(t).score }));
  const incomplete = evald.filter(x => !x.score).length;
  const nodes = [h('h2', null, `${profile().name}'s foods`), foodsTabs(tab)];
  const signed = x => (x < 0 ? '−' : '+') + Math.abs(x).toFixed(1);
  if (tab === 'meals') {
    nodes.push(h('p', { class: 'help' }, 'Best (lowest average rise) first. Only complete tests count.'));
    const ranked = rankFoods(evald.map(({ t, score }) => ({ food: testLabel(t), key: mealKey(t), start: t.start, rise: score?.rise })));
    if (!ranked.length) nodes.push(h('div', { class: 'card' }, 'No complete tests yet. Import your meter readings after a test to see results.'));
    for (const f of ranked) {
      nodes.push(h('a', { class: 'row-link', href: `#/food/${encodeURIComponent(f.key)}` },
        h('div', { class: 'main' }, h('strong', null, f.name),
          h('span', { class: 'sub' }, `${f.count} complete test${f.count === 1 ? '' : 's'}`)),
        h('div', { class: 'right' }, h('span', { class: 'badge ' + f.rating }, `${RATING_LABEL[f.rating]} +${f.avgRise.toFixed(1)}`),
          f.lowConfidence ? h('span', { class: 'sub' }, 'Low confidence') : null)));
    }
  } else {
    nodes.push(h('p', { class: 'help' }, 'Mixed meals blur the picture. Test a food on its own to confirm it.'));
    const ranked = rankIngredients(evald.map(({ t, score }) => ({ items: t.items, start: t.start, rise: score?.rise })));
    if (!ranked.length) nodes.push(h('div', { class: 'card' }, 'No complete tests yet. Import your meter readings after a test to see results.'));
    for (const f of ranked) {
      nodes.push(h('a', { class: 'row-link', href: `#/ingredient/${encodeURIComponent(f.key)}` },
        h('div', { class: 'main' }, h('strong', null, f.name),
          h('span', { class: 'sub' }, `${f.n} test${f.n === 1 ? '' : 's'}`),
          f.diff != null ? h('span', { class: 'sub' }, `vs without: ${signed(f.diff)}`) : null,
          f.soloN ? h('span', { class: 'sub' }, `alone: ${f.soloAvgRise.toFixed(1)} (${f.soloN})`) : null),
        h('div', { class: 'right' }, h('span', { class: 'badge ' + f.rating }, `${RATING_LABEL[f.rating]} +${f.avgRise.toFixed(1)}`),
          f.lowConfidence ? h('span', { class: 'sub' }, 'Low confidence') : null)));
    }
  }
  if (incomplete) nodes.push(h('p', { class: 'help' }, `${incomplete} incomplete test${incomplete === 1 ? ' is' : 's are'} not counted. See the Tests tab.`));
  nodes.push(h('p', { class: 'help' }, 'Red or amber foods? See ', h('a', { href: '#/help' }, 'ways to lower a spike'), '.'));
  return nodes;
}

function foodView(key) {
  const tests = myTests().filter(t => mealKey(t) === key);
  if (!tests.length) return [h('p', null, 'No tests for this meal.'), h('a', { class: 'btn secondary', href: '#/foods/meals' }, 'Back to foods')];
  return [h('h2', null, testLabel(tests[0])), tests.map(testRow), h('a', { class: 'btn secondary', href: '#/foods/meals' }, 'Back to foods')];
}

function ingredientView(key) {
  const tests = myTests().filter(t => t.items.some(i => normFood(i) === key));
  if (!tests.length) return [h('p', null, 'No tests contain this ingredient.'), h('a', { class: 'btn secondary', href: '#/foods' }, 'Back to foods')];
  const name = tests[0].items.find(i => normFood(i) === key);
  return [h('h2', null, name), h('p', { class: 'help' }, 'Tests containing this ingredient.'), tests.map(testRow), h('a', { class: 'btn secondary', href: '#/foods' }, 'Back to foods')];
}

function testView(id) {
  const t = state.tests.find(x => x.id === id);
  if (!t) return [h('p', null, 'Test not found.'), h('a', { class: 'btn secondary', href: '#/tests' }, 'Back')];
  const { match, score } = evalT(t);
  const nodes = [h('h2', null, testLabel(t)),
    t.mealName && t.items.length ? h('p', { class: 'help' }, t.items.join(', ')) : null,
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
          notify(`Prick now: ${testLabel(t)}`, p.offsetMin === 0 ? 'Baseline reading before you eat' : `${p.offsetMin} min after the first bite`);
        }
      });
      const nxi = sched.findIndex(p => p.at > now);
      const nx = nxi >= 0 ? sched[nxi] : null;
      if (nx) { items[nxi].className = 'next'; countdown.textContent = formatCountdown(nx.at - now); nextLabel.textContent = `until: ${nx.label} (${fmtTime(nx.at)})`; }
      else { countdown.textContent = 'Done'; nextLabel.textContent = 'All pricks done. Tag each reading with your name on the meter.'; }
    };
    tick();
    cleanup.push(clearInterval.bind(null, setInterval(tick, 1000)));
    sched.forEach(p => { const d = p.at - Date.now(); if (d > 0 && d < 2 ** 31 - 1) cleanup.push(clearTimeout.bind(null, setTimeout(tick, d + 50))); });
    nodes.push(h('div', { class: 'card' }, h('h3', null, 'Prick schedule'), countdown, nextLabel, h('ul', { class: 'sched' }, items),
      notifButton(),
      h('p', { class: 'help' }, 'Keep this app open for alerts. Phones may pause it when the screen is off, so also set a phone timer.')));
  }

  const linked = linkedTests(state.tests, t);
  if (linked.length) {
    const names = [...new Set(linked.map(x => state.profiles.find(p => p.id === x.profileId)?.name).filter(Boolean))];
    if (names.length) nodes.splice(3, 0, h('p', { class: 'help' }, `Shared with ${names.join(', ')}`));
  }
  const other = otherProfile();
  if (other && profile().id === t.profileId && !t.sharedFrom && !linked.some(x => x.profileId === other.id)) {
    const ateBtn = h('button', { class: 'btn secondary', onclick: async () => {
      ateBtn.disabled = true;
      try {
        await db.put('tests', makeLinkedTest(t, null, other.id, Date.now()));
        await reload(); render();
        toast(`Added for ${other.name}. Switch to ${other.name} at the top to see it.`);
      } catch (e) { ateBtn.disabled = false; toast(e.message); }
    } }, `${other.name} ate this too`);
    nodes.push(ateBtn);
  }
  if (profile().id === t.profileId) nodes.push(shareCard(t));
  if (profile().id === t.profileId) nodes.push(addReadingCard());

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
    nodes.push(h('table', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Min'), h('th', null, 'mmol/L'), h('th', null, '')),
      rows.map(([lbl, r]) => h('tr', null, h('td', null, fmtTime(r.ts)), h('td', null, `${Math.round(r.min)}${lbl ? ' (base)' : ''}`), h('td', null, round1(r.value).toFixed(1)),
        h('td', null, isManual(r) ? [h('span', { class: 'sub' }, 'typed '),
          h('button', { type: 'button', class: 'btn danger small', 'aria-label': `Delete typed reading ${round1(r.value).toFixed(1)} at ${fmtTime(r.ts)}`, onclick: async () => {
            if (!confirm(`Delete the typed reading ${round1(r.value).toFixed(1)} mmol/L at ${fmtTime(r.ts)}?`)) return;
            try { await db.delWithTombstone('readings', r.id); await reload(); render(); } catch (e) { toast(e.message); }
          } }, 'Delete')] : null)))));
  }
  nodes.push(h('div', { class: 'actions' },
    h('a', { class: 'btn secondary', href: `#/edit/${t.id}` }, 'Edit'),
    h('button', { class: 'btn danger', onclick: async () => {
      if (!confirm(`Delete the test "${testLabel(t)}"? This cannot be undone.`)) return;
      try { await db.delWithTombstone('tests', t.id); await reload(); location.hash = '#/tests'; } catch (e) { toast(e.message); }
    } }, 'Delete')));
  return nodes;
}
const otherProfile = () => state.profiles.find(p => p.id !== profile().id) || null;

function shareCard(t) {
  const other = otherProfile();
  if (!other) return null;
  const out = h('div', { role: 'status' });
  const send = async () => {
    const url = location.origin + location.pathname + '#/join/' + encodeSharedMeal(t, other.id);
    const text = `${profile().name} ate ${testLabel(t)}. Open this link to add the meal for ${other.name}.`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Shared meal: ' + testLabel(t), text, url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(url); out.replaceChildren(h('p', { class: 'help' }, 'Link copied. Send it to ' + other.name + '.')); return; }
      catch {}
    }
    const box = h('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Shared meal link', onfocus: e => e.target.select() });
    out.replaceChildren(h('p', { class: 'help' }, 'Copy this link and send it to ' + other.name + '.'), box);
    box.focus();
  };
  return h('div', { class: 'card' },
    h('h3', null, 'Shared meal'),
    h('button', { class: 'btn', type: 'button', onclick: send }, `Send to ${other.name}`),
    out,
    h('p', { class: 'help' }, `${other.name} opens the link on their phone. The meal is added for them. They only add their readings.`));
}

function joinView(data) {
  const r = decodeSharedMeal(data);
  if (!r.ok) return [h('h2', null, 'Shared meal'), h('div', { class: 'card err', role: 'alert' }, h('strong', null, 'Cannot open this link. '), r.error),
    h('a', { class: 'btn secondary', href: '#/' }, 'Home')];
  const m = r.meal;
  const target = state.profiles.find(p => p.id === m.p) || profile();
  const label = testLabel(m);
  const err = h('div', { role: 'alert' });
  const add = async () => {
    try {
      const dup = state.tests.find(t => t.id === linkedTestId(m.sid, target.id) || (t.sharedFrom === m.sid && t.profileId === target.id));
      if (dup) {
        await db.setMeta('selectedProfile', target.id); await reload(); renderSwitcher();
        toast('This meal is already added.'); location.hash = `#/test/${dup.id}`; return;
      }
      const known = new Map(foodNames(state.tests.filter(t => t.profileId === target.id)).map(n => [normFood(n), n]));
      const rec = { id: linkedTestId(m.sid, target.id), profileId: target.id, created: Date.now(), updated: Date.now(),
        items: normItems(m.items.map(n => known.get(normFood(n)) || n)), mealName: m.mealName, start: m.start, note: m.note, sharedFrom: m.sid };
      await db.put('tests', rec);
      await db.setMeta('selectedProfile', target.id);
      await reload(); renderSwitcher();
      location.hash = `#/test/${rec.id}`;
    } catch (e) { err.replaceChildren(errorCard(e)); }
  };
  return [h('h2', null, 'Shared meal'),
    h('div', { class: 'card' }, h('strong', null, label),
      m.mealName ? h('p', { class: 'help' }, 'Foods: ' + m.items.join(', ')) : null,
      h('p', { class: 'help' }, 'Started: ' + fmtDT(m.start) + (m.note ? ' - ' + m.note : '')),
      h('p', null, `This meal will be added for ${target.name}.`)),
    err,
    h('button', { class: 'btn', type: 'button', onclick: add }, `Add this meal for ${target.name}`),
    h('a', { class: 'btn secondary', href: '#/' }, 'Cancel')];
}

function addReadingCard() {
  const val = h('input', { id: 'rval', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 5.4' });
  const when = h('input', { id: 'rtime', type: 'datetime-local', value: toLocalInput(Date.now()) });
  const err = h('div', { role: 'alert' });
  const save = async () => {
    const p = parseGlucoseInput(val.value);
    const ts = new Date(when.value).getTime();
    if (!p.ok) { err.replaceChildren(h('p', { class: 'help err-text' }, p.error)); val.focus(); return; }
    if (!Number.isFinite(ts)) { err.replaceChildren(h('p', { class: 'help err-text' }, 'Enter a valid time.')); return; }
    try {
      await db.put('readings', makeManualReading(uid(), profile().id, p.value, ts));
      await reload(); render(); toast('Reading saved.');
    } catch (e) { err.replaceChildren(errorCard(e)); }
  };
  val.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  return h('div', { class: 'card' }, h('h3', null, 'Add a reading'),
    h('label', { for: 'rval' }, 'Reading (mmol/L)'), val,
    h('label', { for: 'rtime' }, 'Time of reading'), when, err,
    h('button', { class: 'btn', type: 'button', onclick: save }, 'Save reading'),
    h('p', { class: 'help' }, 'No Keto-Mojo app? Type each reading in right after you prick. Also works for late entry.'));
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
  let items = normItems(existing?.items || []);
  const mealName = h('input', { id: 'mealname', autocomplete: 'off', autocapitalize: 'sentences', maxlength: 60, value: existing?.mealName || '' });
  const food = h('input', { id: 'food', list: 'foods', autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'done' });
  const chips = h('ul', { class: 'chips', 'aria-label': 'Foods in this meal' });
  const start = h('input', { id: 'start', type: 'datetime-local', required: true, value: toLocalInput(existing?.start ?? Date.now()) });
  const base = h('input', { id: 'base', type: 'text', inputmode: 'decimal', step: '0.1', autocomplete: 'off', placeholder: 'e.g. 5.1' });
  const note = h('textarea', { id: 'note', rows: 2 }, existing?.note || '');
  const other = existing ? null : otherProfile();
  const alsoAte = h('input', { id: 'alsoate', type: 'checkbox' });
  const err = h('div', { role: 'alert' });
  const drawChips = () => chips.replaceChildren(...items.map(it => h('li', null, h('span', null, it),
    h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${it}`, onclick: () => { items = items.filter(x => x !== it); drawChips(); } }, '×'))));
  const addItem = () => {
    const before = items.length;
    items = normItems([...items, food.value]);
    if (food.value.trim() && items.length === before) { /* duplicate: just clear */ }
    food.value = ''; err.replaceChildren(); drawChips(); food.focus();
  };
  food.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
  drawChips();
  const form = h('form', { novalidate: true, onsubmit: async e => {
    e.preventDefault();
    const st = new Date(start.value).getTime();
    const all = normItems([...items, food.value]);   // include text typed but not added
    if (!all.length) { err.replaceChildren(h('p', { class: 'help err-text' }, 'Add at least one food.')); food.focus(); return; }
    if (!Number.isFinite(st)) { err.replaceChildren(h('p', { class: 'help err-text' }, 'Enter a valid start time.')); return; }
    const bp = existing ? { ok: false, empty: true } : parseGlucoseInput(base.value);
    if (!bp.ok && !bp.empty) { err.replaceChildren(h('p', { class: 'help err-text' }, bp.error)); base.focus(); return; }
    // reuse the existing spelling of a food seen before in this profile
    const known = new Map(names.map(n => [normFood(n), n]));
    const finalItems = normItems(all.map(n => known.get(normFood(n)) || n));
    const now = Date.now();
    const rec = existing ? { ...existing } : { id: uid(), profileId: profile().id, created: now };
    delete rec.food;
    Object.assign(rec, { items: finalItems, mealName: mealName.value.trim().replace(/\s+/g, ' '), start: st, note: note.value.trim(), updated: now });
    // "<other> ate this too": also add their copy on this phone (a sync carries it to their phone)
    const copy = !existing && other && alsoAte.checked ? makeLinkedTest(rec, null, other.id, now) : null;
    try {
      await db.putMany('tests', copy ? [rec, copy] : [rec]);
      if (bp.ok) await db.put('readings', makeManualReading(uid(), profile().id, bp.value, Math.min(Date.now(), st)));
      await reload();
      if (copy) toast(`Also added for ${other.name}. Send a sync file, or the link below, so it reaches their phone.`);
      location.hash = `#/test/${rec.id}`; }
    catch (ex) { err.replaceChildren(errorCard(ex)); }
  } },
    h('label', { for: 'mealname' }, 'Meal name (optional)'), mealName,
    h('label', { for: 'food' }, 'Foods in this meal'),
    h('div', { class: 'addrow' }, food, h('button', { type: 'button', class: 'btn secondary small', onclick: addItem }, 'Add')),
    h('datalist', { id: 'foods' }, names.map(n => h('option', { value: n }))),
    chips,
    h('p', { class: 'help' }, 'List every food, one at a time. Testing a single food gives the clearest answer.'),
    h('label', { for: 'start' }, 'Start time (first bite)'), start,
    h('p', { class: 'help' }, 'Prick your finger just before eating for the baseline.'),
    existing ? null : [h('label', { for: 'base' }, 'Baseline reading (mmol/L, optional)'), base,
      h('p', { class: 'help' }, 'Type it now if you have no Keto-Mojo app. You can also add readings later on the test screen.')],
    h('label', { for: 'note' }, 'Note (optional)'), note,
    other ? h('label', { class: 'check', for: 'alsoate' }, alsoAte, ` ${other.name} ate this too`) : null, err,
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
      const { fresh, updated, duplicates } = dedupeReadings(readings, state.readings.map(r => r.id), state.readings);
      await db.putMany('readings', [...fresh, ...updated]);
      await reload();
      const sum = importSummary(fresh, duplicates, invalid, state.profiles, updated);
      out.replaceChildren(h('div', { class: 'card' }, h('h3', null, 'Import finished'),
        h('ul', { class: 'plain' },
          h('li', null, `New readings: ${sum.newReadings}`),
          sum.updatedReadings ? h('li', null, `Updated (tags or values changed): ${sum.updatedReadings}`) : null,
          h('li', null, `Already in the app (skipped): ${sum.duplicates}`),
          sum.invalid ? h('li', null, `Unreadable rows skipped: ${sum.invalid}`) : null,
          state.profiles.map(p => h('li', null, `${p.name} (tag "${p.tag}"): ${sum.perProfile[p.id]} new or updated, ${state.readings.filter(r => r.source !== 'manual' && r.tags?.includes(p.tag.toLowerCase())).length} in total`)),
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
  const steps = [
    ['Fast 3 hours', 'Test one food at least 3 hours after your last meal. A meal can list several foods, but one food alone gives the clearest answer.'],
    ['Prick 4 times', 'Before eating (baseline), then 30, 60 and 120 minutes after the first bite.'],
    ['Tag your readings', 'Type your name (Chris or Lea) as the tag on the meter so it goes to the right person.'],
    ['No Keto-Mojo app?', 'Type each reading into the test screen right after you prick.'],
    ['Ate the same meal?', 'Enter it once and tick "ate this too". The meal is added for both of you. Or tap "Send to" on the test screen and send the link.'],
    ['Two phones?', 'Import the meter file on one phone. Then send a sync file (Settings) to the other phone and import it there. Nothing unique to either phone is lost.'],
    ['Import the export', 'After the test, import the meter export. The app matches readings to tests by time.'],
    ['Repeat 2-3 times', 'One test is only a hint; averages are more reliable.'],
    ['Add to home screen', 'On iPhone, Safari may delete data from sites not opened for 7 days unless the app is on the home screen. Make backups regularly anyway.'],
  ];
  const offs = CONSTANTS.PRICK_OFFSETS_MIN;
  const last = offs[offs.length - 1];
  return [
    h('ol', { class: 'steps' }, steps.map(([t, d]) =>
      h('li', null, h('strong', null, t), h('span', { class: 'sub' }, d)))),
    h('div', { class: 'timeline', role: 'img', 'aria-label': `Four pricks: ${offs.map((m, i) => i ? `${m} minutes` : 'before eating').join(', ')}` },
      h('div', { class: 'tl-line' }),
      offs.map((m, i) => h('div', { class: 'tl-pt', style: `left:${m / last * 100}%` },
        h('span', { class: 'tl-dot' }),
        h('span', { class: 'tl-lbl' }, i === 0 ? 'Before' : `${m} min`)))),
  ];
}
function exampleCurve() {
  const txt = (x, y, anchor, t, cls) => s('text', { x, y, 'text-anchor': anchor, class: cls || 'ch-t' }, t);
  return h('figure', { class: 'chart' },
    s('svg', { viewBox: '0 0 320 160', width: '100%', role: 'img',
      'aria-label': 'Example glucose curve: flat baseline, rises to a peak at about 45 minutes, then falls back near baseline by 120 minutes.' },
      s('line', { x1: 40, y1: 120, x2: 306, y2: 120, class: 'ch-base' }),
      s('line', { x1: 139, y1: 40, x2: 139, y2: 120, class: 'ch-guide' }),
      s('path', { d: 'M40 120 C 70 120 90 60 139 40 C 175 28 200 105 304 117', class: 'ch-curve' }),
      s('path', { d: 'M150 48 L150 112 M150 48 l-3 6 M150 48 l3 6 M150 112 l-3 -6 M150 112 l3 -6', class: 'ch-arrow' }),
      s('circle', { cx: 139, cy: 40, r: 4, class: 'ch-dot' }),
      s('circle', { cx: 304, cy: 117, r: 4, class: 'ch-dot' }),
      txt(139, 30, 'middle', 'Peak', 'ch-t b'),
      txt(158, 84, 'start', 'Rise', 'ch-t b'),
      txt(40, 136, 'start', 'Baseline'),
      txt(306, 136, 'end', 'Recovery'),
      [[0, 40], [30, 106], [60, 172], [120, 304]].map(([m, x]) => txt(x, 154, m === 0 ? 'start' : m === 120 ? 'end' : 'middle', m === 0 ? '0 min' : String(m)))),
    h('figcaption', null, 'Example only. Your curve will look different.'));
}
function helpView() {
  const t = (cls, label, text, range) => h('div', { class: `rise-card ${cls}` },
    h('span', { class: `badge ${cls}` }, label), h('span', { class: 'rc-range' }, range), h('span', null, text));
  const G = CONSTANTS.GREEN_BELOW, A = CONSTANTS.AMBER_UP_TO;
  const tips = [
    ['🥚', 'Add protein or fat', 'Eggs, meat, cheese, yoghurt, nuts, olive oil slow the sugar down.'],
    ['🥗', 'Add fibre', 'Vegetables, salad, beans, lentils.'],
    ['🔀', 'Veg & protein first', 'Carbs (bread, rice, pasta) last.'],
    ['🍚', 'Smaller carb portion', 'Half the rice gives a smaller spike.'],
    ['🚶', 'Walk 10-15 min after', 'Start soon after you eat.'],
    ['❄️', 'Cook, cool, reheat', 'Works for rice, pasta and potato.'],
    ['🫙', 'Vinegar first', 'For example a salad with vinegar dressing before the meal.'],
    ['🌾', 'Less processed', 'Whole oats, not instant; whole fruit, not juice.'],
  ];
  return [h('h2', null, 'How to test'), foodHelp(),
    h('h3', null, 'Example curve'), exampleCurve(),
    h('div', { class: 'card' }, h('strong', null, 'This is not medical advice. '),
      'Talk to a doctor or dietitian about your health and diet.'),
    h('h3', null, 'How results are scored'),
    h('ul', { class: 'plain' },
      h('li', null, 'Peak rise = highest reading in the 3 hours after eating minus your baseline.'),
      h('li', null, 'A test is complete with a baseline, at least 2 readings after eating, and one of them 45-75 minutes after the first bite.')),
    h('h3', null, 'What the rise means'),
    h('div', { class: 'scale' },
      h('div', { class: 'scale-bar', role: 'img', 'aria-label': `Scale in mmol/L: green under ${G}, amber ${G} to ${A}, red over ${A}` },
        h('span', { class: 'seg green' }, 'Green'), h('span', { class: 'seg amber' }, 'Amber'), h('span', { class: 'seg red' }, 'Red')),
      h('div', { class: 'scale-ticks' }, h('span', null, '0'), h('span', null, String(G)), h('span', null, String(A)), h('span', null, 'mmol/L'))),
    h('div', { class: 'rise-cards' },
      t('green', 'Green', 'Small bump - good for you', `under ${G}`),
      t('amber', 'Amber', 'Medium bump - try the tips', `${G} to ${A}`),
      t('red', 'Red', 'Big spike - try the tips or eat less', `over ${A}`)),
    h('ul', { class: 'plain' },
      h('li', null, h('strong', null, 'Time to peak: '), 'a very fast peak (about 30 minutes) means the sugar got into your blood quickly.'),
      h('li', null, h('strong', null, 'Recovery: '), 'how long until you are back near your start level. Faster is better. "Not back to baseline" is less good.'),
      h('li', null, h('strong', null, 'Test 2+ times (3 for an ingredient) '), 'before you trust the result. One test can be a fluke.')),
    h('h3', { id: 'tips' }, 'Ways to lower a spike'),
    h('div', { class: 'tips' }, tips.map(([i, ti, d]) =>
      h('div', { class: 'tip' }, h('span', { class: 'tip-ico', 'aria-hidden': 'true' }, i), h('strong', null, ti), h('span', { class: 'sub' }, d)))),
    h('div', { class: 'card hl' }, h('strong', null, 'Test it: '),
      'test the food alone, then with one change. The Ingredients tab shows what raises or lowers your rise.'),
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
      try { await db.setMeta('settings', { ...state.settings, offsetMin: v, offsetUpdated: Date.now() }); await reload(); omsg.replaceChildren(h('p', { class: 'help' }, 'Saved. All tests re-scored.')); }
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

  nodes.push(syncCard());

  nodes.push(h('div', { class: 'card' }, h('h3', null, 'Help'),
    h('a', { class: 'btn secondary', href: '#/help' }, 'How to test'),
    h('a', { class: 'btn secondary', href: '#/import' }, 'Import meter readings')));
  return nodes;
}

function syncCard() {
  const other = otherProfile();
  const smsg = h('div', { role: 'status' });
  const input = h('input', { type: 'file', id: 'syncfile', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      let obj;
      try { obj = JSON.parse(await f.text()); } catch { throw new Error('That file is not valid JSON.'); }
      const v = validateSync(obj);
      if (!v.ok) throw new Error(v.error);
      const m = mergeSync(state, obj);
      await db.applySync(m);
      await reload(); render();
      const sum = m.summary;
      document.getElementById('syncmsg')?.replaceChildren(h('div', { class: 'card' }, h('h3', null, 'Sync finished'),
        h('ul', { class: 'plain' },
          h('li', null, `New meals: ${sum.newTests}`),
          h('li', null, `Updated meals: ${sum.updatedTests}`),
          h('li', null, `New readings: ${sum.newReadings}`),
          sum.updatedReadings ? h('li', null, `Updated readings (tags or values changed): ${sum.updatedReadings}`) : null,
          h('li', null, `Removed (deleted on the other phone): ${sum.removed}`),
          h('li', null, `Duplicates skipped: ${sum.skipped}`),
          m.settings ? h('li', null, `Meter clock offset now ${m.settings.offsetMin} min`) : null)));
    } catch (e) { smsg.replaceChildren(errorCard(e)); }
    input.value = '';
  });
  return h('div', { class: 'card' }, h('h3', null, other ? `Sync with ${other.name}` : 'Sync with the other phone'),
    h('p', { class: 'help' }, 'Import the meter file on one phone. Then send a sync file to the other phone and import it there. Nothing is overwritten: each phone keeps what only it has. Works both ways.'),
    h('div', { id: 'syncmsg', role: 'status' }), smsg,
    h('button', { class: 'btn', onclick: () => sendSync(smsg) }, 'Send sync file'),
    h('label', { for: 'syncfile' }, 'Import sync file'), input);
}

async function shareFile(data, name) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {   // iPhone: lets you pick "Save to Files", WhatsApp, AirDrop
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  return true;
}

async function sendSync(msgEl) {
  try {
    const name = `glucose-track-sync-${new Date().toISOString().slice(0, 10)}.json`;
    if (!await shareFile(await db.exportSync(), name)) return;
    msgEl.replaceChildren(h('p', { class: 'help' }, `Sync file saved as ${name}. Import it on the other phone.`));
  } catch (e) { msgEl.replaceChildren(errorCard(e)); }
}

async function downloadBackup(msgEl) {
  try {
    const data = await db.exportBackup();
    const name = `glucose-track-backup-${new Date().toISOString().slice(0, 10)}.json`;
    if (!await shareFile(data, name)) return;
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
    case 'foods': return ['foods', foodsView(b === 'meals' ? 'meals' : 'ingredients')];
    case 'food': return ['foods', foodView(decodeURIComponent(b || ''))];
    case 'ingredient': return ['foods', ingredientView(decodeURIComponent(b || ''))];
    case 'test': return ['tests', testView(b)];
    case 'join': return ['home', joinView(b || '')];
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
