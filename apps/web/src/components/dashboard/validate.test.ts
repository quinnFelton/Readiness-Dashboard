import { describe, expect, it } from 'vitest';
import { MAX_COMMENT, MAX_NOTES, isValidDate, validateEvent, validateVote } from './validate';

describe('isValidDate', () => {
  it('accepts real dates only', () => {
    expect(isValidDate('2026-09-27')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('27/09/2026')).toBe(false);
    expect(isValidDate(20260927)).toBe(false);
  });
});

describe('validateVote', () => {
  const ok = { classifierId: 'c1', asOf: '2026-09-27', vote: 1 };
  it('accepts a vote and trims/omits empty comments', () => {
    expect(validateVote(ok)).toEqual({ ok: true, value: ok });
    expect(validateVote({ ...ok, comment: '  hi ' })).toMatchObject({ value: { comment: 'hi' } });
    expect(validateVote({ ...ok, comment: '   ' })).toEqual({ ok: true, value: ok });
  });
  it('rejects bad votes, dates, ids and long comments', () => {
    expect(validateVote({ ...ok, vote: 0 }).ok).toBe(false);
    expect(validateVote({ ...ok, asOf: 'x' }).ok).toBe(false);
    expect(validateVote({ ...ok, classifierId: '' }).ok).toBe(false);
    expect(validateVote({ ...ok, comment: 'x'.repeat(MAX_COMMENT + 1) }).ok).toBe(false);
    expect(validateVote(null).ok).toBe(false);
  });
  it('error messages never echo user text', () => {
    const r = validateVote({ ...ok, comment: 'secret'.repeat(100) });
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});

describe('validateEvent', () => {
  const ok = { date: '2026-09-20', eventType: 'illness' };
  it('accepts valid events', () => {
    expect(validateEvent({ ...ok, notes: ' cold ' })).toEqual({
      ok: true,
      value: { ...ok, notes: 'cold' },
    });
  });
  it('rejects unknown types, bad dates and long notes', () => {
    expect(validateEvent({ ...ok, eventType: 'party' }).ok).toBe(false);
    expect(validateEvent({ ...ok, date: '' }).ok).toBe(false);
    expect(validateEvent({ ...ok, notes: 'x'.repeat(MAX_NOTES + 1) }).ok).toBe(false);
  });
});
