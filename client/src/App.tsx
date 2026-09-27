import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type {
  ByteAnchor,
  CaptureFrame,
  CaptureSummary,
  FieldAnchor,
  FieldMarker,
  MarkerAnchor,
  MarkerColor,
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  SimulatedPacket,
  TimelineEvent
} from '../../shared/types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

const MARKER_COLORS: MarkerColor[] = ['teal', 'amber', 'rose', 'violet', 'sky'];

const markerColorLabels: Record<MarkerColor, string> = {
  teal: '青',
  amber: '橙',
  rose: '红',
  violet: '紫',
  sky: '蓝'
};

type SyncState = 'clean' | 'dirty' | 'saving' | 'error';

interface MarkerDraft {
  markerId?: string;
  anchor: MarkerAnchor;
  color: MarkerColor;
  note: string;
}

/* ------------------------------------------------------------------ */
/* Anchor helpers: markers follow real field paths / byte ranges,      */
/* and content fingerprints prove they still point at the same data.   */
/* ------------------------------------------------------------------ */

const textEncoder = new TextEncoder();

function findFieldPath(fields: ProtocolField[], targetId: string, trail: string[] = []): string[] | null {
  for (const field of fields) {
    const path = [...trail, field.id];
    if (field.id === targetId) return path;
    const found = field.children ? findFieldPath(field.children, targetId, path) : null;
    if (found) return found;
  }
  return null;
}

function fieldByPath(fields: ProtocolField[], path: string[]): ProtocolField | null {
  let level = fields;
  let node: ProtocolField | undefined;
  for (const id of path) {
    node = level.find((field) => field.id === id);
    if (!node) return null;
    level = node.children ?? [];
  }
  return node ?? null;
}

function resolveFieldAnchor(fields: ProtocolField[], anchor: FieldAnchor): ProtocolField | null {
  const node = fieldByPath(fields, anchor.path);
  if (!node) return null;
  return node.key === anchor.fieldKey && node.value === anchor.fieldValue ? node : null;
}

function byteSample(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('');
}

function resolveByteAnchor(raw: string, anchor: ByteAnchor): boolean {
  const bytes = textEncoder.encode(raw);
  if (anchor.start < 0 || anchor.end > bytes.length || anchor.start >= anchor.end) return false;
  return byteSample(bytes.slice(anchor.start, anchor.end)) === anchor.sample;
}

function markerIsActive(packet: SimulatedPacket | null, marker: FieldMarker): boolean {
  if (!packet) return false;
  return marker.anchor.kind === 'field'
    ? resolveFieldAnchor(packet.fields, marker.anchor) !== null
    : resolveByteAnchor(packet.raw, marker.anchor);
}

function fieldAnchorLabel(fields: ProtocolField[], anchor: FieldAnchor): string {
  const labels: string[] = [];
  let level = fields;
  for (const id of anchor.path) {
    const node = level.find((field) => field.id === id);
    if (!node) break;
    labels.push(node.key);
    level = node.children ?? [];
  }
  return labels.length ? labels.join(' › ') : anchor.fieldKey;
}

function byteAnchorLabel(anchor: ByteAnchor): string {
  const from = anchor.start.toString(16).padStart(4, '0');
  const to = Math.max(anchor.start, anchor.end - 1).toString(16).padStart(4, '0');
  return `字节 0x${from} – 0x${to}`;
}

