// Pure logic: no DOM, no storage. Safe to import from Node tests.

export const MIN = 60000;

// ---- All tunable numbers live here --------------------------------------
export const CONSTANTS = {
  GREEN_BELOW: 1.1,          // rise < 1.1 mmol/L  -> green
  AMBER_UP_TO: 2.2,          // 1.1 .. 2.2 inclusive -> amber, above -> red
  RECOVERY_MARGIN: 0.3,      // "back to baseline" = baseline + 0.3
  BASELINE_BEFORE_MIN: 30,   // baseline window starts this long before start
  BASELINE_AFTER_MIN: 5,     // ...and ends this long after start
  POST_END_MIN: 180,         // post readings up to start + 180
  KEY_WINDOW_MIN: 45,        // one post reading must lie in [45, 75]
  KEY_WINDOW_MAX: 75,
  MIN_POST_READINGS: 2,
  LOW_CONFIDENCE_BELOW: 2,   // fewer complete tests than this -> low confidence (meals)
  INGREDIENT_LOW_CONFIDENCE_BELOW: 3, // same, for single ingredients
  PRICK_OFFSETS_MIN: [0, 30, 60, 120],
  MGDL_PER_MMOL: 18.016,
  BACKUP_WARN_DAYS: 14,
};

export const DEFAULT_PROFILES = [
  { id: 'chris', name: 'Chris', tag: 'chris' },
  { id: 'lea', name: 'Lea', tag: 'lea' },
];

// ---- CSV ----------------------------------------------------------------

