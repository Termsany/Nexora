import { useState, type FormEvent } from 'react';
import { Cpu, LoaderCircle, LogIn } from 'lucide-react';
import { InlineNotice } from '@/components/console-ui';
import { useSession } from '@/lib/session';

export default function Login() {
  const { refetch } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        // The server deliberately does not distinguish an unknown account from a
        // wrong password; the console repeats that single message.
        setError(response.status === 401 ? 'Invalid email or password.' : `Sign in failed (${response.status}).`);
        setBusy(false);
        return;
      }
      setPassword('');
      refetch();
    } catch {
      setError('Could not reach the Nexora API.');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex items-center justify-center gap-3">
          <span className="relative flex h-10 w-10 items-center justify-center rounded-md bg-accent text-accent-foreground shadow-sm">
            <Cpu size={21} strokeWidth={2.5} />
          </span>
          <span className="text-[22px] font-semibold tracking-[-0.03em] text-primary">nexora<span className="text-accent">.</span></span>
        </div>
        <section className="rounded-lg border border-card-border bg-card p-6 shadow-xs">
          <h1 className="text-[16px] font-semibold tracking-[-0.02em] text-primary">Sign in</h1>
          <p className="mt-1 text-[11px] text-muted-foreground">Nexora operations console</p>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">Email</span>
              <input
                type="email" required autoComplete="username" value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-[12px] outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
                data-testid="input-login-email"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">Password</span>
              <input
                type="password" required autoComplete="current-password" value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-[12px] outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
                data-testid="input-login-password"
              />
            </label>
            {error && <InlineNotice tone="red">{error}</InlineNotice>}
            <button
              type="submit" disabled={busy}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-[11px] font-bold text-primary-foreground transition-colors hover:bg-[#2e4f68] disabled:opacity-50"
              data-testid="button-login"
            >
              {busy ? <LoaderCircle size={14} className="animate-spin" /> : <LogIn size={14} />}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </section>
        <p className="mt-5 text-center text-[10px] text-muted-foreground">
          Access is limited to the organizations your account is assigned to.
        </p>
      </div>
    </div>
  );
}
