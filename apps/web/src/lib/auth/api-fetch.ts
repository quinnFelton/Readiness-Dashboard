import 'server-only';
import { auth } from './index';
import { mintApiToken } from './api-token';

/** Server Components call the REST API through this; attaches a freshly minted token. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = await auth();
  if (!session?.user) throw new Error('not authenticated');
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${mintApiToken(session.user)}`);
  const base = process.env.API_URL ?? 'http://localhost:4000';
  return fetch(`${base}/api/v1${path}`, { ...init, headers, cache: 'no-store' });
}
