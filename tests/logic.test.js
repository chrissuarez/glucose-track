import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import {
  MIN, CONSTANTS, DEFAULT_PROFILES, parseCsv, parseTags, toMmol, parseReadingsCsv, dedupeReadings,
  importSummary, profileGlucose, matchTest, scoreTest, ratingFor, evaluateTest, rankFoods,
  prickSchedule, nextPrick, formatCountdown, foodNames, validateBackup, normFood,
  parseGlucoseInput, makeManualReading, normItems, migrateTest, migrateBackup, testLabel, mealKey, rankIngredients, BACKUP_VERSION, encodeSharedMeal, decodeSharedMeal,
} from '../js/logic.js';
import { readReadingsCsvFromZip } from '../js/zip.js';

const fx = f => readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8');

// ---- CSV ----
test('parseCsv handles quotes, doubled quotes, commas, newlines in fields', () => {
  const rows = parseCsv('a,"b ""q"", c","d\ne"\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b "q", c', 'd\ne'], ['1', '2', '3']]);
});

test('parseTags', () => {
  assert.deepEqual(parseTags("['chris']"), ['chris']);
  assert.deepEqual(parseTags("['Lea', 'X Y']"), ['lea', 'x y']);
  assert.deepEqual(parseTags('[]'), []);
  assert.deepEqual(parseTags(''), []);
});

test('full variant: skips sep/comment lines, finds columns by name, quoted notes ok', () => {
  const { readings, invalid } = parseReadingsCsv(fx('readings-full.csv'));
  assert.equal(invalid, 0);
  assert.equal(readings.length, 5);
  assert.equal(readings[0].id, 'test-id-0001');
  assert.equal(readings[0].ts, Date.parse('2026-01-01T12:00:00Z'));
  assert.deepEqual(readings[0].tags, ['chris']);
  assert.equal(readings[2].type, 'ketone');
  assert.deepEqual(readings[3].tags, ['lea', 'extra']);
  assert.deepEqual(readings[4].tags, []);
});

test('user variant (no email/full_name) parses the same way', () => {
  const { readings } = parseReadingsCsv(fx('readings-user.csv'));
  assert.equal(readings.length, 2);
  assert.equal(readings[1].value, 6);
  assert.equal(readings[1].id, 'test-id-0009');
});

test('CRLF line endings and BOM', () => {
  const t = '﻿' + fx('readings-user.csv').replace(/\n/g, '\r\n');
  assert.equal(parseReadingsCsv(t).readings.length, 2);
});

test('missing columns throws a clear error; bad rows are counted', () => {
  assert.throws(() => parseReadingsCsv('"a","b"\n1,2'), /Keto-Mojo/);
  const csv = '"reading_timestamp","reading_type","reading_value","reading_unit","tags","reading_id"\n' +
    '"nope","glucose","5","mmoll","[]","x"\n"2026-01-01T00:00:00Z","glucose","","mmoll","[]","y"\n';
  const r = parseReadingsCsv(csv);
  assert.equal(r.readings.length, 0);
  assert.equal(r.invalid, 2);
});

// ---- units ----
test('unit conversion', () => {
  assert.equal(toMmol(6.1, 'mmoll'), 6.1);
  assert.ok(Math.abs(toMmol(90, 'mgdl') - 4.9956) < 0.001);
  assert.ok(Math.abs(toMmol(180.16, 'mg/dL') - 10) < 1e-9);
  const { readings } = parseReadingsCsv(fx('readings-full.csv'));
  const mg = readings.find(r => r.id === 'test-id-0004');
  assert.equal(mg.unit, 'mmoll');
  assert.ok(Math.abs(mg.value - 4.9956) < 0.001);
});

// ---- dedupe & summary ----
test('dedupe against existing ids and within the file', () => {
  const { readings } = parseReadingsCsv(fx('readings-full.csv'));
  const first = dedupeReadings(readings, []);
  assert.equal(first.fresh.length, 5);
  const again = dedupeReadings(readings, first.fresh.map(r => r.id));
  assert.equal(again.fresh.length, 0);
  assert.equal(again.duplicates, 5);
  assert.equal(dedupeReadings([readings[0], readings[0]], []).duplicates, 1);
});

