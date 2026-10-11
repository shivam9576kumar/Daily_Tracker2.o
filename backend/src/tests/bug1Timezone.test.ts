import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dateKeyInTz,
  isValidTimeZone,
  resolveTimeZone,
  taskScheduleFromInput,
  zonedDayRangeUtc,
} from '../utils/dateKeys';

test('Bug 1-A: Timezone resolution and fallback', () => {
  assert.equal(resolveTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(resolveTimeZone('America/New_York'), 'America/New_York');
  assert.equal(resolveTimeZone(null), 'Asia/Kolkata');
  assert.equal(resolveTimeZone('Invalid/TZ'), 'Asia/Kolkata');
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Invalid/Zone'), false);
});

test('Bug 1-B: dateKeyInTz across international date lines', () => {
  // 2026-10-14 20:00:00 UTC:
  // In UTC: 2026-10-14
  // In Asia/Kolkata (+5:30): 2026-10-15 01:30:00 -> 2026-10-15
  // In America/Los_Angeles (-7:00 / PDT): 2026-10-14 13:00:00 -> 2026-10-14
  const dt = new Date('2026-10-14T20:00:00.000Z');
  assert.equal(dateKeyInTz(dt, 'UTC'), '2026-10-14');
  assert.equal(dateKeyInTz(dt, 'Asia/Kolkata'), '2026-10-15');
  assert.equal(dateKeyInTz(dt, 'America/Los_Angeles'), '2026-10-14');
});

test('Bug 1-C: taskScheduleFromInput produces consistent UTC anchor and dateKey', () => {
  const sched = taskScheduleFromInput('2026-10-15', 'Asia/Kolkata');
  assert.equal(sched.scheduledDateKey, '2026-10-15');
  // Midnight in IST is 18:30 UTC of previous day
  assert.equal(sched.scheduledDate.toISOString(), '2026-10-14T18:30:00.000Z');

  const range = zonedDayRangeUtc('2026-10-15', 'Asia/Kolkata');
  assert.equal(range.start.toISOString(), '2026-10-14T18:30:00.000Z');
  assert.equal(range.end.toISOString(), '2026-10-15T18:30:00.000Z');
});
