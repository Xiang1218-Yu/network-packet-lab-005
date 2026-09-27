import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MarkerBundle, PacketMarker } from '../shared/types.js';
import { sanitizeMarker } from '../shared/markers.js';

const DATA_DIR = join(process.cwd(), 'data');
const STORE_FILE = join(DATA_DIR, 'markers.json');

type Store = Record<string, PacketMarker[]>;

let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  try {
    if (existsSync(STORE_FILE)) {
      const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') cache = parsed as Store;
    }
  } catch (error) {
    console.warn('[markers] store unreadable, starting empty:', error instanceof Error ? error.message : error);
  }
  cache ??= {};
  return cache;
}

function persist() {
  const store = load();
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn('[markers] unable to persist store:', error instanceof Error ? error.message : error);
  }
}

export function getBundle(frameId: string): MarkerBundle {
  return { frameId, markers: load()[frameId] ?? [] };
}

export function putBundle(frameId: string, rawMarkers: unknown[]): MarkerBundle {
  const markers = rawMarkers
    .map((entry) => sanitizeMarker(entry, frameId))
    .filter((entry): entry is PacketMarker => entry !== null);
  const store = load();
  store[frameId] = markers;
  persist();
  return { frameId, markers };
}

export function allBundles(): MarkerBundle[] {
  const store = load();
  return Object.entries(store).map(([frameId, markers]) => ({ frameId, markers }));
}
