import { useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import Login from './Login';

/**
 * Gates the app behind authentication. Children (which include ForecastProvider)
 * only mount once a session exists, so unauthenticated visitors never load app
 * state. Data persistence is unchanged — still localStorage — this only controls
 * access.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  if (!session) return <Login />;
  return <>{children}</>;
}
