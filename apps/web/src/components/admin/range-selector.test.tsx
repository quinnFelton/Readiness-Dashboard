// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RangeSelector } from './ClassifierTable';
import { parseRange, RANGES } from './types';

afterEach(cleanup);

describe('RangeSelector', () => {
  it('offers every range and marks the active one', () => {
    const { container } = render(<RangeSelector range="30d" />);
    const text = container.textContent ?? '';
    for (const r of RANGES) expect(text).toContain(r.replace('d', ''));
    const hrefs = screen.queryAllByRole('link').map((l) => l.getAttribute('href'));
    if (hrefs.length) for (const r of RANGES) expect(hrefs.join()).toContain(`range=${r}`);
  });
  it('parseRange falls back to 90d for junk', () => {
    expect(parseRange(undefined)).toBe('90d');
    expect(parseRange('9999d')).toBe('90d');
    expect(parseRange('365d')).toBe('365d');
  });
});
