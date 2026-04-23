import { useEffect, useMemo, useState } from 'react';
import { LockKeyhole, LockOpen, RotateCcw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const COMMISSION_SESSION_KEY = 'forecast_commission_unlocked';

async function hashWithFallback(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

export async function hashPin(pin: string): Promise<string> {
  return hashWithFallback(pin.trim());
}

interface CommissionLockProps {
  pinHash: string | null;
  onPinHashChange: (pinHash: string | null) => void;
  children: React.ReactNode;
}

export default function CommissionLock({ pinHash, onPinHashChange, children }: CommissionLockProps) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [mode, setMode] = useState<'set' | 'unlock' | 'change'>('unlock');
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(COMMISSION_SESSION_KEY) === 'true');

  useEffect(() => {
    if (!pinHash) {
      setUnlocked(false);
      setMode('set');
      sessionStorage.removeItem(COMMISSION_SESSION_KEY);
      return;
    }

    setMode(currentMode => (currentMode === 'set' ? 'unlock' : currentMode));
    setUnlocked(sessionStorage.getItem(COMMISSION_SESSION_KEY) === 'true');
  }, [pinHash]);

  const helperText = useMemo(
    () => 'Browser-local privacy only. This hides commission data in this browser, but it is not a true security boundary.',
    [],
  );

  const resetForm = () => {
    setPin('');
    setConfirmPin('');
    setError(null);
  };

  const handleSetPin = async () => {
    if (pin.trim().length < 4) {
      setError('PIN must be at least 4 digits.');
      return;
    }
    if (pin !== confirmPin) {
      setError('PINs do not match.');
      return;
    }

    const nextHash = await hashPin(pin);
    onPinHashChange(nextHash);
    sessionStorage.setItem(COMMISSION_SESSION_KEY, 'true');
    setUnlocked(true);
    setMode('unlock');
    resetForm();
  };

  const handleUnlock = async () => {
    if (!pinHash) {
      setMode('set');
      return;
    }

    const attemptedHash = await hashPin(pin);
    if (attemptedHash !== pinHash) {
      setError('Incorrect PIN.');
      return;
    }

    sessionStorage.setItem(COMMISSION_SESSION_KEY, 'true');
    setUnlocked(true);
    resetForm();
  };

  const handleChangePin = async () => {
    if (!pinHash) {
      setMode('set');
      return;
    }
    if (pin.trim().length < 4) {
      setError('PIN must be at least 4 digits.');
      return;
    }
    if (pin !== confirmPin) {
      setError('PINs do not match.');
      return;
    }

    const nextHash = await hashPin(pin);
    onPinHashChange(nextHash);
    sessionStorage.setItem(COMMISSION_SESSION_KEY, 'true');
    setUnlocked(true);
    setMode('unlock');
    resetForm();
  };

  const handleRelock = () => {
    sessionStorage.removeItem(COMMISSION_SESSION_KEY);
    setUnlocked(false);
    setMode('unlock');
    resetForm();
  };

  const handleReset = () => {
    onPinHashChange(null);
    handleRelock();
    setMode('set');
  };

  if (unlocked && pinHash) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 px-4 py-3">
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <LockOpen className="mt-0.5 h-4 w-4 text-foreground" />
            <div>
              <p className="font-medium text-foreground">Commission review unlocked</p>
              <p>{helperText}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setMode('change')}>
              Change PIN
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleRelock}>
              Relock
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleReset}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset PIN
            </Button>
          </div>
        </div>

        {mode === 'change' && (
          <div className="grid gap-3 rounded-md border border-border bg-background px-4 py-4 md:grid-cols-[1fr_1fr_auto]">
            <Input type="password" inputMode="numeric" placeholder="New PIN" value={pin} onChange={event => setPin(event.target.value)} />
            <Input type="password" inputMode="numeric" placeholder="Confirm PIN" value={confirmPin} onChange={event => setConfirmPin(event.target.value)} />
            <Button type="button" onClick={handleChangePin}>Save PIN</Button>
            {error && <p className="text-sm text-destructive md:col-span-3">{error}</p>}
          </div>
        )}

        {children}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-secondary/20 px-4 py-4">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-md border border-border bg-background p-2 text-foreground">
          {pinHash ? <LockKeyhole className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">PIN-locked commission review</h3>
          <p className="text-sm text-muted-foreground">{helperText}</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <Input
          type="password"
          inputMode="numeric"
          placeholder={pinHash ? 'Enter PIN' : 'Create PIN'}
          value={pin}
          onChange={event => setPin(event.target.value)}
        />
        <Input
          type="password"
          inputMode="numeric"
          placeholder={pinHash ? 'Re-enter PIN to change later' : 'Confirm PIN'}
          value={confirmPin}
          onChange={event => setConfirmPin(event.target.value)}
          disabled={pinHash && mode !== 'change' && !pinHash}
        />
        <Button type="button" onClick={pinHash ? handleUnlock : handleSetPin}>
          {pinHash ? 'Unlock' : 'Set PIN'}
        </Button>
      </div>

      {pinHash && (
        <p className="mt-3 text-xs text-muted-foreground">
          Enter your PIN to review statement-level expected commissions and anomalies.
        </p>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}