test('import summary counts per profile and untagged', () => {
  const { readings } = parseReadingsCsv(fx('readings-full.csv'));
  const s = importSummary(readings, 3, 0, DEFAULT_PROFILES);
  assert.equal(s.newReadings, 5);
  assert.equal(s.duplicates, 3);
  assert.equal(s.perProfile.chris, 3); // 2 glucose + 1 ketone
  assert.equal(s.perProfile.lea, 1);
  assert.equal(s.untagged, 1);
});

// ---- offset ----
const chris = { id: 'chris', name: 'Chris', tag: 'chris' };
const G = (id, min, value, tags = ['chris'], type = 'glucose') => ({ id, ts: 1e12 + min * MIN, type, value, unit: 'mmoll', tags });
const START = 1e12;

test('offset shifts meter time to real time and only glucose of the profile is used', () => {
  const rs = [G('a', 120, 5), G('b', 0, 5, ['lea']), G('c', 0, 9, ['chris'], 'ketone')];
  const g = profileGlucose(rs, chris, -120);
  assert.equal(g.length, 1);
  assert.equal(g[0].ts, START);
  assert.equal(profileGlucose(rs, chris, 0)[0].ts, START + 120 * MIN);
});

test('changing offset changes the match result', () => {
  const rs = [G('b', 120, 5), G('p1', 150, 7), G('p2', 180, 6)];
  const t = { start: START };
  assert.equal(evaluateTest(t, rs, chris, 0).complete, false);
  assert.equal(evaluateTest(t, rs, chris, -120).complete, true);
});

// ---- matching windows ----
const m = rs => matchTest(START, profileGlucose(rs, chris, 0));

test('baseline window edges: -30 and +5 inclusive, -31 and +6 outside', () => {
  assert.equal(m([G('a', -30, 5)]).baseline.id, 'a');
  assert.equal(m([G('a', 5, 5)]).baseline.id, 'a');
  assert.equal(m([G('a', -31, 5)]).baseline, null);
  assert.equal(m([G('a', 5.5, 5)]).baseline, null);
});

test('baseline is the latest reading in window', () => {
  assert.equal(m([G('a', -25, 5), G('b', -10, 5.2), G('c', -29, 4)]).baseline.id, 'b');
});

test('a reading at +5 is baseline, not post; post window is (5,180]', () => {
  const r = m([G('b', 5, 5), G('p', 5.01, 6), G('q', 180, 5), G('z', 180.01, 5)]);
  assert.deepEqual(r.post.map(x => x.id), ['p', 'q']);
});

test('complete needs baseline, 2 post readings, one in 45..75', () => {
  assert.equal(m([G('b', -5, 5), G('p1', 45, 6), G('p2', 120, 5)]).complete, true);
  assert.equal(m([G('b', -5, 5), G('p1', 75, 6), G('p2', 120, 5)]).complete, true);
  const noKey = m([G('b', -5, 5), G('p1', 44, 6), G('p2', 120, 5)]);
  assert.equal(noKey.complete, false);
  assert.match(noKey.missing.join(' '), /45-75/);
  assert.equal(m([G('b', -5, 5), G('p1', 76, 6), G('p2', 120, 5)]).complete, false);
  const onePost = m([G('b', -5, 5), G('p1', 60, 6)]);
  assert.equal(onePost.complete, false);
  assert.match(onePost.missing.join(' '), /at least 2/);
  const noBase = m([G('p1', 60, 6), G('p2', 120, 5)]);
  assert.equal(noBase.complete, false);
  assert.match(noBase.missing.join(' '), /baseline/);
});

// ---- scoring ----
test('scoring: rise, time to peak, recovery', () => {
  const s = scoreTest(m([G('b', -2, 5), G('p1', 30, 6.5), G('p2', 60, 7.4), G('p3', 90, 5.3), G('p4', 120, 5.0)]));
  assert.equal(s.rise, 2.4);
  assert.equal(s.timeToPeak, 60);
  assert.equal(s.recoveryMin, 90); // 5.3 <= 5.0 + 0.3
  assert.equal(s.rating, 'red');
});

