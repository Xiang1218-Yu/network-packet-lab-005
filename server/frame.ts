import type {
  ByteRange,
  HexRow,
  PacketScenario,
  Protocol,
  ProtocolField,
  SimulatedPacket,
  TimelineEvent
} from '../shared/types.js';
import { frameIdFor, headerPath } from '../shared/markers.js';

const HTTP_SAMPLES: Record<PacketScenario, string> = {
  request: 'GET /api/devices?status=online HTTP/1.1\r\nHost: lab.local\r\nAccept: application/json\r\nUser-Agent: PacketLab/1.0\r\nX-Trace-Id: 7f3a9c\r\n\r\n',
  response: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 47\r\nCache-Control: no-store\r\n\r\n{"devices":[{"id":"edge-01","status":"online"}]}',
  handshake: 'GET / HTTP/1.1\r\nHost: lab.local\r\nConnection: keep-alive\r\n\r\n'
};

const TCP_SAMPLES: Record<PacketScenario, string> = {
  request: 'TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=18492031 Ack=77120102 | Flags=ACK,PSH | Win=64240 | Len=128',
  response: 'TCP 10.0.0.8:443 > 10.0.0.24:51842 | Seq=77120102 Ack=18492159 | Flags=ACK,PSH | Win=28960 | Len=512',
  handshake: 'TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=0 Ack=0 | Flags=SYN | Win=64240 | MSS=1460 | WS=7'
};

/* ------------------------------------------------------------------ */
/* Byte-level scanning helpers                                        */
/* ------------------------------------------------------------------ */

interface Span { start: number; end: number; text: string }

function splitLines(buffer: Buffer, limit: number): Span[] {
  const lines: Span[] = [];
  let lineStart = 0;
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0x0a) {
      let end = index;
      if (end > lineStart && buffer[end - 1] === 0x0d) end -= 1;
      lines.push({ start: lineStart, end, text: buffer.toString('utf8', lineStart, end) });
      lineStart = index + 1;
    }
  }
  if (lineStart < limit) lines.push({ start: lineStart, end: limit, text: buffer.toString('utf8', lineStart, limit) });
  return lines;
}

function tokenSpans(buffer: Buffer, start: number, end: number): Span[] {
  const spans: Span[] = [];
  let tokenStart = -1;
  for (let index = start; index <= end; index += 1) {
    const isSpace = index < end && (buffer[index] === 0x20 || buffer[index] === 0x09);
    if (!isSpace && tokenStart === -1) tokenStart = index;
    if ((isSpace || index === end) && tokenStart !== -1) {
      spans.push({ start: tokenStart, end: index, text: buffer.toString('utf8', tokenStart, index) });
      tokenStart = -1;
    }
  }
  return spans;
}

function indexOfAscii(haystack: Buffer, needle: string, from = 0): number {
  const first = needle.charCodeAt(0);
  outer: for (let index = from; index <= haystack.length - needle.length; index += 1) {
    if (haystack[index] !== first) continue;
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle.charCodeAt(offset)) continue outer;
    }
    return index;
  }
  return -1;}

function indexOfByte(haystack: Buffer, byte: number, start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (haystack[index] === byte) return index;
  }
  return -1;
}

function trimSpan(buffer: Buffer, start: number, end: number): ByteRange {
  let nextStart = start;
  let nextEnd = end;
  while (nextStart < nextEnd && (buffer[nextStart] === 0x20 || buffer[nextStart] === 0x09)) nextStart += 1;
  while (nextEnd > nextStart && (buffer[nextEnd - 1] === 0x20 || buffer[nextEnd - 1] === 0x09)) nextEnd -= 1;
  return { start: nextStart, end: nextEnd };
}

function rangeOf(span: Pick<Span, 'start' | 'end'>): ByteRange {
  return { start: span.start, end: span.end };
}

