'use server';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/auth/api-fetch';

// Server actions: the browser never sees a token; every call is authorised again by the API.

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const PROVIDER_RE = /^[a-z0-9_-]{1,32}$/;

export async function startConnection(
  provider: string,
): Promise<ActionResult<{ redirectUrl: string }>> {
  if (!PROVIDER_RE.test(provider)) return { ok: false, error: 'Unknown provider.' };
  try {
    const res = await apiFetch(`/connections/${provider}/start`, { method: 'POST' });
    if (!res.ok) return { ok: false, error: 'Could not start the connection. Please try again.' };
    const { redirectUrl } = (await res.json()) as { redirectUrl: string };
    return { ok: true, data: { redirectUrl } };
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}

export async function disconnectProvider(provider: string): Promise<ActionResult> {
  if (!PROVIDER_RE.test(provider)) return { ok: false, error: 'Unknown provider.' };
  try {
    const res = await apiFetch(`/connections/${provider}`, { method: 'DELETE' });
    if (!res.ok) return { ok: false, error: 'Could not disconnect. Please try again.' };
    revalidatePath('/settings/connections');
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}

export async function saveSources(input: {
  activitySource?: string | null;
  dailyMetricsSources?: string[];
}): Promise<ActionResult> {
  try {
    const res = await apiFetch('/connections/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: 'Could not save your changes.' };
    revalidatePath('/settings/connections');
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}
