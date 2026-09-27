import type {
  MarkerBundle,
  PacketScenario,
  ParseRequest,
  Protocol,
  SimulatedPacket
} from '../../shared/types';

const viteBase = (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE;
const API_BASE =
  viteBase
  ?? (globalThis as { __PACKET_LAB_API_BASE__?: string }).__PACKET_LAB_API_BASE__
  ?? 'http://localhost:3001';

export interface ApiOptions {
  failMarkers?: boolean;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) throw new Error(`API 请求失败：${response.status}`);
  return (await response.json()) as T;
}

export function fetchSample(protocol: Protocol, scenario: PacketScenario, signal?: AbortSignal) {
  return requestJson<{ data: SimulatedPacket }>(
    `/api/simulate?protocol=${protocol}&scenario=${scenario}`,
    { signal }
  );
}

export function parsePacket(body: ParseRequest, signal?: AbortSignal) {
  return requestJson<{ data: SimulatedPacket }>('/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
}

export async function fetchMarkers(frameId: string, options: ApiOptions = {}): Promise<MarkerBundle> {
  const response = await fetch(`${API_BASE}/api/markers?frameId=${encodeURIComponent(frameId)}`, {
    headers: options.failMarkers ? { 'X-Fail-Markers': '1' } : undefined
  });
  if (!response.ok) throw new Error(`标记同步失败：${response.status}`);
  const payload = (await response.json()) as { data: MarkerBundle };
  return payload.data;
}

export async function putMarkers(bundle: MarkerBundle, options: ApiOptions = {}): Promise<MarkerBundle> {
  const response = await fetch(`${API_BASE}/api/markers/${encodeURIComponent(bundle.frameId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(options.failMarkers ? { 'X-Fail-Markers': '1' } : undefined)
    },
    body: JSON.stringify({ markers: bundle.markers })
  });
  if (!response.ok) throw new Error(`标记同步失败：${response.status}`);
  const payload = (await response.json()) as { data: MarkerBundle };
  return payload.data;
}