test('recovery: only after the peak, null when never back', () => {
  const s = scoreTest(m([G('b', 0, 5), G('p1', 30, 5.1), G('p2', 60, 8), G('p3', 120, 5.4)]));
  assert.equal(s.recoveryMin, null); // 30 min reading is before the peak; 5.4 > 5.3
  assert.equal(s.timeToPeak, 60);
});

test('scoreTest returns null for incomplete', () => {
  assert.equal(scoreTest(m([G('b', 0, 5)])), null);
});

test('rating thresholds', () => {
  assert.equal(ratingFor(1.0), 'green');
  assert.equal(ratingFor(1.04), 'green');
  assert.equal(ratingFor(1.09), 'amber'); // rounds to the displayed 1.1
  assert.equal(ratingFor(1.1), 'amber');
  assert.equal(ratingFor(2.2), 'amber');
  assert.equal(ratingFor(2.3), 'red');
  assert.equal(ratingFor(-0.5), 'green');
  assert.equal(CONSTANTS.GREEN_BELOW, 1.1);
  // float noise: 7.3 - 6.2 = 1.0999999999999996 must be amber, shown as 1.1
  const s = scoreTest(m([G('b', 0, 6.2), G('p1', 45, 7.3), G('p2', 90, 6.0)]));
  assert.equal(s.rise, 1.1);
  assert.equal(s.rating, 'amber');
});

// ---- ranking ----
test('ranking: groups case-insensitively, excludes incomplete, sorts best first, low confidence', () => {
  const items = [
    { food: 'Porridge', start: 1, rise: 2.5 }, { food: 'porridge ', start: 2, rise: 2.1 },
    { food: 'Eggs', start: 3, rise: 0.2 },
    { food: 'Pizza', start: 4, rise: 3.0 }, { food: 'Pizza', start: 5, rise: null },
    { food: 'Apple', start: 6, rise: 1.0 }, { food: 'apple', start: 7, rise: 1.4 },
    { food: 'Cake', start: 8, rise: null },
  ];
  const r = rankFoods(items);
  assert.deepEqual(r.map(x => x.key), ['eggs', 'apple', 'porridge', 'pizza']);
  const por = r.find(x => x.key === 'porridge');
  assert.equal(por.avgRise, 2.3);
  assert.equal(por.rating, 'red');
  assert.equal(por.count, 2);
  assert.equal(por.lowConfidence, false);
  assert.equal(r.find(x => x.key === 'eggs').lowConfidence, true);
  assert.equal(r.find(x => x.key === 'apple').rating, 'amber'); // 1.2
  assert.equal(r.find(x => x.key === 'pizza').count, 1);
  assert.equal(por.name, 'porridge'); // most recent spelling
});

// ---- helpers ----
test('schedule and countdown', () => {
  const s = prickSchedule(START);
  assert.deepEqual(s.map(p => (p.at - START) / MIN), [0, 30, 60, 120]);
  assert.equal(nextPrick(START, START + 31 * MIN).offsetMin, 60);
  assert.equal(nextPrick(START, START + 121 * MIN), null);
  assert.equal(formatCountdown(61000), '01:01');
  assert.equal(formatCountdown(3661000), '1:01:01');
});

test('food names / normFood', () => {
  assert.equal(normFood('  Rice   Bowl '), 'rice bowl');
  assert.deepEqual(foodNames([{ items: ['Rice'], start: 1 }, { items: ['rice', 'Salt'], start: 2 }, { food: 'Eggs', start: 0 }]), ['Eggs', 'rice', 'Salt']);
});

test('backup validation', () => {
  const ok = { app: 'glucose-track', version: 1, profiles: DEFAULT_PROFILES, settings: { offsetMin: -120 },
    tests: [{ id: 't', profileId: 'chris', food: 'x', start: 1 }], readings: [G('a', 0, 5)] };
  assert.equal(validateBackup(ok).ok, true);
  assert.equal(validateBackup({ ...ok, app: 'other' }).ok, false);
  assert.equal(validateBackup({ ...ok, tests: [{ id: 1 }] }).ok, false);
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup({ ...ok, settings: {} }).ok, false);
});

