'use client';
import { useRef } from 'react';

// Confirmation explains the user-visible effect (PLAN §8.7: routes return only the default's rows).
export function PromoteButton({
  classifierId,
  currentDefaultId,
  action,
}: {
  classifierId: string;
  currentDefaultId: string | null;
  action: (fd: FormData) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        className="rounded border px-2 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
        onClick={() => dialog.current?.showModal()}
      >
        Make default
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={`promote-${classifierId}`}
        className="rounded p-6 backdrop:bg-black/50"
      >
        <h2 id={`promote-${classifierId}`} className="text-lg font-semibold">
          Make <code>{classifierId}</code> the default?
        </h2>
        <p className="mt-2 max-w-md text-sm">
          Every athlete&apos;s dashboard, trends and insights will immediately switch to this
          classifier
          {currentDefaultId ? (
            <>
              {' '}
              instead of <code>{currentDefaultId}</code>
            </>
          ) : null}
          . Their fatigue/fitness states and flags may change. No data is recomputed or deleted, and
          you can switch back at any time.
        </p>
        <form action={action} className="mt-4 flex justify-end gap-2">
          <input type="hidden" name="classifierId" value={classifierId} />
          <button
            type="button"
            className="rounded border px-3 py-1"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button type="submit" className="rounded bg-blue-600 px-3 py-1 text-white">
            Confirm
          </button>
        </form>
      </dialog>
    </>
  );
}
