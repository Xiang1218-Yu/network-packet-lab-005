import { useEffect, useState } from 'react';
import { MARKER_COLORS, type MarkerColor, type PacketMarker } from '../../../shared/types';

export interface MarkerDialogTarget {
  kind: 'field' | 'bytes';
  title: string;
  subtitle: string;
}

interface MarkerDialogProps {
  target: MarkerDialogTarget;
  markers: PacketMarker[];
  /** Pre-selected color/notes used when creating a new marker. */
  draft: { color: MarkerColor; note: string };
  onDraftChange: (draft: { color: MarkerColor; note: string }) => void;
  onCreate: () => void;
  onUpdate: (id: string, patch: { color?: MarkerColor; note?: string }) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const COLOR_LABEL: Record<MarkerColor, string> = {
  cyan: '青色 · 关注',
  amber: '琥珀 · 疑问',
  rose: '玫红 · 异常',
  green: '绿色 · 确认',
  violet: '紫色 · 笔记'
};

export function MarkerDialog({
  target,
  markers,
  draft,
  onDraftChange,
  onCreate,
  onUpdate,
  onDelete,
  onClose
}: MarkerDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal marker-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <p className="section-kicker">{target.kind === 'field' ? 'FIELD ANNOTATION' : 'BYTE RANGE ANNOTATION'}</p>
            <h3>{target.title}</h3>
            <p className="modal-subtitle">{target.subtitle}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        {markers.length > 0 && (
          <div className="existing-markers">
            {markers.map((marker) => (
              <ExistingMarkerRow key={marker.id} marker={marker} onUpdate={onUpdate} onDelete={onDelete} />
            ))}
          </div>
        )}

        <div className="marker-create">
          <p className="marker-create-title">{markers.length ? '再添加一条标记' : '新建标记'}</p>
          <div className="color-swatches">
            {MARKER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`swatch swatch-${color} ${draft.color === color ? 'selected' : ''}`}
                title={COLOR_LABEL[color]}
                aria-label={COLOR_LABEL[color]}
                onClick={() => onDraftChange({ ...draft, color })}
              />
            ))}
          </div>
          <textarea
            className="marker-note-input"
            placeholder="这里为什么值得关注？记录你的分析…"
            value={draft.note}
            onChange={(event) => onDraftChange({ ...draft, note: event.target.value })}
            autoFocus
          />
          <div className="modal-actions">
            <span className="modal-hint">编辑会先保存在本地，接口恢复后自动提交</span>
            <button className="button primary" disabled={!draft.note.trim()} onClick={onCreate}>
              添加标记
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExistingMarkerRow({
  marker,
  onUpdate,
  onDelete
}: {
  marker: PacketMarker;
  onUpdate: (id: string, patch: { color?: MarkerColor; note?: string }) => void;
  onDelete: (id: string) => void;
}) {
  const [note, setNote] = useState(marker.note);
  const [color, setColor] = useState<MarkerColor>(marker.color);

  useEffect(() => {
    setNote(marker.note);
    setColor(marker.color);
  }, [marker.id, marker.note, marker.color]);

  const dirty = note !== marker.note || color !== marker.color;

  return (
    <div className="existing-marker">
      <div className="existing-marker-bar">
        <div className="color-swatches compact">
          {MARKER_COLORS.map((item) => (
            <button
              key={item}
              type="button"
              className={`swatch swatch-${item} ${color === item ? 'selected' : ''}`}
              onClick={() => {
                setColor(item);
                onUpdate(marker.id, { color: item });
              }}
              aria-label={COLOR_LABEL[item]}
            />
          ))}
        </div>
        <span className="marker-time">{new Date(marker.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
        <button className="marker-delete" onClick={() => onDelete(marker.id)}>删除</button>
      </div>
      <textarea
        className="marker-note-input"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onBlur={() => dirty && note.trim() && onUpdate(marker.id, { note })}
      />
    </div>
  );
}
