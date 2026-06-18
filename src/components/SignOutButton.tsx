import { LogOut } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

/** Signs the user out; AuthGate's listener then swaps back to the login screen. */
export default function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => { void supabase.auth.signOut(); }}
      title="Sign out"
      className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <LogOut size={13} />
      Sign out
    </button>
  );
}
