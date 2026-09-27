import type {
  AnchorResolution,
  ByteAnchor,
  ByteRange,
  FieldAnchor,
  MarkerAnchor,
  PacketMarker,
  Protocol,
  ProtocolField,
  SimulatedPacket
} from './types.js';

/* ------------------------------------------------------------------ */
/* Frame identity                                                     */
/* ------------------------------------------------------------------ */

/** Small deterministic FNV-1a hash so the same packet always maps to the same frameId. */
export function hashContent(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function frameIdFor(protocol: Protocol, scenario: string, raw: string): string {
  return `${protocol.toLowerCase()}-${scenario}-${hashContent(`${protocol}|${scenario}|${raw}`)}`;
}

/* ------------------------------------------------------------------ */
/* Field tree indexing                                                */
/* ------------------------------------------------------------------ */

export interface IndexedField {
  field: ProtocolField;
  depth: number;
}

export function indexFields(fields: ProtocolField[]): Map<string, IndexedField> {
  const index = new Map<string, IndexedField>();
  const walk = (node: ProtocolField, depth: number) => {
    index.set(node.path, { field: node, depth });
    node.children?.forEach((child) => walk(child, depth + 1));
  };
  fields.forEach((node) => walk(node, 0));
  return index;
}

/** Stable path for the n-th header (0 based), disambiguating duplicate header names. */
export function headerPath(name: string, occurrence: number): string {
  return `http.headers[${JSON.stringify(occurrence === 0 ? name : `${name}#${occurrence + 1}`)}]`;
}

/* ------------------------------------------------------------------ */
/* Byte helpers                                                       */
/* ------------------------------------------------------------------ */

export function toUtf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function bytesInRange(raw: string, range: ByteRange): Uint8Array {
  return toUtf8Bytes(raw).subarray(range.start, range.end);
}

export function toHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
}

export function previewFor(raw: string, range: ByteRange): string {
  const bytes = bytesInRange(raw, range);
  return toHex(bytes.slice(0, 8));
}

/* ------------------------------------------------------------------ */
/* Anchor resolution                                                  */
/* ------------------------------------------------------------------ */

export function resolveAnchor(
  anchor: MarkerAnchor,
  packet: SimulatedPacket,
  fieldIndex?: Map<string, IndexedField>
): AnchorResolution {
  const index = fieldIndex ?? indexFields(packet.fields);
  if (anchor.kind === 'field') {
    const entry = index.get(anchor.path);
    if (!entry) return { status: 'detached', reason: '字段路径已不存在（字段被删除或结构变化）' };
    return {
      status: 'attached',
      range: entry.field.byteRange,
      fieldKey: entry.field.key,
      fieldValue: entry.field.value,
      fieldPath: anchor.path
    };
  }
  const total = packet.metadata.length;
  if (anchor.start < 0 || anchor.end <= anchor.start || anchor.end > total) {
    return { status: 'detached', reason: '字节范围超出当前帧边界' };
  }
  const current = previewFor(packet.raw, anchor);
  if (current !== anchor.hexPreview) {
    return { status: 'detached', reason: '该字节范围的内容已改变' };
  }
  return { status: 'attached', range: { start: anchor.start, end: anchor.end } };
}

/**
 * Re-target a marker created against one frame onto a freshly parsed packet.
 *
 * Field markers move only when their semantic path still exists.
 * Byte markers move only when the range is in bounds AND the covered bytes
 * are byte-identical. Everything else detaches instead of being misattached.
 */
export function migrateMarker(
  marker: PacketMarker,
  target: SimulatedPacket
): { marker: PacketMarker; resolution: AnchorResolution } | null {
  const index = indexFields(target.fields);
  const resolution = resolveAnchor(marker.anchor, target, index);
  if (resolution.status !== 'attached') return null;

  let anchor: MarkerAnchor;
  if (marker.anchor.kind === 'field') {
    const entry = index.get(marker.anchor.path)!;
    anchor = { kind: 'field', path: marker.anchor.path, label: entry.field.key } satisfies FieldAnchor;
  } else {
    anchor = { ...(marker.anchor as ByteAnchor) };
  }
  return {
    marker: { ...marker, frameId: target.frameId, anchor },
    resolution
  };
}

export function makeFieldAnchor(field: ProtocolField): FieldAnchor {
  return { kind: 'field', path: field.path, label: field.key };
}

export function makeByteAnchor(raw: string, range: ByteRange, label?: string): ByteAnchor {
  return {
    kind: 'bytes',
    start: range.start,
    end: range.end,
    hexPreview: previewFor(raw, range),
    label: label ?? `bytes ${range.start}–${range.end}`
  };
}

/* ------------------------------------------------------------------ */
/* Validation (shared by the API and the importer)                    */
/* ------------------------------------------------------------------ */

export function isValidColor(color: unknown): boolean {
  return color === 'cyan' || color === 'amber' || color === 'rose' || color === 'green' || color === 'violet';
}

export function sanitizeMarker(value: unknown, frameId: string): PacketMarker | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !candidate.id) return null;
  if (!isValidColor(candidate.color)) return null;
  if (typeof candidate.note !== 'string') return null;
  const anchor = candidate.anchor as Record<string, unknown> | undefined;
  if (!anchor) return null;
  const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date(0).toISOString();
  const updatedAt = typeof candidate.updatedAt === 'string' ? candidate.updatedAt : createdAt;
  if (anchor.kind === 'field') {
    if (typeof anchor.path !== 'string' || !anchor.path) return null;
    return {
      id: candidate.id,
      frameId,
      anchor: { kind: 'field', path: anchor.path, label: typeof anchor.label === 'string' ? anchor.label : anchor.path },
      color: candidate.color as PacketMarker['color'],
      note: candidate.note,
      createdAt,
      updatedAt
    };
  }
  if (anchor.kind === 'bytes') {
    const start = Number(anchor.start);
    const end = Number(anchor.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
    return {
      id: candidate.id,
      frameId,
      anchor: {
        kind: 'bytes',
        start,
        end,
        hexPreview: typeof anchor.hexPreview === 'string' ? anchor.hexPreview : '',
        label: typeof anchor.label === 'string' ? anchor.label : `bytes ${start}–${end}`
      },
      color: candidate.color as PacketMarker['color'],
      note: candidate.note,
      createdAt,
      updatedAt
    };
  }
  return null;
}
