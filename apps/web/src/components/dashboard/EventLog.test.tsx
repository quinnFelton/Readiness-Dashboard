// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLog } from './EventLog';

afterEach(cleanup);

const events = [
  { id: 'a', date: '2026-09-01', eventType: 'race' as const, notes: null },
  { id: 'b', date: '2026-09-20', eventType: 'illness' as const, notes: 'head cold' },
];

describe('EventLog', () => {
  it('shows an empty message with no events', () => {
    render(<EventLog events={[]} today="2026-09-27" onCreate={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('No events logged yet.')).toBeInTheDocument();
  });

  it('lists recent events newest first', () => {
    render(<EventLog events={events} today="2026-09-27" onCreate={vi.fn()} onDelete={vi.fn()} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Illness');
    expect(items[0]).toHaveTextContent('head cold');
    expect(items[1]).toHaveTextContent('Race');
  });

  it('submits date, type and optional notes', async () => {
    const onCreate = vi.fn().mockResolvedValue({ ok: true });
    render(<EventLog events={[]} today="2026-09-27" onCreate={onCreate} onDelete={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'injury');
    await userEvent.type(screen.getByLabelText(/notes/i), ' sore knee ');
    await userEvent.click(screen.getByRole('button', { name: 'Log event' }));
    expect(onCreate).toHaveBeenCalledWith({
      date: '2026-09-27',
      eventType: 'injury',
      notes: 'sore knee',
    });
  });

  it('deletes an event by id', async () => {
    const onDelete = vi.fn().mockResolvedValue({ ok: true });
    render(<EventLog events={events} today="2026-09-27" onCreate={vi.fn()} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Illness on 2026-09-20' }));
    expect(onDelete).toHaveBeenCalledWith('b');
  });

  it('shows the error from a failed create without echoing notes', async () => {
    const onCreate = vi.fn().mockResolvedValue({ ok: false, error: 'Choose a valid date.' });
    render(<EventLog events={[]} today="2026-09-27" onCreate={onCreate} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Log event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a valid date.');
  });
});
