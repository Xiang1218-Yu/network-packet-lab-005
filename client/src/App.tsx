import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ByteRange,
  MarkerColor,
  PacketMarker,
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField
} from '../../shared/types';
import { fetchSample, parsePacket } from './api';
import { useAnnotations, type MigrationReport } from './annotations/useAnnotations';
import { FieldTree } from './annotations/FieldTree';
import { HexView } from './annotations/HexView';
import { MarkersPanel } from './annotations/MarkersPanel';
import { CapturesPanel } from './annotations/CapturesPanel';
import { MarkerDialog, type MarkerDialogTarget } from './annotations/MarkerDialog';
import type { SimulatedPacket, TimelineEvent } from '../../shared/types';

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

type ViewMode = 'overview' | 'hex';

interface DialogState {
  target: MarkerDialogTarget;
  anchor:
    | { kind: 'field'; field: ProtocolField }
    | { kind: 'bytes'; range: ByteRange };
}

function App() {
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [scenario, setScenario] = useState<PacketScenario>('request');
  const [rawInput, setRawInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<ViewMode>('overview');
  const [selectedRange, setSelectedRange] = useState<ByteRange | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [draft, setDraft] = useState<{ color: MarkerColor; note: string }>({ color: 'cyan', note: '' });

  const annotations = useAnnotations();
  const {
    activePacket,
    activeFrameId,
    markers,
    saveStatus,
    lastError,
    failMarkers,
    migration
  } = annotations;

  const packet = activePacket;
  const abortRef = useRef<AbortController | null>(null);

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const loadSample = useCallback(async (nextProtocol: Protocol, nextScenario: PacketScenario) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await fetchSample(nextProtocol, nextScenario, controller.signal);
      setRawInput(result.data.raw);
      setSelectedRange(null);
      annotations.adoptFrame(result.data);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : '加载模拟数据失败');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [annotations]);

  const parseCurrent = useCallback(async () => {
    setLoading(true);
    setError('');
    const body: ParseRequest = { protocol, scenario, raw: rawInput };
    try {
      const result = await parsePacket(body);
      setRawInput(result.data.raw);
      setSelectedRange(null);
      annotations.replaceActiveFrame(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  }, [annotations, protocol, scenario, rawInput]);

  useEffect(() => {
    void loadSample('HTTP', 'request');
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /* ---------------------------------------------------------------- */
  /* Marker dialog wiring                                              */
  /* ---------------------------------------------------------------- */

  const openFieldDialog = (field: ProtocolField) => {
    setDialog({
      target: {
        kind: 'field',
        title: field.key,
        subtitle: `${field.value} · 路径 ${field.path}`
      },
      anchor: { kind: 'field', field }
    });
    setDraft({ color: 'cyan', note: '' });
  };

  const openRangeDialog = (range: ByteRange) => {
    if (!packet) return;
    setDialog({
      target: {
        kind: 'bytes',
        title: `字节范围 [${range.start}, ${range.end})`,
        subtitle: `${range.end - range.start} 字节`
      },
      anchor: { kind: 'bytes', range }
    });
    setDraft({ color: 'amber', note: '' });
  };

  const dialogMarkers = useMemo(() => {
    if (!dialog) return [];
    if (dialog.anchor.kind === 'field') {
      const { field } = dialog.anchor;
      return markers.filter((marker) => marker.anchor.kind === 'field' && marker.anchor.path === field.path);
    }
    const { range } = dialog.anchor;
    return markers.filter((marker) => {
      if (marker.anchor.kind !== 'bytes') return false;
      return marker.anchor.start < range.end && marker.anchor.end > range.start;
    });
  }, [dialog, markers]);

  const createMarker = () => {
    if (!dialog || !draft.note.trim()) return;
    if (dialog.anchor.kind === 'field') annotations.addFieldMarker(dialog.anchor.field, draft.color, draft.note.trim());
    else annotations.addByteMarker(dialog.anchor.range, draft.color, draft.note.trim());
    setDraft({ ...draft, note: '' });
  };

  const focusMarker = (marker: PacketMarker) => {
    const resolution = annotations.resolveActive(marker);
    if (resolution.status === 'attached' && resolution.range) {
      setSelectedRange(resolution.range);
      if (marker.anchor.kind === 'field') setActiveView('overview');
      else setActiveView('hex');
    }
  };

  const saveStatusLabel: Record<typeof saveStatus, string> = {
    idle: '就绪',
    pending: '本地已保存 · 等待提交',
    saving: '正在同步…',
    saved: '已同步到服务端',
    error: '同步失败 · 编辑保留在本地'
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
        <div className="connection-status">
          <i /> API ONLINE <span>localhost:3001</span>
        </div>
      </header>

      <main className="dashboard">
        <section className="hero-copy">
          <div>
            <p className="section-kicker">解析工作台 · INSPECTOR</p>
            <h2>把每一个字节，<em>还原成可读的网络故事。</em></h2>
            <p className="hero-subtitle">在字段、起始行、TCP 层与十六进制字节上留下彩色注释与书签；切换视图、重新解析或换一份包，标记始终锚定真实路径与字节。</p>
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
            <button className="button ghost" onClick={() => void loadSample(protocol, scenario)} disabled={loading}>↻ 载入模拟包</button>
            <button className="button primary" onClick={() => void parseCurrent()} disabled={loading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          </div>
        </section>

        {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}

        <SyncBar
          status={saveStatus}
          label={saveStatusLabel[saveStatus]}
          detail={lastError}
          failMarkers={failMarkers}
          onToggleFail={annotations.setFailMarkers}
          onRetry={annotations.retryPending}
        />
        {migration && <MigrationBanner report={migration} onDismiss={annotations.dismissMigration} />}

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
            <div className="panel captures-panel-panel">
              <div className="panel-heading"><div><p className="section-kicker">03 / SAVED CAPTURES</p><h3>捕获帧库</h3></div><span className="badge">{annotations.captures.length}</span></div>
              <CapturesPanel
                captures={annotations.captures}
                activeFrameId={activeFrameId}
                onSave={annotations.saveCapture}
                onLoad={annotations.loadCapture}
                onRemove={annotations.removeCapture}
                onExportOne={annotations.exportCapture}
                onExportAll={annotations.exportAllCaptures}
                onImport={annotations.importFile}
              />
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
            </div>

            <div className="panel details-panel">
              <div className="tabs">
                <button className={activeView === 'overview' ? 'selected' : ''} onClick={() => setActiveView('overview')}>协议字段树</button>
                <button className={activeView === 'hex' ? 'selected' : ''} onClick={() => setActiveView('hex')}>十六进制视图</button>
                <span className="tabs-frame-id">{activeFrameId}</span>
              </div>
              {activeView === 'overview' ? (
                <FieldTree
                  fields={packet?.fields ?? []}
                  markers={markers}
                  resolve={annotations.resolveActive}
                  selectedRange={selectedRange}
                  onSelectRange={(range) => { setSelectedRange(range); if (range) setActiveView('hex'); }}
                  onAnnotateField={openFieldDialog}
                  onOpenMarker={(marker) => {
                    focusMarker(marker);
                    if (marker.anchor.kind === 'field') {
                      const target = findField(packet, marker.anchor.path);
                      if (target) openFieldDialog(target);
                    }
                  }}
                />
              ) : (
                <HexView
                  packet={packet}
                  markers={markers}
                  resolve={annotations.resolveActive}
                  selectedRange={selectedRange}
                  onSelectRange={setSelectedRange}
                  onAnnotateRange={openRangeDialog}
                  onAnnotateRow={openRangeDialog}
                  onOpenMarker={(marker) => {
                    if (marker.anchor.kind === 'bytes') {
                      setSelectedRange({ start: marker.anchor.start, end: marker.anchor.end });
                      openRangeDialog({ start: marker.anchor.start, end: marker.anchor.end });
                    }
                  }}
                />
              )}
            </div>

            <div className="panel markers-panel">
              <div className="panel-heading">
                <div><p className="section-kicker">04 / ANNOTATIONS</p><h3>注释与书签 <span className="marker-count">{markers.length}</span></h3></div>
                {selectedRange && (
                  <button className="button tiny ghost" onClick={() => { setActiveView('hex'); openRangeDialog(selectedRange); }}>
                    ＋ 标记当前选区
                  </button>
                )}
              </div>
              <MarkersPanel
                markers={markers}
                resolve={annotations.resolveActive}
                onFocus={focusMarker}
                onDelete={annotations.deleteMarker}
                onJumpHex={() => setActiveView('hex')}
              />
            </div>
          </div>
        </section>
      </main>
      <footer className="footer"><span>PACKET LAB / EDUCATIONAL SIMULATOR</span><span>React + Vite + TypeScript · Express API · 标记锚定字段路径与字节范围</span></footer>

      {dialog && (
        <MarkerDialog
          target={dialog.target}
          markers={dialogMarkers}
          draft={draft}
          onDraftChange={setDraft}
          onCreate={createMarker}
          onUpdate={annotations.updateMarker}
          onDelete={annotations.deleteMarker}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function findField(packet: SimulatedPacket | null, path: string): ProtocolField | null {
  if (!packet) return null;
  const stack = [...packet.fields];
  while (stack.length) {
    const node = stack.shift()!;
    if (node.path === path) return node;
    if (node.children) stack.push(...node.children);
  }
  return null;
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="meta-item"><span>{label}</span><strong>{value}</strong></div>;
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <div className="empty-state">还没有事件记录。</div>;
  return <div className="timeline">{events.map((event, index) => <div className="timeline-event" key={event.id}><div className="timeline-marker"><span>{String(index + 1).padStart(2, '0')}</span></div><div className="timeline-content"><div><strong>{event.label}</strong><time>{event.timestamp}</time></div><p>{event.detail}</p><span className={`phase phase-${event.phase}`}>{event.phase}</span></div></div>)}</div>;
}

function SyncBar({
  status,
  label,
  detail,
  failMarkers,
  onToggleFail,
  onRetry
}: {
  status: string;
  label: string;
  detail: string;
  failMarkers: boolean;
  onToggleFail: (value: boolean) => void;
  onRetry: () => void;
}) {
  return (
    <div className={`sync-bar sync-${status}`}>
      <span className="sync-dot" />
      <div className="sync-text">
        <strong>{label}</strong>
        {detail && <span className="sync-detail">{detail}</span>}
      </div>
      <label className="fail-toggle">
        <input type="checkbox" checked={failMarkers} onChange={(event) => onToggleFail(event.target.checked)} />
        <span>模拟标记接口故障</span>
      </label>
      {status === 'error' && <button className="button tiny ghost" onClick={onRetry}>立即重试</button>}
    </div>
  );
}

function MigrationBanner({ report, onDismiss }: { report: MigrationReport; onDismiss: () => void }) {
  return (
    <div className="migration-banner">
      <div className="migration-head">
        <strong>重新解析完成 · 标记已按锚点严格校验</strong>
        <button onClick={onDismiss}>知道了</button>
      </div>
      <p>
        {report.attached.length > 0 && <span className="migration-ok">✓ {report.attached.length} 条标记在新包中找到对应字段路径或相同字节，已保留。</span>}
        {report.detached.length > 0 && (
          <span className="migration-bad">
            {' '}✕ {report.detached.length} 条标记无法在新内容中定位（字段被删除或字节变化），{report.archived ? '已随旧帧自动归档到捕获帧库，不会套用到新内容上。' : '未迁移。'}
          </span>
        )}
      </p>
    </div>
  );
}

export default App;