/** RFC-4180-ish parser: quoted fields, doubled quotes, newlines in quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Parse a Python-list string like "['chris', 'Lea']" -> ['chris','lea'] */
export function parseTags(s) {
  if (!s) return [];
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const t = (m[1] ?? m[2]).trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Normalise a unit string: "mg/dL" -> "mgdl", "mmol/L" -> "mmoll" */
export function normUnit(u) {
  return String(u || '').toLowerCase().replace(/[^a-z]/g, '');
}

/** Glucose value in mmol/L, converting from mg/dL if needed. */
export function toMmol(value, unit) {
  const v = Number(value);
  if (normUnit(unit) === 'mgdl') return v / CONSTANTS.MGDL_PER_MMOL;
  return v;
}

/**
 * Parse Keto-Mojo readings.csv text.
 * Returns { readings, invalid } where readings = [{id, ts, type, value, unit, tags}]
 * Glucose values are stored in mmol/L (unit 'mmoll'); other types keep their raw value/unit.
 */
export function parseReadingsCsv(text) {
  text = String(text ?? '').replace(/^﻿/, '');
  // strip preamble: sep= line, # comments, blank lines
  const lines = text.split('\n');
  let k = 0;
  while (k < lines.length) {
    const t = lines[k].trim();
    if (t === '' || /^sep=/i.test(t) || t.startsWith('#')) k++; else break;
  }
  const rows = parseCsv(lines.slice(k).join('\n'))
    .filter(r => r.length && !(r.length === 1 && r[0].trim() === '') && !String(r[0]).startsWith('#'));
  if (!rows.length) return { readings: [], invalid: 0 };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = name => header.indexOf(name);
  const need = ['reading_timestamp', 'reading_type', 'reading_value'];
  if (need.some(c => col(c) < 0)) {
    throw new Error('This does not look like a Keto-Mojo readings.csv (missing columns: ' +
      need.filter(c => col(c) < 0).join(', ') + ').');
  }
  const iTs = col('reading_timestamp'), iType = col('reading_type'), iVal = col('reading_value');
  const iUnit = col('reading_unit'), iTags = col('tags'), iId = col('reading_id');
  const readings = [];
  let invalid = 0;
  for (const r of rows.slice(1)) {
    const ts = Date.parse((r[iTs] || '').trim());
    const raw = Number((r[iVal] || '').trim());
    const type = (r[iType] || '').trim().toLowerCase();
    if (!Number.isFinite(ts) || !Number.isFinite(raw) || (r[iVal] || '').trim() === '' || !type) { invalid++; continue; }
    let unit = iUnit >= 0 ? (r[iUnit] || '').trim() : '';
    let value = raw;
    if (type === 'glucose') { value = toMmol(raw, unit); unit = 'mmoll'; }
    const id = (iId >= 0 && (r[iId] || '').trim()) || `gen-${ts}-${type}-${raw}`;
    readings.push({ id, ts, type, value, unit, tags: iTags >= 0 ? parseTags(r[iTags]) : [] });
  }
  return { readings, invalid };
}

/**
 * Dedupe incoming readings against known ids (and against each other).
 * Returns { fresh, duplicates }.
 */
export function dedupeReadings(incoming, existingIds) {
  const seen = new Set(existingIds);
  const fresh = [];
  let duplicates = 0;
  for (const r of incoming) {
    if (seen.has(r.id)) { duplicates++; continue; }
    seen.add(r.id); fresh.push(r);
  }
  return { fresh, duplicates };
}

/** Summary shown after import. */
export function importSummary(fresh, duplicates, invalid, profiles) {
  const perProfile = {};
  for (const p of profiles) perProfile[p.id] = 0;
  let untagged = 0, otherTags = 0;
  for (const r of fresh) {
    if (!r.tags || !r.tags.length) { untagged++; continue; }
    const owner = profiles.find(p => r.tags.includes(p.tag.toLowerCase()));
    if (owner) perProfile[owner.id]++; else otherTags++;
  }
  return { newReadings: fresh.length, duplicates, invalid, perProfile, untagged, otherTags };
}

// ---- Matching & scoring -------------------------------------------------

export function normFood(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Clean a list of food names: trim, collapse spaces, drop blanks, de-dupe case-insensitively (first spelling wins). */
export function normItems(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const clean = String(raw ?? '').trim().replace(/\s+/g, ' ');
    const k = normFood(clean);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(clean);
  }
  return out;
}

/** Old test {food} -> {items:[food], mealName:''}. Returns the same object if nothing to do. */
export function migrateTest(t) {
  if (!t || typeof t !== 'object') return t;
  if (Array.isArray(t.items)) {
    if ('food' in t) { const { food, ...rest } = t; return rest; }
    return t;
  }
  if (typeof t.food === 'string') {
    const { food, ...rest } = t;
    return { ...rest, items: normItems([food]), mealName: '' };
  }
  return t;
}

export const needsMigration = t => !!t && typeof t === 'object' && (!Array.isArray(t.items) || 'food' in t);

/** Name shown for a test: mealName if set, else items joined with ", ". */
export function testLabel(t) {
  const m = String(t?.mealName ?? '').trim().replace(/\s+/g, ' ');
  if (m) return m;
  return (Array.isArray(t?.items) ? t.items : []).join(', ');
}

/** Key for grouping tests into "meals": the meal name, or the sorted normalised items. */
export function mealKey(t) {
  const m = normFood(t?.mealName);
  if (m) return m;
  return normItems(t?.items).map(normFood).sort().join(' + ');
}

export const MANUAL_MIN = 1.0, MANUAL_MAX = 33.3;
export const DEDUP_MIN = 3;   // manual reading within this many minutes of an imported one is dropped

/** Parse a typed glucose value (comma or dot). Returns { ok, value } or { ok:false, error }. */
export function parseGlucoseInput(text) {
  const t = String(text ?? '').trim().replace(',', '.');
  if (t === '') return { ok: false, empty: true, error: 'Enter a reading in mmol/L.' };
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return { ok: false, error: 'That is not a number. Example: 5.4' };
  const v = round1(Number(t));
  if (!(v >= MANUAL_MIN && v <= MANUAL_MAX)) return { ok: false, error: `Reading must be between ${MANUAL_MIN.toFixed(1)} and ${MANUAL_MAX} mmol/L.` };
  return { ok: true, value: v };
}

export const isManual = r => !!r && r.source === 'manual';

/** Build a manual reading record. `value` must already be validated. */
export function makeManualReading(id, profileId, value, time, now = Date.now()) {
  return { id: 'm-' + id, source: 'manual', profileId, type: 'glucose', value: round1(value), time, created: now };
}

/**
 * Glucose readings belonging to a profile, sorted by time (as `ts`).
 * Imported: matched by tag, shifted by the meter clock offset. Manual: matched by profileId, never shifted.
 * A manual reading within DEDUP_MIN minutes of an imported one (after offset) is dropped.
 */
export function profileGlucose(readings, profile, offsetMin = 0) {
  const tag = profile.tag.toLowerCase();
  const imported = readings
    .filter(r => !isManual(r) && r.type === 'glucose' && r.tags && r.tags.includes(tag))
    .map(r => ({ ...r, ts: r.ts + offsetMin * MIN }));
  const manual = readings
    .filter(r => isManual(r) && r.type === 'glucose' && r.profileId === profile.id && Number.isFinite(r.time))
    .map(r => ({ ...r, ts: r.time }))
    .filter(m => !imported.some(i => Math.abs(i.ts - m.ts) <= DEDUP_MIN * MIN));
  return [...imported, ...manual].sort((a, b) => a.ts - b.ts);
}

/**
 * Match a test to readings. `glucose` must already be offset-adjusted & sorted.
 * Returns { baseline, post, complete, missing[] }; baseline/post items get `min` (minutes from start).
 */
export function matchTest(start, glucose) {
  const C = CONSTANTS;
  const withMin = glucose.map(r => ({ ...r, min: (r.ts - start) / MIN }));
  const inBase = withMin.filter(r => r.min >= -C.BASELINE_BEFORE_MIN && r.min <= C.BASELINE_AFTER_MIN);
  const baseline = inBase.length ? inBase[inBase.length - 1] : null;
  const post = withMin.filter(r => r.min > C.BASELINE_AFTER_MIN && r.min <= C.POST_END_MIN);
  const hasKey = post.some(r => r.min >= C.KEY_WINDOW_MIN && r.min <= C.KEY_WINDOW_MAX);
  const missing = [];
  if (!baseline) missing.push('baseline reading (within 30 min before to 5 min after the start)');
  if (post.length < C.MIN_POST_READINGS) {
    missing.push(`at least ${C.MIN_POST_READINGS} readings after eating (found ${post.length})`);
  }
  if (!hasKey) missing.push(`a reading ${C.KEY_WINDOW_MIN}-${C.KEY_WINDOW_MAX} min after the start`);
  return { baseline, post, complete: missing.length === 0, missing };
}

export function round1(x) { return Math.round(x * 10 + 1e-9 * Math.sign(x)) / 10; }

export function ratingFor(rise) {
  const r = round1(rise);
  if (r < CONSTANTS.GREEN_BELOW) return 'green';
  if (r <= CONSTANTS.AMBER_UP_TO) return 'amber';
  return 'red';
}

/** Score a matched test. Returns null if not complete. */
export function scoreTest(match) {
  if (!match.complete) return null;
  const base = match.baseline.value;
  let peak = match.post[0];
  for (const r of match.post) if (r.value > peak.value) peak = r;
  const rise = round1(peak.value - base);
  const limit = base + CONSTANTS.RECOVERY_MARGIN + 1e-9;
  const rec = match.post.find(r => r.ts > peak.ts && r.value <= limit);
  return {
    baseline: base,
    peak: peak.value,
    rise,
    timeToPeak: Math.round(peak.min),
    recoveryMin: rec ? Math.round(rec.min) : null, // null = not back to baseline
    rating: ratingFor(rise),
  };
}

/** One call: match + score a test against a profile's readings. */
export function evaluateTest(test, allReadings, profile, offsetMin = 0) {
  const match = matchTest(test.start, profileGlucose(allReadings, profile, offsetMin));
  return { match, score: scoreTest(match), complete: match.complete };
}

/**
 * Rank meals. `items` = [{food (label), key? (grouping key, default normFood(food)), start, rise|null}] (rise null/undefined = incomplete, excluded).
 * Sorted lowest average rise first.
 */
export function rankFoods(items) {
  const groups = new Map();
  for (const it of items) {
    if (it.rise == null) continue;
    const key = it.key ?? normFood(it.food);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) { g = { key, name: it.food.trim(), latest: it.start ?? 0, rises: [] }; groups.set(key, g); }
    g.rises.push(it.rise);
    if ((it.start ?? 0) >= g.latest) { g.latest = it.start ?? 0; g.name = it.food.trim(); }
  }
  const out = [...groups.values()].map(g => {
    const raw = g.rises.reduce((a, b) => a + b, 0) / g.rises.length;
    const avgRise = round1(raw);
    return {
      key: g.key, name: g.name, avgRise, rawAvg: raw,
      rating: ratingFor(avgRise), count: g.rises.length,
      lowConfidence: g.rises.length < CONSTANTS.LOW_CONFIDENCE_BELOW,
    };
  });
  out.sort((a, b) => a.rawAvg - b.rawAvg || b.count - a.count || a.name.localeCompare(b.name));
  return out;
}

