import {
  ClassifierTable,
  DeriverList,
  RangeSelector,
} from '../../../components/admin/ClassifierTable';
import { parseRange } from '../../../components/admin/types';
import { fetchClassifiers, fetchDerivers } from '../_lib/api';
import { makeDefaultAction } from './actions';

export default async function ClassifiersPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const range = parseRange((await searchParams).range);
  const [classifiers, derivers] = await Promise.all([fetchClassifiers(range), fetchDerivers()]);
  return (
    <main className="space-y-8">
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Classifiers</h1>
          <RangeSelector range={range} />
        </div>
        <ClassifierTable rows={classifiers} promote={makeDefaultAction} />
      </section>
      <section>
        <h2 className="mb-2 text-lg font-semibold">Derivers</h2>
        <p className="mb-2 text-sm text-slate-500">
          Read-only. Changing the default deriver alters the EF series and needs a recompute.
        </p>
        <DeriverList rows={derivers} />
      </section>
    </main>
  );
}
