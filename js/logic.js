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
  LOW_CONFIDENCE_BELOW: 2,   // fewer complete tests than this -> low confidence
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

/** Glucose readings belonging to a profile, offset applied (ts shifted by offsetMin). */
export function profileGlucose(readings, profile, offsetMin = 0) {
  const tag = profile.tag.toLowerCase();
  return readings
    .filter(r => r.type === 'glucose' && r.tags && r.tags.includes(tag))
    .map(r => ({ ...r, ts: r.ts + offsetMin * MIN }))
    .sort((a, b) => a.ts - b.ts);
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
 * Rank foods. `items` = [{food, start, rise|null}] (rise null/undefined = incomplete, excluded).
 * Sorted lowest average rise first.
 */
export function rankFoods(items) {
  const groups = new Map();
  for (const it of items) {
    if (it.rise == null) continue;
    const key = normFood(it.food);
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

/** Distinct food names (most recent spelling), for autocomplete. */
export function foodNames(tests) {
  const map = new Map();
  for (const t of [...tests].sort((a, b) => a.start - b.start)) {
    const k = normFood(t.food);
    if (k) map.set(k, t.food.trim());
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b));
}

// ---- Backup -------------------------------------------------------------

export const BACKUP_VERSION = 1;

export function validateBackup(obj) {
  const bad = msg => ({ ok: false, error: msg });
  if (!obj || typeof obj !== 'object') return bad('Not a backup file.');
  if (obj.app !== 'glucose-track') return bad('This file is not a Glucose Track backup.');
  if (obj.version !== BACKUP_VERSION) return bad('Unsupported backup version: ' + obj.version);
  if (!Array.isArray(obj.profiles) || !obj.profiles.length ||
      !obj.profiles.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.tag === 'string')) {
    return bad('Backup has invalid profiles.');
  }
  if (!obj.settings || typeof obj.settings !== 'object' || !Number.isFinite(Number(obj.settings.offsetMin))) {
    return bad('Backup has invalid settings.');
  }
  if (!Array.isArray(obj.tests) || !obj.tests.every(t => t && typeof t.id === 'string' &&
      typeof t.profileId === 'string' && typeof t.food === 'string' && Number.isFinite(t.start))) {
    return bad('Backup has invalid tests.');
  }
  if (!Array.isArray(obj.readings) || !obj.readings.every(r => r && typeof r.id === 'string' &&
      Number.isFinite(r.ts) && typeof r.type === 'string' && Number.isFinite(r.value) && Array.isArray(r.tags))) {
    return bad('Backup has invalid readings.');
  }
  return { ok: true };
}

export function daysSince(ts, now) {
  return Math.floor((now - ts) / 86400000);
}