/**
 * Rank single ingredients across mixed meals. `tests` = [{items: string[], rise: number|null|undefined}]
 * (rise null/undefined = incomplete, excluded entirely, including from the "without" average).
 * Sorted by average rise ascending (best first).
 */
export function rankIngredients(tests) {
  const done = [];
  for (const t of tests) {
    if (t.rise == null) continue;
    const names = normItems(t.items);
    if (!names.length) continue;
    done.push({ names, keys: new Set(names.map(normFood)), rise: t.rise, start: t.start ?? 0 });
  }
  const groups = new Map();
  for (const t of done) {
    t.names.forEach(name => {
      const k = normFood(name);
      let g = groups.get(k);
      if (!g) { g = { key: k, name, latest: -Infinity }; groups.set(k, g); }
      if (t.start >= g.latest) { g.latest = t.start; g.name = name; }
    });
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const out = [];
  for (const g of groups.values()) {
    const withIt = done.filter(t => t.keys.has(g.key));
    const without = done.filter(t => !t.keys.has(g.key));
    const solo = withIt.filter(t => t.keys.size === 1);
    const rawAvg = mean(withIt.map(t => t.rise));
    const avgRise = round1(rawAvg);
    const avgRiseWithout = without.length ? round1(mean(without.map(t => t.rise))) : null;
    out.push({
      key: g.key, name: g.name, n: withIt.length, avgRise, rawAvg,
      rating: ratingFor(avgRise),
      avgRiseWithout,
      diff: avgRiseWithout == null ? null : round1(rawAvg - mean(without.map(t => t.rise))),
      soloN: solo.length,
      soloAvgRise: solo.length ? round1(mean(solo.map(t => t.rise))) : null,
      lowConfidence: withIt.length < CONSTANTS.INGREDIENT_LOW_CONFIDENCE_BELOW,
    });
  }
  out.sort((a, b) => a.rawAvg - b.rawAvg || b.n - a.n || a.name.localeCompare(b.name));
  return out;
}

// ---- Prick schedule -----------------------------------------------------

export function prickSchedule(start) {
  return CONSTANTS.PRICK_OFFSETS_MIN.map(m => ({
    offsetMin: m,
    at: start + m * MIN,
    label: m === 0 ? 'Baseline (before eating)' : `${m} min`,
  }));
}

export function nextPrick(start, now) {
  return prickSchedule(start).find(p => p.at > now) || null;
}

export function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

/** Distinct item names across tests (most recent spelling), for autocomplete. */
export function foodNames(tests) {
  const map = new Map();
  for (const t of [...tests].sort((a, b) => a.start - b.start)) {
    for (const name of normItems(migrateTest(t).items)) map.set(normFood(name), name);
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b));
}

