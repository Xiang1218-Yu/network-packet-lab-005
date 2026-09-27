import type { PacketMarker } from '../../../shared/types';
import type { AnchorResolution } from '../../../shared/types';

interface MarkersPanelProps {
  markers: PacketMarker[];
  resolve: (marker: PacketMarker) => AnchorResolution;
  onFocus: (marker: PacketMarker) => void;
  onDelete: (id: string) => void;
  onJumpHex: () => void;
}

function anchorText(marker: PacketMarker): string {
  if (marker.anchor.kind === 'field') return marker.anchor.label;
  return `${marker.anchor.label} · [${marker.anchor.start}, ${marker.anchor.end})`;
}

export function MarkersPanel({ markers, resolve, onFocus, onDelete, onJumpHex }: MarkersPanelProps) {
  if (!markers.length) {
    return (
      <div className="markers-panel-empty">
        还没有标记。点击字段行末尾的 <strong>＋</strong>、给十六进制整行加书签，或在十六进制视图中拖拽选择字节范围来记录“这里为什么值得关注”。
      </div>
    );
  }
  const sorted = [...markers].sort((a, b) => {
    const ao = a.anchor.kind === 'bytes' ? a.anchor.start : -1;
    const bo = b.anchor.kind === 'bytes' ? b.anchor.start : -1;
    return ao - bo || b.updatedAt.localeCompare(a.updatedAt);
  });
  return (
    <ul className="markers-list">
      {sorted.map((marker) => {
        const resolution = resolve(marker);
        return (
          <li key={marker.id} className={`marker-card marker-card-${marker.color} ${resolution.status === 'detached' ? 'is-detached' : ''}`}>
            <div className="marker-card-head">
              <span className={`marker-dot marker-${marker.color}`} />
              <button className="marker-card-anchor" onClick={() => onFocus(marker)} title="定位到锚点">
                {anchorText(marker)}
              </button>
              <span className={`marker-status status-${resolution.status}`}>
                {resolution.status === 'attached'
                  ? marker.anchor.kind === 'bytes'
                    ? '字节锚点'
                    : '字段锚点'
                  : '已脱落'}
              </span>
              <button className="marker-card-delete" onClick={() => onDelete(marker.id)}>×</button>
            </div>
            <p className="marker-card-note">{marker.note}</p>
            <div className="marker-card-foot">
              {resolution.status === 'detached' && <span className="detach-reason">{resolution.reason}</span>}
              <button className="marker-card-jump" onClick={onJumpHex}>十六进制定位 →</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
