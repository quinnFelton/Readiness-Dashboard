import { signIn } from '@/lib/auth';

export default function LoginPage() {
  async function login(formData: FormData) {
    'use server';
    await signIn('credentials', {
      email: formData.get('email'),
      password: formData.get('password'),
      redirectTo: '/dashboard',
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
