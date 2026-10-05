import type { ClassifierComparisonRow } from './types';

/** Plain GET form (works without JS): sets ?classifier= on the drill-down. */
export function ClassifierSwitch({
  classifiers,
  selected,
}: {
  classifiers: Pick<ClassifierComparisonRow, 'id' | 'isDefault'>[];
  selected: string | null;
}) {
  const def = classifiers.find((c) => c.isDefault)?.id ?? null;
  const active = selected ?? def;
  const nonDefault = active != null && active !== def;
  return (
    <div className="space-y-2">
      <form method="get" className="flex items-center gap-2 text-sm">
        <label htmlFor="classifier">Classifier</label>
        <select
          id="classifier"
          name="classifier"
          defaultValue={active ?? ''}
          className="rounded border bg-transparent px-2 py-1"
        >
          {classifiers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}
              {c.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded border px-2 py-1">
          View
        </button>
      </form>
      {nonDefault && (
        <p
          role="alert"
          className="rounded border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100"
        >
          Viewing non-default classifier <code>{active}</code>. This is not what the athlete sees
          (they see <code>{def}</code>).
        </p>
      )}
    </div>
  );
}
