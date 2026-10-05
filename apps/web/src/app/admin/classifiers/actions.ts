'use server';
import { revalidatePath } from 'next/cache';
import { promoteClassifier } from '../_lib/api';
import { requireMasterSession } from '../_lib/require-master';

/** Server action: re-checks master role, then the API enforces it again (403). */
export async function makeDefaultAction(formData: FormData): Promise<void> {
  await requireMasterSession();
  const id = formData.get('classifierId');
  if (typeof id !== 'string' || id === '') throw new Error('classifierId required');
  await promoteClassifier(id);
  revalidatePath('/admin/classifiers');
}
