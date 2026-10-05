'use client';

// Thumbs up/down on one insight (PLAN §8.7). The vote is recorded against the classifier id
// and as-of date shown. Re-voting updates the existing vote; the optional comment is free text
// and is never logged.
import { useState, useTransition } from 'react';
import type { InsightFeedback, InsightVote } from '@rd/shared-types';
import { MAX_COMMENT, type ActionResult } from './validate';

export interface InsightRatingProps {
  classifierId: string;
  asOf: string;
  current: Pick<InsightFeedback, 'vote' | 'comment'> | null;
  /** Server action bound to the athlete's userId. */
  onVote: (input: {
    classifierId: string;
    asOf: string;
    vote: InsightVote;
    comment?: string;
  }) => Promise<ActionResult>;
  /** Disambiguates multiple widgets on one page for assistive tech. */
  label?: string;
}

export function InsightRating({ classifierId, asOf, current, onVote, label }: InsightRatingProps) {
  const [vote, setVote] = useState<InsightVote | null>(current?.vote ?? null);
  const [comment, setComment] = useState(current?.comment ?? '');
  const [showComment, setShowComment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const name = label ?? `insight for ${asOf}`;

  function submit(next: InsightVote) {
    const previous = vote;
    setVote(next);
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await onVote({
        classifierId,
        asOf,
        vote: next,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      if (res.ok) setSaved(true);
      else {
        setVote(previous); // roll back the optimistic vote
        setError(res.error);
      }
    });
  }

  return (
    <div className="mt-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-slate-500 dark:text-slate-400">Was this helpful?</span>
        {([1, -1] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={vote === v}
            aria-label={`${v === 1 ? 'Thumbs up' : 'Thumbs down'}: ${name}`}
            disabled={pending}
            onClick={() => submit(v)}
            className={`rounded-md border px-2 py-1 disabled:opacity-50 ${
              vote === v
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-slate-300 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800'
            }`}
          >
            {v === 1 ? '👍' : '👎'}
          </button>
        ))}
        {vote !== null && (
          <button
            type="button"
            className="text-blue-700 underline dark:text-blue-400"
            onClick={() => setShowComment((s) => !s)}
          >
            {comment ? 'Edit comment' : 'Add comment'}
          </button>
        )}
        {saved && !pending && <span role="status">Saved</span>}
      </div>
      {showComment && vote !== null && (
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="sr-only">Comment on {name}</span>
            <textarea
              value={comment}
              maxLength={MAX_COMMENT}
              rows={2}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Optional short comment"
              className="rounded-md border border-slate-300 bg-transparent p-2 dark:border-slate-600"
            />
          </label>
          <button
            type="button"
            disabled={pending}
            onClick={() => submit(vote)}
            className="self-start rounded-md border border-slate-300 px-3 py-1 disabled:opacity-50 dark:border-slate-600"
          >
            Save comment
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