// ---- Shared meals (link) --------------------------------------------------

export const SHARE_LIMITS = { items: 30, item: 60, mealName: 60, note: 500 };

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) throw new Error('bad characters');
  let b = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const bin = atob(b);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Build the URL-safe string that carries a meal to another person. */
export function encodeSharedMeal(test, targetProfileId) {
  const L = SHARE_LIMITS;
  const t = migrateTest(test) || {};
  const payload = {
    v: 1,
    sid: String(t.id ?? ''),
    p: String(targetProfileId ?? ''),
    items: normItems(t.items).slice(0, L.items).map(i => i.slice(0, L.item)),
    mealName: String(t.mealName ?? '').trim().replace(/\s+/g, ' ').slice(0, L.mealName),
    start: t.start,
    note: String(t.note ?? '').trim().slice(0, L.note),
  };
  return b64urlEncode(JSON.stringify(payload));
}

/** Read a shared-meal string. Returns { ok:true, meal } or { ok:false, error }. */
export function decodeSharedMeal(str) {
  const bad = error => ({ ok: false, error });
  const generic = 'This link is not a valid shared meal.';
  if (typeof str !== 'string' || !str.trim()) return bad(generic);
  const L = SHARE_LIMITS;
  if (str.length > 20000) return bad('This shared meal is too large.');
  let o;
  try { o = JSON.parse(b64urlDecode(str.trim())); } catch { return bad(generic + ' It may have been cut short when it was copied.'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad(generic);
  if (o.v !== 1) return bad('This link was made by a different version of the app.');
  if (typeof o.sid !== 'string' || !o.sid || o.sid.length > 100) return bad(generic);
  if (typeof o.p !== 'string' || !o.p || o.p.length > 100) return bad(generic);
  if (!Array.isArray(o.items) || !o.items.length || o.items.length > L.items ||
      !o.items.every(i => typeof i === 'string' && i.trim() && i.length <= L.item)) return bad('The foods in this link are not valid.');
  if (typeof o.start !== 'number' || !Number.isFinite(o.start)) return bad('The start time in this link is not valid.');
  const mealName = o.mealName ?? '', note = o.note ?? '';
  if (typeof mealName !== 'string' || mealName.length > L.mealName) return bad('The meal name in this link is not valid.');
  if (typeof note !== 'string' || note.length > L.note) return bad('The note in this link is not valid.');
  const items = normItems(o.items);
  if (!items.length) return bad('The foods in this link are not valid.');
  return { ok: true, meal: { sid: o.sid, p: o.p, items, mealName: mealName.trim().replace(/\s+/g, ' '), start: o.start, note: note.trim() } };
}

// ---- Backup -------------------------------------------------------------

export const BACKUP_VERSION = 2;   // v2: tests have items[] + mealName; v1 tests have food
export const SUPPORTED_BACKUP_VERSIONS = [1, 2];

export function validateBackup(obj) {
  const bad = msg => ({ ok: false, error: msg });
  if (!obj || typeof obj !== 'object') return bad('Not a backup file.');
  if (obj.app !== 'glucose-track') return bad('This file is not a Glucose Track backup.');
  if (!SUPPORTED_BACKUP_VERSIONS.includes(obj.version)) return bad('Unsupported backup version: ' + obj.version);
  if (!Array.isArray(obj.profiles) || !obj.profiles.length ||
      !obj.profiles.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.tag === 'string')) {
    return bad('Backup has invalid profiles.');
  }
  if (!obj.settings || typeof obj.settings !== 'object' || !Number.isFinite(Number(obj.settings.offsetMin))) {
    return bad('Backup has invalid settings.');
  }
  const foodOk = obj.version === 1
    ? t => typeof t.food === 'string'
    : t => Array.isArray(t.items) && t.items.length > 0 && t.items.every(i => typeof i === 'string');
  if (!Array.isArray(obj.tests) || !obj.tests.every(t => t && typeof t.id === 'string' &&
      typeof t.profileId === 'string' && foodOk(t) && Number.isFinite(t.start))) {
    return bad('Backup has invalid tests.');
  }
  const readingOk = r => r && typeof r.id === 'string' && typeof r.type === 'string' && Number.isFinite(r.value) &&
    (r.source === 'manual'
      ? typeof r.profileId === 'string' && Number.isFinite(r.time)
      : Number.isFinite(r.ts) && Array.isArray(r.tags));
  if (!Array.isArray(obj.readings) || !obj.readings.every(readingOk)) {
    return bad('Backup has invalid readings.');
  }
  return { ok: true };
}

/** Bring a validated backup (any supported version) to the current shape. */
export function migrateBackup(obj) {
  return { ...obj, version: BACKUP_VERSION, tests: obj.tests.map(migrateTest) };
}

export function daysSince(ts, now) {
  return Math.floor((now - ts) / 86400000);
}
