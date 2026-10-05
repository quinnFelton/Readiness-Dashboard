import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '@/lib/auth';

// Only same-origin relative paths are accepted (prevents open redirects).
function safeCallbackUrl(raw: string | undefined): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) return raw;
  return '/dashboard';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[]; error?: string | string[] }>;
}) {
  const sp = await searchParams;
  const cb = Array.isArray(sp.callbackUrl) ? sp.callbackUrl[0] : sp.callbackUrl;
  const redirectTo = safeCallbackUrl(cb);
  const hasError = Boolean(Array.isArray(sp.error) ? sp.error[0] : sp.error);

  async function login(formData: FormData) {
    'use server';
    try {
      await signIn('credentials', {
        email: formData.get('email'),
        password: formData.get('password'),
        redirectTo,
      });
    } catch (err) {
      // Bad credentials surface as AuthError (CredentialsSignin); show the form again with a
      // message. Anything else (notably the NEXT_REDIRECT thrown on success) must propagate.
      if (err instanceof AuthError) {
        const params = new URLSearchParams({ error: 'CredentialsSignin' });
        if (redirectTo !== '/dashboard') params.set('callbackUrl', redirectTo);
        redirect(`/login?${params.toString()}`);
      }
      throw err;
    }
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      {hasError && (
        <p
          role="alert"
          className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          Invalid email or password.
        </p>
      )}
      <form action={login} className="mt-6 space-y-4">
        <input
          name="email"
          type="email"
          required
          placeholder="Email"
          className="w-full rounded border px-3 py-2"
        />
        <input
          name="password"
          type="password"
          required
          placeholder="Password"
          className="w-full rounded border px-3 py-2"
        />
        <button type="submit" className="w-full rounded bg-slate-900 px-3 py-2 text-white">
          Sign in
        </button>
      </form>
    </main>
  );
}