// ---- zip ----
function makeZip(files, deflate) {
  const parts = [], central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const [name, text] of files) {
    const raw = Buffer.from(enc.encode(text));
    const data = deflate ? deflateRawSync(raw) : raw;
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nm);
    offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...parts, cd, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

test('zip reader: deflated and stored, picks first *readings.csv', async () => {
  const csv = fx('readings-user.csv');
  for (const deflate of [true, false]) {
    const zip = makeZip([['index.html', '<html>'], ['readings.csv', csv], ['user 0/readings.csv', 'other']], deflate);
    const text = await readReadingsCsvFromZip(zip);
    assert.equal(text, csv);
    assert.equal(parseReadingsCsv(text).readings.length, 2);
  }
  await assert.rejects(readReadingsCsvFromZip(makeZip([['a.txt', 'x']], false)), /No readings\.csv/);
  await assert.rejects(readReadingsCsvFromZip(new TextEncoder().encode('not a zip at all, definitely').buffer), /valid zip/);
});


// ---- multi-item meals ----
test('normItems trims, collapses, de-dupes case-insensitively keeping first spelling', () => {
  assert.deepEqual(normItems(['  Rice ', 'rice', 'Black   beans', 'BLACK BEANS', '', '  ', 'Egg']), ['Rice', 'Black beans', 'Egg']);
  assert.deepEqual(normItems(null), []);
});

test('migrateTest: old food becomes items + empty mealName; new tests untouched', () => {
  const m = migrateTest({ id: 'a', food: ' Porridge ', start: 1, note: 'n' });
  assert.deepEqual(m, { id: 'a', start: 1, note: 'n', items: ['Porridge'], mealName: '' });
  assert.equal('food' in m, false);
  const fresh = { id: 'b', items: ['x', 'y'], mealName: 'Lunch', start: 2 };
  assert.equal(migrateTest(fresh), fresh);
});

test('old (v1) backups validate and migrate; v2 validates; unknown version and empty items rejected', () => {
  const base = { app: 'glucose-track', profiles: DEFAULT_PROFILES, settings: { offsetMin: 0 }, readings: [] };
  const v1 = { ...base, version: 1, tests: [{ id: 't', profileId: 'chris', food: 'Rice', start: 1 }] };
  assert.equal(validateBackup(v1).ok, true);
  const mig = migrateBackup(v1);
  assert.equal(mig.version, BACKUP_VERSION);
  assert.deepEqual(mig.tests[0].items, ['Rice']);
  assert.equal(mig.tests[0].mealName, '');
  assert.equal(BACKUP_VERSION, 2);
  const v2 = { ...base, version: 2, tests: [{ id: 't', profileId: 'chris', items: ['Rice', 'Egg'], mealName: '', start: 1 }] };
  assert.equal(validateBackup(v2).ok, true);
  assert.equal(validateBackup({ ...v2, tests: [{ ...v2.tests[0], items: [] }] }).ok, false);
  assert.equal(validateBackup({ ...v2, tests: [{ id: 't', profileId: 'chris', food: 'x', start: 1 }] }).ok, false);
  assert.equal(validateBackup({ ...v2, version: 3 }).ok, false);
});

test('testLabel and mealKey', () => {
  assert.equal(testLabel({ mealName: 'Lunch', items: ['a', 'b'] }), 'Lunch');
  assert.equal(testLabel({ mealName: '  ', items: ['Rice', 'Egg'] }), 'Rice, Egg');
  assert.equal(mealKey({ mealName: ' Lunch ', items: ['a'] }), 'lunch');
  assert.equal(mealKey({ items: ['Rice', 'egg'] }), mealKey({ items: ['EGG', 'rice'] }));
  assert.notEqual(mealKey({ items: ['Rice'] }), mealKey({ items: ['Rice', 'Egg'] }));
});

