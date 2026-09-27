export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';

export interface HexRow {
  offset: string;
  bytes: string[];
  ascii: string;
}

/** Byte range inside the raw frame, expressed in UTF-8 byte offsets. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface ProtocolField {
  id: string;
  key: string;
  value: string;
  description: string;
  /**
   * Stable semantic path, e.g. `http.headers["Content-Type"]` or `tcp.seq`.
   * Survives re-ordering; a marker detaches when the path no longer resolves.
   */
  path: string;
  /** Physical bytes of this field inside the raw frame, when they exist. */
  byteRange?: ByteRange;
  children?: ProtocolField[];
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  label: string;
  phase: 'ingress' | 'parse' | 'transport' | 'application' | 'egress';
  detail: string;
}

export interface SimulatedPacket {
  id: string;
  /** Deterministic content-derived identity, used to key persisted annotations. */
  frameId: string;
  protocol: Protocol;
  scenario: PacketScenario;
  summary: string;
  raw: string;
  hex: HexRow[];
  fields: ProtocolField[];
  timeline: TimelineEvent[];
  metadata: {
    capturedAt: string;
    source: string;
    destination: string;
    length: number;
    checksum: string;
  };
}

export interface ParseRequest {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
}

/* ------------------------------------------------------------------ */
/* Annotations & bookmarks                                            */
/* ------------------------------------------------------------------ */

export type MarkerColor = 'cyan' | 'amber' | 'rose' | 'green' | 'violet';

export const MARKER_COLORS: MarkerColor[] = ['cyan', 'amber', 'rose', 'green', 'violet'];

/** Anchor attached to a node of the protocol field tree. */
export interface FieldAnchor {
  kind: 'field';
  /** Stable semantic path into SimulatedPacket.fields. */
  path: string;
  /** Human-readable key captured at creation time (shown when detached). */
  label: string;
}

/** Anchor attached to a span of raw bytes (payload byte or hex row). */
export interface ByteAnchor {
  kind: 'bytes';
  start: number;
  end: number;
  /** Hex of the referenced bytes at creation time; guards re-attachment. */
  hexPreview: string;
  label: string;
}

export type MarkerAnchor = FieldAnchor | ByteAnchor;

export interface PacketMarker {
  id: string;
  frameId: string;
  anchor: MarkerAnchor;
  color: MarkerColor;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarkerBundle {
  frameId: string;
  markers: PacketMarker[];
}

export interface PutMarkersRequest {
  markers: PacketMarker[];
}

/** A captured frame bundled with its annotations, used for save/export. */
export interface SavedCapture {
  format: 'packet-lab-capture';
  version: 1;
  frameId: string;
  packet: SimulatedPacket;
  markers: PacketMarker[];
  savedAt: string;
  label: string;
}

export interface CapturesFile {
  format: 'packet-lab-captures';
  version: 1;
  captures: SavedCapture[];
}

export type AnchorResolution =
  | { status: 'attached'; range?: ByteRange; fieldKey?: string; fieldValue?: string; fieldPath?: string }
  | { status: 'detached'; reason: string };
