// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsightRating } from './InsightRating';

afterEach(cleanup);

const base = { classifierId: 'ef_quadrant_v1', asOf: '2026-09-27' };

describe('InsightRating', () => {
  it('shows the current vote as pressed', () => {
    render(<InsightRating {...base} current={{ vote: -1, comment: null }} onVote={vi.fn()} />);
    expect(screen.getByRole('button', { name: /thumbs down/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /thumbs up/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('records the vote against classifier id and as-of date', async () => {
    const onVote = vi.fn().mockResolvedValue({ ok: true });
    render(<InsightRating {...base} current={null} onVote={onVote} />);
    await userEvent.click(screen.getByRole('button', { name: /thumbs up/i }));
    expect(onVote).toHaveBeenCalledWith({ ...base, vote: 1 });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
  });

  it('lets the user change the vote and add a comment', async () => {
    const onVote = vi.fn().mockResolvedValue({ ok: true });
    render(<InsightRating {...base} current={{ vote: 1, comment: null }} onVote={onVote} />);
    await userEvent.click(screen.getByRole('button', { name: /thumbs down/i }));
    await userEvent.click(screen.getByRole('button', { name: /add comment/i }));
    await userEvent.type(screen.getByRole('textbox'), 'felt fine');
    await userEvent.click(screen.getByRole('button', { name: /save comment/i }));
    expect(onVote).toHaveBeenLastCalledWith({ ...base, vote: -1, comment: 'felt fine' });
  });

  it('rolls back and shows an error when the save fails', async () => {
    const onVote = vi.fn().mockResolvedValue({ ok: false, error: 'Not allowed.' });
    render(<InsightRating {...base} current={{ vote: 1, comment: null }} onVote={onVote} />);
    await userEvent.click(screen.getByRole('button', { name: /thumbs down/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed.');
    expect(screen.getByRole('button', { name: /thumbs up/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('does not write notes or comments to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const onVote = vi.fn().mockResolvedValue({ ok: true });
    render(<InsightRating {...base} current={{ vote: 1, comment: null }} onVote={onVote} />);
    await userEvent.click(screen.getByRole('button', { name: /add comment/i }));
    await userEvent.type(screen.getByRole('textbox'), 'private words');
    await userEvent.click(screen.getByRole('button', { name: /save comment/i }));
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain('private words');
      s.mockRestore();
    }
  });
});
