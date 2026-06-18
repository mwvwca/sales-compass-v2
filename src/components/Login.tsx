import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';

/**
 * Email + password sign-in for a single existing user. No sign-up flow and no
 * magic link by design — the account is provisioned in Supabase directly.
 * On success, AuthGate's onAuthStateChange listener swaps in the app.
 */
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setError(error.message);
      setSubmitting(false);
    }
    // On success we intentionally leave submitting=true; AuthGate unmounts this
    // component once the session arrives.
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm border border-border rounded-lg p-6 space-y-4">
        <div className="space-y-1">
          <h1 className="text-sm font-semibold tracking-tight">FORECAST</h1>
          <p className="text-xs text-muted-foreground">Sign in to continue.</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="email" className="text-xs text-muted-foreground">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className="text-xs text-muted-foreground">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? <Loader2 size={14} className="animate-spin" /> : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