function field(
  id: string,
  key: string,
  value: string,
  description: string,
  path: string,
  byteRange?: ByteRange,
  children?: ProtocolField[]
): ProtocolField {
  return {
    id,
    key,
    value,
    description,
    path,
    ...(byteRange ? { byteRange } : {}),
    ...(children ? { children } : {})
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

function parseHttpFields(raw: string): ProtocolField[] {
  const buffer = Buffer.from(raw, 'utf8');
  const crlfAt = indexOfAscii(buffer, '\r\n\r\n');
  const lfAt = (() => {
    for (let index = 0; index < buffer.length - 1; index += 1) {
      if (buffer[index] === 0x0a && buffer[index + 1] === 0x0a) return index;
    }
    return -1;
  })();
  let termStart = -1;
  let termLength = 0;
  if (crlfAt !== -1 && (lfAt === -1 || crlfAt <= lfAt)) {
    termStart = crlfAt;
    termLength = 4;
  } else if (lfAt !== -1) {
    termStart = lfAt;
    termLength = 2;
  }
  const headEnd = termStart === -1 ? buffer.length : termStart;
  const lines = splitLines(buffer, headEnd);
  const startLine = lines[0] ?? { start: 0, end: 0, text: '' };
  const headerLines = lines.slice(1);

  const isResponse = startLine.text.startsWith('HTTP/');
  const tokens = tokenSpans(buffer, startLine.start, startLine.end);
  const [versionToken, codeOrTargetToken, reasonOrVersionToken] = isResponse
    ? [tokens[0], tokens[1], tokens[2]]
    : [tokens[2], tokens[1], tokens[0]];
  const startLineChildren = isResponse
    ? [
        field('http-part-1', 'Version', versionToken?.text ?? '—', 'Protocol version', 'http.startLine.version', versionToken ? rangeOf(versionToken) : undefined),
        field('http-part-2', 'Status', codeOrTargetToken?.text ?? '—', 'Status code', 'http.startLine.status', codeOrTargetToken ? rangeOf(codeOrTargetToken) : undefined),
        field('http-part-3', 'Reason', reasonOrVersionToken?.text ?? '—', 'Reason phrase', 'http.startLine.reason', reasonOrVersionToken ? rangeOf(reasonOrVersionToken) : undefined)
      ]
    : [
        field('http-part-1', 'Method', reasonOrVersionToken?.text ?? '—', 'HTTP request method', 'http.startLine.method', reasonOrVersionToken ? rangeOf(reasonOrVersionToken) : undefined),
        field('http-part-2', 'Target', codeOrTargetToken?.text ?? '—', 'Request target', 'http.startLine.target', codeOrTargetToken ? rangeOf(codeOrTargetToken) : undefined),
        field('http-part-3', 'Version', versionToken?.text ?? '—', 'Protocol version', 'http.startLine.version', versionToken ? rangeOf(versionToken) : undefined)
      ];

  const seenNames = new Map<string, number>();
  const headerChildren = headerLines.map((line, index) => {
    const colonRel = indexOfByte(buffer, 0x3a, line.start, line.end);
    const colon = colonRel;
    let key = `Header-${index + 1}`;
    let valueRange: ByteRange | undefined;
    if (colon !== -1 && colon < line.end) {
      key = buffer.toString('utf8', line.start, colon).trim();
      valueRange = trimSpan(buffer, colon + 1, line.end);
    }
    const lower = key.toLowerCase();
    const occurrence = seenNames.get(lower) ?? 0;
    seenNames.set(lower, occurrence + 1);
    const value = valueRange ? buffer.toString('utf8', valueRange.start, valueRange.end) : line.text.trim();
    return field(
      `header-${index}`,
      key,
      value || '(empty)',
      'HTTP header field',
      headerPath(key, occurrence),
      valueRange ?? rangeOf(line)
    );
  });

  const headersRange: ByteRange | undefined = headerLines.length
    ? { start: headerLines[0].start, end: headerLines[headerLines.length - 1].end }
    : undefined;
  const bodyRange: ByteRange | undefined = termStart === -1
    ? undefined
    : { start: termStart + termLength, end: buffer.length };

  return [
    field(
      'http-start-line',
      isResponse ? 'Status-Line' : 'Request-Line',
      startLine.text,
      isResponse ? 'HTTP version and response status' : 'HTTP method, target and version',
      'http.startLine',
      rangeOf(startLine),
      startLineChildren
    ),
    field('http-headers', 'Headers', `${headerChildren.length} fields`, 'Metadata carried by the application layer', 'http.headers', headersRange, headerChildren),
    field(
      'http-body',
      'Payload',
      bodyRange && bodyRange.end > bodyRange.start ? buffer.toString('utf8', bodyRange.start, bodyRange.end) : '(empty)',
      'Application payload after the header terminator',
      'http.payload',
      bodyRange && bodyRange.end > bodyRange.start ? bodyRange : undefined
    )
  ];
}

/* ------------------------------------------------------------------ */
/* TCP                                                                */
/* ------------------------------------------------------------------ */

function parseTcpFields(raw: string): ProtocolField[] {
  const buffer = Buffer.from(raw, 'utf8');
  const separatorAt = indexOfAscii(buffer, ' | ');
  const routeEnd = separatorAt === -1 ? buffer.length : separatorAt;
  const routeTokens = tokenSpans(buffer, 0, routeEnd);
  const sourceToken = routeTokens[1];
  const destinationToken = routeTokens[3];
  const protocolToken = routeTokens[0];

  const partValues = new Map<string, string>();
  const partRanges = new Map<string, ByteRange>();
  if (separatorAt !== -1) {
    // Each `|`-delimited segment may carry several space-separated key=value
    // tokens, e.g. the route segment "Seq=0 Ack=0". Scan token by token so the
    // byte ranges always point at the real value only.
    let tokenStart = -1;
    const scanStart = separatorAt + 3;
    for (let index = scanStart; index <= buffer.length; index += 1) {
      const isEnd = index === buffer.length;
      const byte = isEnd ? 0x20 : buffer[index];
      const atPipeSpace = !isEnd && index + 2 < buffer.length
        && byte === 0x20 && buffer[index + 1] === 0x7c && buffer[index + 2] === 0x20;
      const isBoundary = isEnd || byte === 0x20 || byte === 0x09;
      if (isBoundary) {
        if (tokenStart !== -1) {
          const equalsRel = indexOfByte(buffer, 0x3d, tokenStart, index);
          if (equalsRel !== -1) {
            const key = buffer.toString('utf8', tokenStart, equalsRel).trim();
            const valueRange = trimSpan(buffer, equalsRel + 1, index);
            partValues.set(key, buffer.toString('utf8', valueRange.start, valueRange.end));
            partRanges.set(key, valueRange);
          }
          tokenStart = -1;
        }
        if (atPipeSpace) index += 2;
      } else if (tokenStart === -1) {
        tokenStart = index;
      }
    }
  }

  return [
    field('ethernet', 'Link Layer', 'Ethernet II', 'Frame envelope', 'ethernet', undefined, [
      field('ethernet-src', 'Source MAC', '02:42:ac:11:00:24', 'Simulated interface address', 'ethernet.src'),
      field('ethernet-dst', 'Destination MAC', '02:42:ac:11:00:08', 'Simulated gateway address', 'ethernet.dst'),
      field('ethernet-type', 'Type', '0x0800 · IPv4', 'Network protocol identifier', 'ethernet.type')
    ]),
    field('ipv4', 'Internet Layer', 'IPv4', 'Logical addressing and delivery', 'ipv4', undefined, [
      field('ipv4-source', 'Source', sourceToken?.text ?? '—', 'Origin IP and port', 'ipv4.source', sourceToken ? rangeOf(sourceToken) : undefined),
      field('ipv4-destination', 'Destination', destinationToken?.text ?? '—', 'Target IP and port', 'ipv4.destination', destinationToken ? rangeOf(destinationToken) : undefined),
      field('ipv4-protocol', 'Next Protocol', protocolToken?.text ?? 'TCP', 'Transport protocol', 'ipv4.protocol', protocolToken ? rangeOf(protocolToken) : undefined)
    ]),
    field('tcp', 'Transport Layer', 'TCP', 'Reliable stream transport', 'tcp', undefined, [
      field('tcp-seq', 'Sequence', partValues.get('Seq') ?? '—', 'Byte sequence position', 'tcp.seq', partRanges.get('Seq')),
      field('tcp-ack', 'Acknowledgement', partValues.get('Ack') ?? '—', 'Next expected byte', 'tcp.ack', partRanges.get('Ack')),
      field('tcp-flags', 'Flags', partValues.get('Flags') ?? '—', 'Control bits', 'tcp.flags', partRanges.get('Flags')),
      field('tcp-window', 'Window', partValues.get('Win') ?? '—', 'Receive window size', 'tcp.window', partRanges.get('Win')),
      field('tcp-length', 'Payload Length', partValues.get('Len') ?? '0', 'TCP segment data length', 'tcp.length', partRanges.get('Len'))
    ]),
    field('tcp-payload', 'Payload', partValues.get('Len') === '0' ? '(empty)' : 'Encrypted application data', 'Data carried by the segment', 'tcp.payload')
  ];
}

/* ------------------------------------------------------------------ */
/* Frame assembly                                                     */
/* ------------------------------------------------------------------ */

function hexDump(value: string): HexRow[] {
  const bytes = Array.from(Buffer.from(value, 'utf8'));
  const rows: HexRow[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const slice = bytes.slice(index, index + 16);
    rows.push({
      offset: index.toString(16).padStart(4, '0'),
      bytes: slice.map((byte) => byte.toString(16).padStart(2, '0')),
      ascii: slice.map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('')
    });
  }
  return rows;
}

function timelineFor(protocol: Protocol, scenario: PacketScenario): TimelineEvent[] {
  const prefix = protocol === 'HTTP' ? 'HTTP' : 'TCP';
  const steps = protocol === 'HTTP'
    ? [
        ['ingress', 'Frame captured', 'NIC received an application frame'],
        ['parse', 'Headers indexed', 'Start line and header fields identified'],
        ['application', `${prefix} payload decoded`, scenario === 'response' ? 'Response body is ready for inspection' : 'Request target and metadata extracted'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ]
    : [
        ['ingress', 'Segment captured', 'Transport segment received from the simulated wire'],
        ['transport', 'TCP header decoded', 'Sequence, acknowledgement and flags extracted'],
        ['parse', 'Layer tree assembled', 'Ethernet → IPv4 → TCP hierarchy created'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ];
  return steps.map(([phase, label, detail], index) => ({
    id: `${prefix.toLowerCase()}-${index}`,
    timestamp: `00:00:0${index}.${(index * 37 + 12).toString().padStart(2, '0')}`,
    label,
    phase: phase as TimelineEvent['phase'],
    detail
  }));
}

function checksum(raw: string): string {
  let hash = 0;
  for (const byte of Buffer.from(raw, 'utf8')) hash = (hash + byte * 31) % 65535;
  return `0x${hash.toString(16).padStart(4, '0').toUpperCase()}`;
}

export function buildPacket(protocol: Protocol, scenario: PacketScenario, raw: string): SimulatedPacket {
  const safeRaw = raw.trim() ? raw : (protocol === 'HTTP' ? HTTP_SAMPLES[scenario] : TCP_SAMPLES[scenario]);
  const isHttp = protocol === 'HTTP';
  const frameId = frameIdFor(protocol, scenario, safeRaw);
  return {
    id: frameId,
    frameId,
    protocol,
    scenario,
    summary: isHttp
      ? `${safeRaw.split(/\r?\n/)[0]} · ${scenario === 'response' ? 'server response' : 'client request'}`
      : `${scenario === 'handshake' ? 'TCP connection handshake' : 'TCP data segment'} · ${safeRaw.split(' | ')[0]}`,
    raw: safeRaw,
    hex: hexDump(safeRaw),
    fields: isHttp ? parseHttpFields(safeRaw) : parseTcpFields(safeRaw),
    timeline: timelineFor(protocol, scenario),
    metadata: {
      capturedAt: new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'),
      source: isHttp ? '10.0.0.24:51842' : safeRaw.split(' > ')[0].replace('TCP ', ''),
      destination: isHttp ? '10.0.0.8:443' : (safeRaw.split(' > ')[1]?.split(' | ')[0] ?? '10.0.0.8:443'),
      length: Buffer.byteLength(safeRaw, 'utf8'),
      checksum: checksum(safeRaw)
    }
  };
}

export { HTTP_SAMPLES, TCP_SAMPLES };