test('rankIngredients: averages, without, diff, solo, exclusions, ordering, nulls', () => {
  const tests = [
    { items: ['Rice', 'Chicken'], rise: 2.0, start: 1 },
    { items: ['rice'], rise: 3.0, start: 2 },
    { items: ['Chicken', 'Salad'], rise: 0.4, start: 3 },
    { items: ['Salad'], rise: 0.2, start: 4 },
    { items: ['Rice', 'Salad'], rise: null, start: 5 },   // incomplete: ignored everywhere
  ];
  const r = rankIngredients(tests);
  assert.deepEqual(r.map(x => x.key), ['salad', 'chicken', 'rice']);
  const rice = r.find(x => x.key === 'rice');
  assert.equal(rice.n, 2);
  assert.equal(rice.avgRise, 2.5);
  assert.equal(rice.avgRiseWithout, 0.3);
  assert.equal(rice.diff, 2.2);
  assert.equal(rice.soloN, 1);
  assert.equal(rice.soloAvgRise, 3.0);
  assert.equal(rice.rating, 'red');
  assert.equal(rice.lowConfidence, true);
  const chicken = r.find(x => x.key === 'chicken');
  assert.equal(chicken.avgRise, 1.2);
  assert.equal(chicken.soloN, 0);
  assert.equal(chicken.soloAvgRise, null);
  assert.equal(chicken.avgRiseWithout, 1.6);
  assert.equal(chicken.diff, -0.4);
  assert.equal(r.find(x => x.key === 'salad').n, 2);
});

test('rankIngredients: nulls when not computable, confidence threshold', () => {
  const one = rankIngredients([{ items: ['Egg', 'Toast'], rise: 1.0 }]);
  assert.equal(one.length, 2);
  for (const x of one) { assert.equal(x.avgRiseWithout, null); assert.equal(x.diff, null); assert.equal(x.soloAvgRise, null); }
  assert.deepEqual(rankIngredients([{ items: ['Egg'], rise: null }]), []);
  const three = rankIngredients([1, 2, 3].map(i => ({ items: ['Egg'], rise: 0.5, start: i })));
  assert.equal(three[0].lowConfidence, false);
  assert.equal(three[0].soloN, 3);
});

// ---- manual readings ----
const M = (id, min, value, profileId = 'chris') => makeManualReading(id, profileId, value, START + min * MIN);
const lea = { id: 'lea', name: 'Lea', tag: 'lea' };

test('manual reading has m- id and belongs only to its profile', () => {
  const r = M('x', 0, 5.4);
  assert.equal(r.id, 'm-x');
  assert.equal(r.source, 'manual');
  assert.equal(profileGlucose([r], chris, 0).length, 1);
  assert.equal(profileGlucose([r], lea, 0).length, 0);
});

test('offset is not applied to manual readings', () => {
  const rs = [M('x', 60, 5), G('a', 120, 5)];
  const g = profileGlucose(rs, chris, -120);
  assert.deepEqual(g.map(r => r.ts), [START, START + 60 * MIN]);   // imported shifted, manual stays
  const g2 = profileGlucose([M('x', 0, 5)], chris, -120);
  assert.equal(g2[0].ts, START);
});

test('manual within 3 min of an imported reading is dropped; 4 min is kept', () => {
  const imp = G('a', 60, 7);
  const near = M('n', 62.5, 8), far = M('f', 64, 8), exact = M('e', 63, 8);
  const g = profileGlucose([imp, near, far, exact], chris, 0);
  assert.deepEqual(g.map(r => r.id), ['a', 'm-f']);
  // dedupe uses the offset-adjusted imported time
  const g2 = profileGlucose([G('a', 180, 7), M('n', 60, 8)], chris, -120);
  assert.deepEqual(g2.map(r => r.id), ['a']);
});

test('parseGlucoseInput: comma, dot, range, empty', () => {
  assert.deepEqual(parseGlucoseInput('5,4'), { ok: true, value: 5.4 });
  assert.deepEqual(parseGlucoseInput(' 5.45 '), { ok: true, value: 5.5 });
  assert.equal(parseGlucoseInput('1').value, 1);
  assert.equal(parseGlucoseInput('33.3').ok, true);
  for (const bad of ['0.9', '33.4', '100', 'abc', '5..4', '-3']) assert.equal(parseGlucoseInput(bad).ok, false, bad);
  const e = parseGlucoseInput('  ');
  assert.equal(e.ok, false); assert.equal(e.empty, true);
  assert.equal(parseGlucoseInput(undefined).ok, false);
});

