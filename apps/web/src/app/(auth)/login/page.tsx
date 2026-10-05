import { signIn } from '@/lib/auth';

// Only same-origin relative paths are accepted (prevents open redirects).
function safeCallbackUrl(raw: string | undefined): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) return raw;
  return '/dashboard';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const sp = await searchParams;
  const cb = Array.isArray(sp.callbackUrl) ? sp.callbackUrl[0] : sp.callbackUrl;
  const redirectTo = safeCallbackUrl(cb);

  async function login(formData: FormData) {
    'use server';
    await signIn('credentials', {
      email: formData.get('email'),
      password: formData.get('password'),
      redirectTo,
    });
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
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