function newMarkerId(): string {
  return `mk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function App() {
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [scenario, setScenario] = useState<PacketScenario>('request');
  const [rawInput, setRawInput] = useState('');
  const [packet, setPacket] = useState<SimulatedPacket | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<'overview' | 'hex'>('overview');
  const [markers, setMarkers] = useState<FieldMarker[]>([]);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [captures, setCaptures] = useState<CaptureSummary[]>([]);
  const [syncState, setSyncState] = useState<SyncState>('clean');
  const [syncError, setSyncError] = useState('');
  const [savingFrame, setSavingFrame] = useState(false);
  const [draft, setDraft] = useState<MarkerDraft | null>(null);

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${API_BASE}${path}`, init);
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  };

  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  /** Switching to another simulated frame starts a fresh annotation context. */
  const adoptFreshPacket = (next: SimulatedPacket) => {
    setPacket(next);
    setRawInput(next.raw);
    setMarkers([]);
    setCaptureId(null);
    setSyncState('clean');
    setSyncError('');
  };

  const loadSample = async (nextProtocol = protocol, nextScenario = scenario) => {
    setLoading(true);
    setError('');
    try {
      const result = await request<{ data: SimulatedPacket }>(
        `/api/simulate?protocol=${nextProtocol}&scenario=${nextScenario}`
      );
      adoptFreshPacket(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载模拟数据失败');
    } finally {
      setLoading(false);
    }
  };

  const parsePacket = async () => {
    setLoading(true);
    setError('');
    const body: ParseRequest = { protocol, scenario, raw: rawInput };
    try {
      const result = await request<{ data: SimulatedPacket }>('/api/parse', jsonInit('POST', body));
      // Re-parsing produces a new frame: keep markers whose anchors still
      // resolve against the new content, and surface the rest as stale
      // instead of silently attaching them to the wrong fields.
      setPacket(result.data);
      setRawInput(result.data.raw);
      setCaptureId(null);
      if (markers.length) setSyncState((state) => (state === 'clean' ? 'dirty' : state));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  };

  const refreshCaptures = async () => {
    try {
      const result = await request<{ data: CaptureSummary[] }>('/api/captures');
      setCaptures(result.data);
    } catch {
      // A failing list must never discard local edits; the panel just stays stale.
    }
  };

  useEffect(() => {
    void loadSample('HTTP', 'request');
    void refreshCaptures();
  }, []);

  const changeProtocol = (nextProtocol: Protocol) => {
    const nextScenario = nextProtocol === 'TCP' && scenario === 'response' ? 'handshake' : scenario;
    setProtocol(nextProtocol);
    setScenario(nextScenario);
    void loadSample(nextProtocol, nextScenario);
  };

  const changeScenario = (nextScenario: PacketScenario) => {
    setScenario(nextScenario);
    void loadSample(protocol, nextScenario);
  };

  /* ------------------------- marker editing ------------------------- */

  const syncMarkers = async (next: FieldMarker[], targetCaptureId: string) => {
    setSyncState('saving');
    try {
      await request<{ data: FieldMarker[] }>(`/api/captures/${targetCaptureId}/markers`, jsonInit('PUT', { markers: next }));
      setSyncState('clean');
      setSyncError('');
      void refreshCaptures();
    } catch (cause) {
      // Keep the local edits untouched; the user can retry explicitly.
      setSyncState('error');
      setSyncError(cause instanceof Error ? cause.message : '标记同步失败');
    }
  };

  const commitMarkers = (next: FieldMarker[]) => {
    setMarkers(next);
    if (captureId) void syncMarkers(next, captureId);
    else setSyncState('dirty');
  };

  const openNewMarker = (anchor: MarkerAnchor) => {
    setDraft({ anchor, color: 'amber', note: '' });
  };

  const openEditMarker = (marker: FieldMarker) => {
    setDraft({ markerId: marker.id, anchor: marker.anchor, color: marker.color, note: marker.note });
  };

  const saveDraft = () => {
    if (!draft || !packet) return;
    const now = new Date().toISOString();
    if (draft.markerId) {
      commitMarkers(markers.map((marker) => (marker.id === draft.markerId
        ? { ...marker, color: draft.color, note: draft.note, updatedAt: now }
        : marker)));
    } else {
      commitMarkers([...markers, {
        id: newMarkerId(),
        anchor: draft.anchor,
        color: draft.color,
        note: draft.note,
        createdAt: now,
        updatedAt: now
      }]);
    }
    setDraft(null);
  };

  const deleteMarker = (markerId: string) => {
    commitMarkers(markers.filter((marker) => marker.id !== markerId));
    setDraft((current) => (current?.markerId === markerId ? null : current));
  };

  const markField = (field: ProtocolField) => {
    if (!packet) return;
    const path = findFieldPath(packet.fields, field.id);
    if (!path) return;
    openNewMarker({ kind: 'field', path, fieldKey: field.key, fieldValue: field.value });
  };

  const markHexRow = (row: SimulatedPacket['hex'][number]) => {
    const start = parseInt(row.offset, 16);
    openNewMarker({ kind: 'bytes', start, end: start + row.bytes.length, sample: row.ascii });
  };

  /* --------------------- capture save / load ------------------------ */

  const saveCapture = async () => {
    if (!packet) return;
    setSavingFrame(true);
    setSyncError('');
    try {
      if (captureId) {
        await request<{ data: CaptureFrame }>(`/api/captures/${captureId}`, jsonInit('PUT', { packet, markers }));
      } else {
        const result = await request<{ data: CaptureFrame }>('/api/captures', jsonInit('POST', { packet, markers }));
        setCaptureId(result.data.id);
      }
      setSyncState('clean');
      await refreshCaptures();
    } catch (cause) {
      // The frame and every uncommitted marker edit stay in local state.
      setSyncState('error');
      setSyncError(`保存失败，本地编辑已保留：${cause instanceof Error ? cause.message : '未知错误'}`);
    } finally {
      setSavingFrame(false);
    }
  };

  const retrySync = () => {
    if (captureId) void syncMarkers(markers, captureId);
    else void saveCapture();
  };

  const loadCapture = async (id: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await request<{ data: CaptureFrame }>(`/api/captures/${id}`);
      const capture = result.data;
      setPacket(capture.packet);
      setRawInput(capture.packet.raw);
      setProtocol(capture.packet.protocol);
      setScenario(capture.packet.scenario);
      setMarkers(capture.markers);
      setCaptureId(capture.id);
      setSyncState('clean');
      setSyncError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '载入捕获帧失败');
    } finally {
      setLoading(false);
    }
  };

  const deleteCapture = async (id: string) => {
    try {
      await request<void>(`/api/captures/${id}`, { method: 'DELETE' });
      if (captureId === id) setCaptureId(null);
      await refreshCaptures();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除捕获帧失败');
    }
  };

  const exportCurrent = () => {
    if (!packet) return;
    const payload = { exportedAt: new Date().toISOString(), capture: { packet, markers } };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${captureId ?? packet.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  /* ------------------------- derived state -------------------------- */

  const activeFieldMarkers = useMemo(() => {
    const map = new Map<string, FieldMarker[]>();
    if (!packet) return map;
    for (const marker of markers) {
      if (marker.anchor.kind !== 'field') continue;
      const node = resolveFieldAnchor(packet.fields, marker.anchor);
      if (!node) continue;
      map.set(node.id, [...(map.get(node.id) ?? []), marker]);
    }
    return map;
  }, [markers, packet]);

  const activeByteMarkers = useMemo(
    () => markers.filter((marker) => marker.anchor.kind === 'bytes' && markerIsActive(packet, marker)),
    [markers, packet]
  );

  const staleCount = useMemo(
    () => markers.filter((marker) => !markerIsActive(packet, marker)).length,
    [markers, packet]
  );

  const syncLabels: Record<SyncState, string> = {
    clean: captureId ? `已保存 · ${captureId}` : '已就绪',
    dirty: '有未保存的编辑',
    saving: '同步中…',
    error: syncError || '同步失败，编辑已保留在本地'
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /> <span /> <span /></div>
          <div>
            <p className="eyebrow">PROJECT 10 / PACKET OBSERVATORY</p>
            <h1>网络协议数据包可视化实验室</h1>
          </div>
        </div>
        <div className="connection-status"><i /> API ONLINE <span>localhost:3001</span></div>
      </header>

      <main className="dashboard">
        <section className="hero-copy">
          <div>
            <p className="section-kicker">解析工作台 · INSPECTOR</p>
            <h2>把每一个字节，<em>还原成可读的网络故事。</em></h2>
            <p className="hero-subtitle">选择协议和场景，载入模拟流量，逐层查看字段、时间线与十六进制原始数据，并用彩色标记记录值得关注的字段。</p>
          </div>
          <div className="hero-stat"><strong>{packet?.metadata.length ?? '—'}</strong><span>BYTES<br />CURRENT FRAME</span></div>
        </section>

        <section className="control-panel panel">
          <div className="control-group">
            <label>协议 <span>PROTOCOL</span></label>
            <div className="segmented-control">
              {(['HTTP', 'TCP'] as Protocol[]).map((item) => (
                <button key={item} className={protocol === item ? 'active' : ''} onClick={() => changeProtocol(item)}>{item}</button>
              ))}
            </div>
          </div>
          <div className="control-group scenario-control">
            <label>模拟场景 <span>SCENARIO</span></label>
            <select value={scenario} onChange={(event) => changeScenario(event.target.value as PacketScenario)}>
              {availableScenarios.map((item) => <option key={item} value={item}>{scenarioLabels[item]}</option>)}
            </select>
          </div>
          <div className="control-actions">
            <button className="button ghost" onClick={() => void loadSample()} disabled={loading}>↻ 载入模拟包</button>
            <button className="button primary" onClick={() => void parsePacket()} disabled={loading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          </div>
        </section>

        {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}

        <section className="workspace-grid">
          <div className="left-column">
            <div className="panel packet-input-panel">
              <div className="panel-heading"><div><p className="section-kicker">01 / INPUT STREAM</p><h3>数据包输入</h3></div><span className="badge">{protocol}</span></div>
              <textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始数据包输入" />
              <div className="input-footer"><span>{rawInput.length} chars · editable payload</span><button onClick={() => setRawInput('')}>清空输入</button></div>
            </div>
            <div className="panel timeline-panel">
              <div className="panel-heading"><div><p className="section-kicker">02 / EVENT TRACE</p><h3>传输时间线</h3></div><span className="trace-id">{packet?.id ?? 'WAITING'}</span></div>
              <Timeline events={packet?.timeline ?? []} />
            </div>
            <div className="panel captures-panel">
              <div className="panel-heading">
                <div><p className="section-kicker">03 / SAVED FRAMES</p><h3>已保存捕获帧</h3></div>
                <button className="icon-button" onClick={() => void refreshCaptures()} title="刷新列表">↻</button>
              </div>
              {captures.length === 0
                ? <div className="empty-state">还没有保存的捕获帧。保存后，标记会随帧一起持久化。</div>
                : <div className="capture-list">{captures.map((capture) => (
                    <div className="capture-item" key={capture.id}>
                      <div className="capture-meta">
                        <strong>{capture.summary}</strong>
                        <span>{capture.protocol} · {scenarioLabels[capture.scenario]} · {capture.markerCount} 个标记 · {capture.savedAt.replace('T', ' ').slice(0, 19)}</span>
                      </div>
                      <div className="capture-actions">
                        <button onClick={() => void loadCapture(capture.id)}>载入</button>
                        <a href={`${API_BASE}/api/captures/${capture.id}/export`} download>导出</a>
                        <button className="danger" onClick={() => void deleteCapture(capture.id)}>删除</button>
                      </div>
                    </div>
                  ))}</div>}
            </div>
          </div>

          <div className="right-column">
            <div className="panel packet-summary">
              <div className="summary-top"><div><p className="section-kicker">ACTIVE FRAME</p><h3>{packet?.summary ?? '等待数据包'}</h3></div><div className="live-chip"><i /> DECODED</div></div>
              <div className="metadata-grid">
                <Meta label="SOURCE" value={packet?.metadata.source ?? '—'} />
                <Meta label="DESTINATION" value={packet?.metadata.destination ?? '—'} />
                <Meta label="CAPTURED AT" value={packet?.metadata.capturedAt ?? '—'} />
                <Meta label="CHECKSUM" value={packet?.metadata.checksum ?? '—'} />
              </div>
              <div className="frame-actions">
                <button className="button primary" onClick={() => void saveCapture()} disabled={!packet || savingFrame}>
                  {savingFrame ? '保存中…' : captureId ? '更新捕获帧' : '保存捕获帧'}
                </button>
                <button className="button ghost" onClick={exportCurrent} disabled={!packet}>导出 JSON</button>
                <span className={`sync-status sync-${syncState}`}>
                  {syncLabels[syncState]}
                  {syncState === 'error' && <button onClick={retrySync}>重试</button>}
                </span>
              </div>
            </div>

            <div className="panel details-panel">
              <div className="tabs"><button className={activeView === 'overview' ? 'selected' : ''} onClick={() => setActiveView('overview')}>协议字段树</button><button className={activeView === 'hex' ? 'selected' : ''} onClick={() => setActiveView('hex')}>十六进制视图</button></div>
              {activeView === 'overview'
                ? <FieldTree fields={packet?.fields ?? []} markersByField={activeFieldMarkers} onMarkField={markField} onEditMarker={openEditMarker} />
                : <HexView rows={packet?.hex ?? []} markers={activeByteMarkers} onMarkRow={markHexRow} onEditMarker={openEditMarker} />}
              <MarkerPanel
                markers={markers}
                packet={packet}
                staleCount={staleCount}
                onEdit={openEditMarker}
                onDelete={deleteMarker}
              />
            </div>
          </div>
        </section>
      </main>

      {draft && (
        <div className="marker-editor-backdrop" onClick={() => setDraft(null)}>
          <div className="marker-editor" onClick={(event) => event.stopPropagation()}>
            <p className="section-kicker">{draft.markerId ? '编辑标记 / EDIT MARKER' : '新建标记 / NEW MARKER'}</p>
            <h4 className="marker-anchor-label">
              {draft.anchor.kind === 'field'
                ? `字段 · ${packet ? fieldAnchorLabel(packet.fields, draft.anchor) : draft.anchor.fieldKey}`
                : `${byteAnchorLabel(draft.anchor)} · “${draft.anchor.sample}”`}
            </h4>
            <div className="color-swatches">
              {MARKER_COLORS.map((color) => (
                <button
                  key={color}
                  className={`swatch swatch-${color} ${draft.color === color ? 'selected' : ''}`}
                  title={markerColorLabels[color]}
                  onClick={() => setDraft({ ...draft, color })}
                />
              ))}
            </div>
            <textarea
              value={draft.note}
              placeholder="这里为什么值得关注…"
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              aria-label="标记注释"
            />
            <div className="editor-actions">
              <button className="button ghost" onClick={() => setDraft(null)}>取消</button>
              {draft.markerId && <button className="button danger" onClick={() => deleteMarker(draft.markerId!)}>删除标记</button>}
              <button className="button primary" onClick={saveDraft}>保存标记</button>
            </div>
          </div>
        </div>
      )}

      <footer className="footer"><span>PACKET LAB / EDUCATIONAL SIMULATOR</span><span>React + Vite + TypeScript · Express API</span></footer>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="meta-item"><span>{label}</span><strong>{value}</strong></div>;
}

interface FieldTreeProps {
  fields: ProtocolField[];
  markersByField: Map<string, FieldMarker[]>;
  onMarkField: (field: ProtocolField) => void;
  onEditMarker: (marker: FieldMarker) => void;
}

function FieldTree({ fields, markersByField, onMarkField, onEditMarker }: FieldTreeProps) {
  if (!fields.length) return <div className="empty-state">解析后将在这里显示协议层级字段。</div>;
  return <div className="field-tree">{fields.map((field) => (
    <FieldNode key={field.id} field={field} depth={0} markersByField={markersByField} onMarkField={onMarkField} onEditMarker={onEditMarker} />
  ))}</div>;
}

interface FieldNodeProps {
  field: ProtocolField;
  depth: number;
  markersByField: Map<string, FieldMarker[]>;
  onMarkField: (field: ProtocolField) => void;
  onEditMarker: (marker: FieldMarker) => void;
}

function FieldNode({ field, depth, markersByField, onMarkField, onEditMarker }: FieldNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = Boolean(field.children?.length);
  const fieldMarkers = markersByField.get(field.id) ?? [];
  return <div className="field-node" style={{ '--depth': depth } as CSSProperties}>
    <div className="field-row" onClick={() => hasChildren && setExpanded((value) => !value)}>
      <span className={`chevron ${hasChildren ? '' : 'invisible'} ${expanded ? 'open' : ''}`}>⌄</span>
      <span className="field-key">{field.key}</span>
      <span className="field-value">{field.value}</span>
      <span className="field-description">{field.description}</span>
      <span className="field-marks" onClick={(event) => event.stopPropagation()}>
        {fieldMarkers.map((marker) => (
          <button
            key={marker.id}
            className={`marker-dot dot-${marker.color}`}
            title={marker.note || '（无注释）'}
            onClick={() => onEditMarker(marker)}
          />
        ))}
        <button className="mark-button" title="为此字段添加标记" onClick={() => onMarkField(field)}>✎</button>
      </span>
    </div>
    {hasChildren && expanded && <div className="field-children">{field.children!.map((child) => (
      <FieldNode key={child.id} field={child} depth={depth + 1} markersByField={markersByField} onMarkField={onMarkField} onEditMarker={onEditMarker} />
    ))}</div>}
  </div>;
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <div className="empty-state">还没有事件记录。</div>;
  return <div className="timeline">{events.map((event, index) => <div className="timeline-event" key={event.id}><div className="timeline-marker"><span>{String(index + 1).padStart(2, '0')}</span></div><div className="timeline-content"><div><strong>{event.label}</strong><time>{event.timestamp}</time></div><p>{event.detail}</p><span className={`phase phase-${event.phase}`}>{event.phase}</span></div></div>)}</div>;
}

interface HexViewProps {
  rows: SimulatedPacket['hex'];
  markers: FieldMarker[];
  onMarkRow: (row: SimulatedPacket['hex'][number]) => void;
  onEditMarker: (marker: FieldMarker) => void;
}

function HexView({ rows, markers, onMarkRow, onEditMarker }: HexViewProps) {
  if (!rows.length) return <div className="empty-state">没有可显示的十六进制内容。</div>;
  const byteMarkers = markers.filter((marker) => marker.anchor.kind === 'bytes');
  const markersForRow = (row: SimulatedPacket['hex'][number]) => {
    const start = parseInt(row.offset, 16);
    const end = start + row.bytes.length;
    return byteMarkers.filter((marker) => {
      const anchor = marker.anchor as ByteAnchor;
      return anchor.start < end && anchor.end > start;
    });
  };
  return <div className="hex-view"><div className="hex-header"><span>OFFSET</span><span>HEX BYTES</span><span>ASCII</span><span /></div>{rows.map((row) => {
    const rowMarkers = markersForRow(row);
    return <div className={`hex-row ${rowMarkers.length ? 'marked' : ''}`} key={row.offset}>
      <code>{row.offset}</code>
      <code>{row.bytes.join(' ')}</code>
      <code className="ascii">{row.ascii}</code>
      <span className="field-marks">
        {rowMarkers.map((marker) => (
          <button
            key={marker.id}
            className={`marker-dot dot-${marker.color}`}
            title={marker.note || '（无注释）'}
            onClick={() => onEditMarker(marker)}
          />
        ))}
        <button className="mark-button" title="为此字节范围添加标记" onClick={() => onMarkRow(row)}>✎</button>
      </span>
    </div>;
  })}</div>;
}

interface MarkerPanelProps {
  markers: FieldMarker[];
  packet: SimulatedPacket | null;
  staleCount: number;
  onEdit: (marker: FieldMarker) => void;
  onDelete: (markerId: string) => void;
}

function MarkerPanel({ markers, packet, staleCount, onEdit, onDelete }: MarkerPanelProps) {
  return (
    <div className="marker-panel">
      <div className="marker-panel-heading">
        <p className="section-kicker">注释与书签 · ANNOTATIONS</p>
        <span>{markers.length} 个标记{staleCount > 0 ? ` · ${staleCount} 个已失效` : ''}</span>
      </div>
      {markers.length === 0
        ? <div className="empty-state">点击字段行或十六进制行上的 ✎，为起始行、Header、TCP 字段、Payload 或字节范围创建带颜色和文字的标记。</div>
        : <div className="marker-list">{markers.map((marker) => {
            const active = markerIsActive(packet, marker);
            const label = marker.anchor.kind === 'field'
              ? (active && packet ? fieldAnchorLabel(packet.fields, marker.anchor) : `字段 · ${marker.anchor.fieldKey}`)
              : byteAnchorLabel(marker.anchor);
            return (
              <div className={`marker-item ${active ? '' : 'stale'}`} key={marker.id}>
                <span className={`marker-dot dot-${marker.color}`} />
                <div className="marker-body">
                  <div className="marker-title">
                    <strong>{label}</strong>
                    {!active && <span className="stale-badge">已失效 · 内容已变化</span>}
                  </div>
                  <p>{marker.note || '（无注释）'}</p>
                </div>
                <div className="marker-actions">
                  <button onClick={() => onEdit(marker)}>编辑</button>
                  <button className="danger" onClick={() => onDelete(marker.id)}>删除</button>
                </div>
              </div>
            );
          })}</div>}
    </div>
  );
}

export default App;
