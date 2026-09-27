const PREFIX = 'packet-lab:';

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (error) {
    // Quota / private mode: annotation edits must still live in memory.
    console.warn('[storage] unable to persist', key, error);
  }
}

export const STORAGE_KEYS = {
  markers: 'markers-v1',
  captures: 'captures-v1',
  failMarkers: 'fail-markers-v1',
  pending: 'pending-v1'
} as const;
