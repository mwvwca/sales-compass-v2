import { useEffect, useState } from 'react';

/**
 * N2 fix: tabs unmount on every switch, so useState-held filters reset
 * whenever the user leaves and returns (e.g. filter DR Pipeline, open a deal
 * in Deal 360, come back: every filter is gone). This hook mirrors state to
 * sessionStorage so filter context survives tab switches for the browser
 * session without leaking into long-term storage.
 *
 * Works with any JSON-serializable value. For Sets, pass a serializer pair.
 */
export function usePersistedState<T>(
  key: string,
  initial: T | (() => T),
  codec?: { serialize: (v: T) => unknown; deserialize: (raw: unknown) => T },
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        return codec ? codec.deserialize(parsed) : (parsed as T);
      }
    } catch { /* fall through to initial */ }
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });

  useEffect(() => {
    try {
      const payload = codec ? codec.serialize(value) : value;
      sessionStorage.setItem(key, JSON.stringify(payload));
    } catch { /* storage blocked or full: state still works in memory */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value]);

  return [value, setValue];
}

/** Codec for Set<string>-shaped state. */
export const stringSetCodec = {
  serialize: (v: Set<string>) => Array.from(v),
  deserialize: (raw: unknown): Set<string> => new Set(Array.isArray(raw) ? (raw as string[]) : []),
};
