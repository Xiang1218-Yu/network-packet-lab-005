import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ByteRange,
  CapturesFile,
  MarkerColor,
  PacketMarker,
  ProtocolField,
  SavedCapture,
  SimulatedPacket
} from '../../../shared/types';
import { makeByteAnchor, makeFieldAnchor, migrateMarker, resolveAnchor } from '../../../shared/markers';
import { fetchMarkers, putMarkers } from '../api';
import { readStorage, STORAGE_KEYS, writeStorage } from '../storage';

export interface MigrationReport {
  oldFrameId: string;
  newFrameId: string;
  attached: PacketMarker[];
  detached: PacketMarker[];
  archived: boolean;
}

type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

type MarkerCache = Record<string, PacketMarker[]>;

export interface ImportResult {
  imported: number;
  skipped: number;
  loadedFrameId?: string;
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useAnnotations() {
  const [cache, setCache] = useState<MarkerCache>(() => readStorage<MarkerCache>(STORAGE_KEYS.markers, {}));
  const [captures, setCaptures] = useState<SavedCapture[]>(() =>
    readStorage<SavedCapture[]>(STORAGE_KEYS.captures, [])
  );
  const [activeFrameId, setActiveFrameIdState] = useState<string | null>(null);
  const [activePacket, setActivePacket] = useState<SimulatedPacket | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [lastError, setLastError] = useState('');
  const [failMarkers, setFailMarkersState] = useState<boolean>(() =>
    readStorage<boolean>(STORAGE_KEYS.failMarkers, false)
  );
  const [migration, setMigration] = useState<MigrationReport | null>(null);

  // Persisted set of frames whose edits have not been acknowledged by the
  // server. Survives reloads, so unsubmitted work is retried after restart.
  const dirtyRef = useRef<Set<string>>(new Set(readStorage<string[]>(STORAGE_KEYS.pending, [])));
  const inflightRef = useRef<Set<string>>(new Set());
  const epochRef = useRef<Map<string, number>>(new Map());
  const failRef = useRef(failMarkers);
  failRef.current = failMarkers;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adoptTokenRef = useRef(0);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const capturesRef = useRef(captures);
  capturesRef.current = captures;
  const activeFrameIdRef = useRef<string | null>(null);
  activeFrameIdRef.current = activeFrameId;
  const activePacketRef = useRef<SimulatedPacket | null>(null);
  activePacketRef.current = activePacket;

  const persistPending = useCallback(() => {
    writeStorage(STORAGE_KEYS.pending, Array.from(dirtyRef.current));
  }, []);

  useEffect(() => writeStorage(STORAGE_KEYS.markers, cache), [cache]);
  useEffect(() => writeStorage(STORAGE_KEYS.captures, captures), [captures]);
  useEffect(() => writeStorage(STORAGE_KEYS.failMarkers, failMarkers), [failMarkers]);

  const markers = useMemo(
    () => (activeFrameId ? cache[activeFrameId] ?? [] : []),
    [cache, activeFrameId]
  );

  /* ---------------------------------------------------------------- */
  /* Server sync                                                       */
  /* ---------------------------------------------------------------- */

  const pushFrame = useCallback(async (frameId: string, list?: PacketMarker[]) => {
    if (inflightRef.current.has(frameId)) return;
    const current = list ?? cacheRef.current[frameId] ?? [];
    // Snapshot the edit epoch. Edits made while the request is in flight bump
    // the epoch, so an async response can never clear a newer pending flag.
    const epoch = epochRef.current.get(frameId) ?? 0;
    inflightRef.current.add(frameId);
    setSaveStatus((status) => (status === 'saved' || status === 'idle' ? 'saving' : status));
    try {
      const bundle = await putMarkers({ frameId, markers: current }, { failMarkers: failRef.current });
      if ((epochRef.current.get(frameId) ?? 0) === epoch) {
        dirtyRef.current.delete(frameId);
        persistPending();
      }
      setCache((prev) => {
        // Prefer local edits whenever they are newer than this snapshot.
        if ((epochRef.current.get(frameId) ?? 0) === epoch) {
          return { ...prev, [frameId]: bundle.markers };
        }
        return prev;
      });
      setLastError('');
      setSaveStatus(dirtyRef.current.size ? 'pending' : 'saved');
    } catch (error) {
      // The markers stay in the local cache and in the persisted pending set;
      // they will be retried later or after a reload.
      setLastError(error instanceof Error ? error.message : '标记未能同步到服务端，已保存在本地');
      setSaveStatus('error');
    } finally {
      inflightRef.current.delete(frameId);
    }
  }, [persistPending]);

  const schedulePush = useCallback((frameId: string) => {
    dirtyRef.current.add(frameId);
    epochRef.current.set(frameId, (epochRef.current.get(frameId) ?? 0) + 1);
    persistPending();
    setSaveStatus('pending');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      dirtyRef.current.forEach((id) => void pushFrame(id));
    }, 500);
  }, [pushFrame, persistPending]);

  // Flush edits that were queued before a reload as soon as the hook mounts.
  useEffect(() => {
    if (dirtyRef.current.size) {
      const ids = Array.from(dirtyRef.current);
      setSaveStatus('pending');
      const timer = setTimeout(() => ids.forEach((id) => void pushFrame(id)), 700);
      return () => clearTimeout(timer);
    }
  }, [pushFrame]);

  // Retry failed uploads automatically; the UI also exposes a manual retry.
  useEffect(() => {
    if (saveStatus !== 'error') return;
    retryTimer.current = setTimeout(() => {
      dirtyRef.current.forEach((id) => void pushFrame(id));
    }, 8000);
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [saveStatus, pushFrame]);

  const retryPending = useCallback(() => {
    setLastError('');
    dirtyRef.current.forEach((id) => void pushFrame(id));
  }, [pushFrame]);

  const setFailMarkers = useCallback((value: boolean) => {
    setFailMarkersState(value);
    if (!value) setTimeout(retryPending, 150);
  }, [retryPending]);

  /* ---------------------------------------------------------------- */
  /* Frame lifecycle                                                   */
  /* ---------------------------------------------------------------- */

  const adoptFrame = useCallback(
    (
      packet: SimulatedPacket,
      options: { fromCapture?: boolean; markers?: PacketMarker[] } = {}
    ): MigrationReport | null => {
      const frameId = packet.frameId;
      setActivePacket(packet);
      setActiveFrameIdState(frameId);
      setMigration(null);

      // An explicitly supplied set (import) is authoritative and synchronous,
      // so the frame is never fetched from the server on top of it.
      if (options.markers) {
        setCache((prev) => ({ ...prev, [frameId]: options.markers! }));
        setSaveStatus(dirtyRef.current.has(frameId) ? 'pending' : 'idle');
        return null;
      }

      if (options.fromCapture) {
        // Restoring a saved capture is authoritative; the caller populates the
        // cache and never run migration or server fetch for it.
        setSaveStatus(dirtyRef.current.has(frameId) ? 'pending' : 'idle');
        return null;
      }

      const hasLocal = frameId in cacheRef.current;
      if (hasLocal) {
        setSaveStatus(dirtyRef.current.has(frameId) ? 'pending' : 'idle');
        return null;
      }

      // First time we see this content: pull server annotations.
      const token = ++adoptTokenRef.current;
      void fetchMarkers(frameId, { failMarkers: failRef.current })
        .then((bundle) => {
          // A newer frame may have been adopted while the request was in flight.
          if (token !== adoptTokenRef.current || activeFrameIdRef.current !== frameId) return;
          setCache((prev) => (frameId in prev ? prev : { ...prev, [frameId]: bundle.markers }));
          if (!dirtyRef.current.has(frameId)) setSaveStatus('saved');
        })
        .catch(() => {
          if (token !== adoptTokenRef.current || activeFrameIdRef.current !== frameId) return;
          // Offline first load: keep an empty local set, edits stay local.
          setCache((prev) => (frameId in prev ? prev : { ...prev, [frameId]: [] }));
          setSaveStatus('idle');
        });
      return null;
    },
    []
  );

  /**
   * Replace the active frame after a re-parse / new capture.
   * Existing annotations only carry over when their anchor still resolves
   * against the new packet; field paths or byte content that changed detach.
   */
  const replaceActiveFrame = useCallback((packet: SimulatedPacket): MigrationReport => {
    const oldFrameId = activeFrameIdRef.current;
    const oldMarkers = oldFrameId ? cacheRef.current[oldFrameId] ?? [] : [];
    const report: MigrationReport = {
      oldFrameId: oldFrameId ?? '(none)',
      newFrameId: packet.frameId,
      attached: [],
      detached: [],
      archived: false
    };

    const carried: PacketMarker[] = [];
    if (oldFrameId && packet.frameId !== oldFrameId) {
      for (const marker of oldMarkers) {
        const migrated = migrateMarker(marker, packet);
        if (migrated) {
          carried.push(migrated.marker);
          report.attached.push(migrated.marker);
        } else {
          report.detached.push(marker);
        }
      }
    }

    setActivePacket(packet);
    setActiveFrameIdState(packet.frameId);
    setMigration(report.attached.length || report.detached.length ? report : null);
    adoptTokenRef.current += 1;

    // Preserve annotations that no longer attach on the old frame capture.
    if (oldFrameId && report.detached.length) {
      const oldPacket = activePacketRef.current;
      if (oldPacket && oldPacket.frameId === oldFrameId) {
        setCaptures((prev) => {
          if (prev.some((entry) => entry.frameId === oldFrameId)) return prev;
          const capture: SavedCapture = {
            format: 'packet-lab-capture',
            version: 1,
            frameId: oldFrameId,
            packet: oldPacket,
            markers: oldMarkers,
            savedAt: new Date().toISOString(),
            label: `自动归档 · ${oldPacket.summary.slice(0, 48)}`
          };
          return [capture, ...prev];
        });
        report.archived = true;
      }
    }

    setCache((prev) => {
      const next = { ...prev };
      if (!(packet.frameId in next)) next[packet.frameId] = carried;
      return next;
    });
    if (carried.length) {
      // schedulePush marks the frame dirty, bumps the epoch and persists.
      schedulePush(packet.frameId);
    } else {
      setSaveStatus(dirtyRef.current.has(packet.frameId) ? 'pending' : 'idle');
    }

    return report;
  }, [schedulePush]);

  const dismissMigration = useCallback(() => setMigration(null), []);

  /* ---------------------------------------------------------------- */
  /* Marker edits (applied locally first; the API can never lose them) */
  /* ---------------------------------------------------------------- */

  const mutate = useCallback((frameId: string, updater: (list: PacketMarker[]) => PacketMarker[]) => {
    setCache((prev) => {
      const current = prev[frameId] ?? [];
      return { ...prev, [frameId]: updater(current) };
    });
    schedulePush(frameId);
  }, [schedulePush]);

  const addFieldMarker = useCallback((field: ProtocolField, color: MarkerColor, note: string) => {
    if (!activeFrameId) return;
    const now = new Date().toISOString();
    const marker: PacketMarker = {
      id: createId(),
      frameId: activeFrameId,
      anchor: makeFieldAnchor(field),
      color,
      note,
      createdAt: now,
      updatedAt: now
    };
    mutate(activeFrameId, (list) => [...list, marker]);
  }, [activeFrameId, mutate]);

  const addByteMarker = useCallback((range: ByteRange, color: MarkerColor, note: string, label?: string) => {
    if (!activeFrameId || !activePacket) return;
    const now = new Date().toISOString();
    const marker: PacketMarker = {
      id: createId(),
      frameId: activeFrameId,
      anchor: makeByteAnchor(activePacket.raw, range, label),
      color,
      note,
      createdAt: now,
      updatedAt: now
    };
    mutate(activeFrameId, (list) => [...list, marker]);
  }, [activeFrameId, activePacket, mutate]);

  const updateMarker = useCallback((id: string, patch: { color?: MarkerColor; note?: string }) => {
    if (!activeFrameId) return;
    const timestamp = new Date().toISOString();
    mutate(activeFrameId, (list) =>
      list.map((marker) =>
        marker.id === id ? { ...marker, ...patch, updatedAt: timestamp } : marker
      )
    );
  }, [activeFrameId, mutate]);

  const deleteMarker = useCallback((id: string) => {
    if (!activeFrameId) return;
    mutate(activeFrameId, (list) => list.filter((marker) => marker.id !== id));
  }, [activeFrameId, mutate]);

  /* ---------------------------------------------------------------- */
  /* Saved captures                                                    */
  /* ---------------------------------------------------------------- */

  const saveCapture = useCallback((label: string) => {
    if (!activePacket || !activeFrameId) return;
    const capture: SavedCapture = {
      format: 'packet-lab-capture',
      version: 1,
      frameId: activeFrameId,
      packet: activePacket,
      markers: cacheRef.current[activeFrameId] ?? [],
      savedAt: new Date().toISOString(),
      label: label || activePacket.summary
    };
    setCaptures((prev) => [capture, ...prev.filter((entry) => entry.frameId !== activeFrameId)]);
  }, [activePacket, activeFrameId]);

  const loadCapture = useCallback((capture: SavedCapture) => {
    adoptFrame(capture.packet, { fromCapture: true });
    setCache((prev) => ({ ...prev, [capture.frameId]: capture.markers }));
    if (dirtyRef.current.has(capture.frameId)) schedulePush(capture.frameId);
  }, [adoptFrame, schedulePush]);

  const removeCapture = useCallback((frameId: string) => {
    setCaptures((prev) => prev.filter((entry) => entry.frameId !== frameId));
  }, []);

  const exportCapture = useCallback((capture: SavedCapture): string =>
    JSON.stringify(capture, null, 2), []);

  const exportAllCaptures = useCallback((): string => {
    const file: CapturesFile = { format: 'packet-lab-captures', version: 1, captures };
    return JSON.stringify(file, null, 2);
  }, [captures]);

  const importFile = useCallback(async (text: string, loadFirst: boolean): Promise<ImportResult> => {
    const parsed = JSON.parse(text) as Partial<SavedCapture> & Partial<CapturesFile>;
    const incoming: SavedCapture[] = parsed.format === 'packet-lab-captures'
      ? (parsed.captures ?? [])
      : parsed.format === 'packet-lab-capture'
        ? [parsed as SavedCapture]
        : [];
    if (!incoming.length) throw new Error('文件不是有效的 packet-lab 捕获导出');

    // Validate first; compute counts synchronously (state updaters must stay
    // pure and may run more than once, so never count inside them).
    const valid = incoming.filter((capture) => capture.packet && Array.isArray(capture.markers));
    const result: ImportResult = {
      imported: valid.length,
      skipped: incoming.length - valid.length
    };

    if (valid.length) {
      const merged = new Map(capturesRef.current.map((entry) => [entry.frameId, entry]));
      for (const capture of valid) {
        merged.set(capture.frameId, capture);
        setCache((prev) => ({ ...prev, [capture.frameId]: capture.markers }));
      }
      setCaptures(Array.from(merged.values()));
    }

    // Imported frames are filed verbatim and only shown after strict
    // resolution, so they never misattach to other content.
    if (loadFirst && valid[0]?.packet) {
      adoptFrame(valid[0].packet, { markers: valid[0].markers });
      result.loadedFrameId = valid[0].frameId;
    }
    return result;
  }, [adoptFrame]);

  const resolveActive = useCallback((marker: PacketMarker) =>
    activePacket ? resolveAnchor(marker.anchor, activePacket) : { status: 'detached' as const, reason: '无活动帧' },
    [activePacket]
  );

  return {
    activePacket,
    activeFrameId,
    markers,
    captures,
    saveStatus,
    lastError,
    failMarkers,
    migration,
    adoptFrame,
    replaceActiveFrame,
    dismissMigration,
    addFieldMarker,
    addByteMarker,
    updateMarker,
    deleteMarker,
    saveCapture,
    loadCapture,
    removeCapture,
    exportCapture,
    exportAllCaptures,
    importFile,
    resolveActive,
    retryPending,
    setFailMarkers
  };
}

export type AnnotationsApi = ReturnType<typeof useAnnotations>;
