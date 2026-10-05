'use client';

// "Log event" form + recent events with delete (PLAN §8.7 outcome tracking). Notes are
// health-adjacent free text: rendered, never logged.
import { useState, useTransition, type FormEvent } from 'react';
import {
  ATHLETE_EVENT_TYPES,
  type AthleteEvent,
  type AthleteEventType,
  type PostAthleteEventBody,
} from '@rd/shared-types';
import { EVENT_LABEL } from './model';
import { MAX_NOTES, type ActionResult } from './validate';

export interface EventLogProps {
  events: AthleteEvent[];
  /** YYYY-MM-DD default for the date field (passed in so render stays deterministic). */
  today: string;
  onCreate: (input: PostAthleteEventBody) => Promise<ActionResult>;
  onDelete: (eventId: string) => Promise<ActionResult>;
}

export function EventLog({ events, today, onCreate, onDelete }: EventLogProps) {
  const [date, setDate] = useState(today);
  const [eventType, setEventType] = useState<AthleteEventType>('illness');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await onCreate({
        date,
        eventType,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      if (res.ok) setNotes('');
      else setError(res.error);
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await onDelete(id);
      if (!res.ok) setError(res.error);
    });
  }

  const recent = [...events].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  const field = 'rounded-md border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-600';

  return (
    <section
      aria-labelledby="event-log-heading"
      className="rounded-lg border border-slate-200 p-4 dark:border-slate-700"
    >
      <h2 id="event-log-heading" className="text-lg font-semibold">
        Event log
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Log illness, injury, races or planned rest. They appear on the chart and help us check which
        insights were right.
      </p>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          Date
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Type
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value as AthleteEventType)}
            className={field}
          >
            {ATHLETE_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVENT_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Notes (optional)
          <textarea
            value={notes}
            maxLength={MAX_NOTES}
            rows={2}
            onChange={(e) => setNotes(e.target.value)}
            className={field}
          />
        </label>
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Log event
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {recent.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">No events logged yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-200 text-sm dark:divide-slate-700">
          {recent.map((ev) => (
            <li key={ev.id} className="flex items-start justify-between gap-3 py-2">
              <div>
                <span className="font-medium">{EVENT_LABEL[ev.eventType]}</span>{' '}
                <span className="text-slate-500 dark:text-slate-400">{ev.date}</span>
                {ev.notes && <p className="text-slate-600 dark:text-slate-300">{ev.notes}</p>}
              </div>
              <button
                type="button"
                disabled={pending}
                aria-label={`Delete ${EVENT_LABEL[ev.eventType]} on ${ev.date}`}
                onClick={() => remove(ev.id)}
                className="text-red-600 underline disabled:opacity-50 dark:text-red-400"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
