export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';

export interface HexRow {
  offset: string;
  bytes: string[];
  ascii: string;
}

export interface ProtocolField {
  id: string;
  key: string;
  value: string;
  description: string;
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

export type MarkerColor = 'teal' | 'amber' | 'rose' | 'violet' | 'sky';

export interface FieldAnchor {
  kind: 'field';
  /** Field ids from the root of the tree down to the marked field. */
  path: string[];
  /** Content fingerprints: prove the anchor still points at the same field. */
  fieldKey: string;
  fieldValue: string;
}

export interface ByteAnchor {
  kind: 'bytes';
  /** Inclusive byte offset into the packet raw payload (UTF-8). */
  start: number;
  /** Exclusive byte offset. */
  end: number;
  /** Printable sample of the covered bytes, used to detect content changes. */
  sample: string;
}

export type MarkerAnchor = FieldAnchor | ByteAnchor;

export interface FieldMarker {
  id: string;
  anchor: MarkerAnchor;
  color: MarkerColor;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureFrame {
  id: string;
  savedAt: string;
  updatedAt: string;
  packet: SimulatedPacket;
  markers: FieldMarker[];
}

export interface CaptureSummary {
  id: string;
  savedAt: string;
  updatedAt: string;
  protocol: Protocol;
  scenario: PacketScenario;
  summary: string;
  length: number;
  markerCount: number;
}

export interface SaveCaptureRequest {
  packet: SimulatedPacket;
  markers: FieldMarker[];
}

export interface UpdateMarkersRequest {
  markers: FieldMarker[];
}
