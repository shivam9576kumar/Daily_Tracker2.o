import assert from 'node:assert/strict';
import test from 'node:test';
import { addDaysToKey, nextOccurrenceKey, weekdayOfKey } from '../utils/dateKeys';

test('H6-A: a calendar date key has the same weekday in every timezone (known anchor)', () => {
  // 2026-10-11 is a Sunday. The result must not depend on process TZ.
  assert.equal(weekdayOfKey('2026-10-11'), 0);
  assert.equal(weekdayOfKey('2026-10-09'), 5); // Friday
  assert.equal(weekdayOfKey('2026-10-10'), 6); // Saturday
});

test('H6-B: Friday weekday-recurrence jumps to Monday, never to Saturday or Sunday', () => {
  assert.equal(nextOccurrenceKey('2026-10-09', 'weekdays'), '2026-10-12');
});

test('H6-C: Saturday base rolls forward to Monday', () => {
  assert.equal(nextOccurrenceKey('2026-10-10', 'weekdays'), '2026-10-12');
});

test('H6-D: 1000 consecutive weekday occurrences never land on a weekend', () => {
  let key = '2026-01-01';
  for (let i = 0; i < 1000; i++) {
    key = nextOccurrenceKey(key, 'weekdays');
    const wd = weekdayOfKey(key);
    assert.ok(wd !== 0 && wd !== 6, `weekend occurrence ${key}`);
  }
});

test('H6-E: addDaysToKey is calendar-exact across a DST-observing month', () => {
  assert.equal(addDaysToKey('2026-03-07', 1), '2026-03-08');
  assert.equal(addDaysToKey('2026-03-31', 1), '2026-04-01');
});
