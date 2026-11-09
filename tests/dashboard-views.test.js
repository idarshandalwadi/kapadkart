import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bookingListViewWhere, istDateRange } from '../src/routes/tenant/tenant.helpers.js';

describe('dashboard booking views', () => {
  const now = new Date('2026-11-09T08:00:00+05:30');

  it('today pickup view is not a fake status filter', () => {
    const where = bookingListViewWhere('pickup_today', now);
    assert.deepEqual(where.status, { notIn: ['cancelled', 'returned', 'completed'] });
    assert.ok(where.pickupDate.gte < where.pickupDate.lte);
  });

  it('overdue view uses open rental statuses and a past return date', () => {
    const where = bookingListViewWhere('overdue', now);
    assert.ok(where.status.in.includes('sent'));
    assert.ok(where.status.in.includes('booked'));
    assert.equal(where.returnDate.lt.toISOString(), where && bookingListViewWhere('due_today', now).returnDate.gte.toISOString());
  });

  it('a normal status is left for the status filter', () => {
    assert.equal(bookingListViewWhere('booked', now), null);
  });

  it('date-only ranges stay on the India calendar day', () => {
    const range = istDateRange('2026-11-09');
    assert.equal(range.gte.toISOString(), '2026-11-08T18:30:00.000Z');
    assert.equal(range.lte.toISOString(), '2026-11-09T18:29:59.999Z');
  });
});
