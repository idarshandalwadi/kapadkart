import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { returnLateness, returnsScheduleWhere } from '../src/routes/tenant/tenant.helpers.js';

// 2026-11-09 13:30 IST
const NOW = new Date('2026-11-09T08:00:00.000Z');
const TODAY_START = '2026-11-08T18:30:00.000Z';
const TODAY_END = '2026-11-09T18:29:59.999Z';

describe('returns schedule windows', () => {
  it('treats today as the Asia/Kolkata calendar day', () => {
    const where = returnsScheduleWhere('today', NOW);
    assert.equal(where.returnDate.gte.toISOString(), TODAY_START);
    assert.equal(where.returnDate.lte.toISOString(), TODAY_END);
  });

  it('keeps tomorrow, overdue, and the rest of the next 7 days distinct', () => {
    const tomorrow = returnsScheduleWhere('tomorrow', NOW);
    const overdue = returnsScheduleWhere('overdue', NOW);
    const upcoming = returnsScheduleWhere('upcoming', NOW);

    assert.equal(tomorrow.returnDate.gte.toISOString(), '2026-11-09T18:30:00.000Z');
    assert.equal(tomorrow.returnDate.lte.toISOString(), '2026-11-10T18:29:59.999Z');
    assert.equal(overdue.returnDate.lt.toISOString(), TODAY_START);
    assert.equal(upcoming.returnDate.gte.toISOString(), '2026-11-10T18:30:00.000Z');
    assert.equal(upcoming.returnDate.lte.toISOString(), '2026-11-16T18:29:59.999Z');
  });

  it('counts overdue days from the Kolkata date, not the clock time', () => {
    const yesterday = returnLateness(new Date('2026-11-08T06:30:00.000Z'), NOW);
    const laterToday = returnLateness(new Date('2026-11-09T04:30:00.000Z'), NOW);

    assert.deepEqual(yesterday, { is_overdue: true, overdue_days: 1 });
    assert.deepEqual(laterToday, { is_overdue: false, overdue_days: 0 });
  });
});