test('a test scored purely from manual readings is complete and rated', () => {
  const rs = [M('1', 0, 5.0), M('2', 30, 7.5), M('3', 60, 6.8), M('4', 120, 5.2)];
  const ev = evaluateTest({ start: START }, rs, chris, -120);
  assert.equal(ev.complete, true);
  assert.equal(ev.score.rise, 2.5);
  assert.equal(ev.score.rating, 'red');
  assert.equal(ev.score.recoveryMin, 120);
  assert.equal(evaluateTest({ start: START }, rs, lea, 0).complete, false);
});

test('backup validation accepts manual readings; import dedupe leaves them alone', () => {
  const man = M('x', 0, 5.4);
  const ok = { app: 'glucose-track', version: 2, profiles: DEFAULT_PROFILES, settings: { offsetMin: 0 },
    tests: [{ id: 't', profileId: 'chris', items: ['x'], start: 1 }], readings: [man, G('a', 0, 5)] };
  assert.equal(validateBackup(ok).ok, true);
  assert.equal(migrateBackup(ok).readings[0], man);
  assert.equal(validateBackup({ ...ok, readings: [{ ...man, time: undefined }] }).ok, false);
  const { fresh, duplicates } = dedupeReadings([G('a', 0, 5)], [man.id]);
  assert.equal(fresh.length, 1); assert.equal(duplicates, 0);
});

// ---- Shared meals ----
const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o), 'utf8').toString('base64url');
const goodShare = { v: 1, sid: 's1', p: 'lea', items: ['Rice'], mealName: '', start: 1000, note: '' };

test('shared meal round trip', () => {
  const t = { id: 'abc', profileId: 'chris', items: ['Rice', 'Egg'], mealName: 'Lunch', start: 1700000000000, note: 'big bowl' };
  const enc = encodeSharedMeal(t, 'lea');
  assert.match(enc, /^[A-Za-z0-9_-]+$/);
  const r = decodeSharedMeal(enc);
  assert.equal(r.ok, true);
  assert.deepEqual(r.meal, { sid: 'abc', p: 'lea', items: ['Rice', 'Egg'], mealName: 'Lunch', start: 1700000000000, note: 'big bowl' });
});

test('shared meal keeps unicode and handles missing optional fields', () => {
  const t = { id: 'u', items: ['Crème brûlée', 'Ei 🥚', '日本'], mealName: 'Déjà vu 🍮', start: 5, note: 'ñ' };
  const r = decodeSharedMeal(encodeSharedMeal(t, 'lea'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.meal.items, ['Crème brûlée', 'Ei 🥚', '日本']);
  assert.equal(r.meal.mealName, 'Déjà vu 🍮');
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, mealName: undefined, note: undefined })).ok, true);
});

test('shared meal rejects bad input', () => {
  for (const bad of ['', null, undefined, 42, 'not base64!!', '%%%', 'AAAA', b64u('not json'), b64u('[]'), b64u('null')]) {
    assert.equal(decodeSharedMeal(bad).ok, false, String(bad));
  }
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, items: undefined })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, items: [] })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, items: [1] })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, items: ['x'.repeat(61)] })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, items: Array.from({ length: 31 }, (_, i) => 'f' + i) })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, mealName: 'x'.repeat(61) })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, note: 'x'.repeat(501) })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, start: 'now' })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, start: null })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, p: 5 })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, sid: undefined })).ok, false);
  assert.equal(decodeSharedMeal(b64u({ ...goodShare, v: 2 })).ok, false);
  assert.equal(decodeSharedMeal('A'.repeat(30000)).ok, false);
  // truncated link
  const enc = encodeSharedMeal({ id: 'a', items: ['Rice'], start: 1 }, 'lea');
  assert.equal(decodeSharedMeal(enc.slice(0, enc.length - 8)).ok, false);
});

test('backup validation accepts the optional sharedFrom field', () => {
  const ok = { app: 'glucose-track', version: 2, profiles: DEFAULT_PROFILES, settings: { offsetMin: 0 },
    tests: [{ id: 't', profileId: 'lea', items: ['x'], start: 1, sharedFrom: 'abc' }], readings: [] };
  assert.equal(validateBackup(ok).ok, true);
  assert.equal(migrateBackup(ok).tests[0].sharedFrom, 'abc');
});
