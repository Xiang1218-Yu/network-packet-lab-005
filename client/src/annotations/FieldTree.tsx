import { useState, type CSSProperties } from 'react';
import type { AnchorResolution, PacketMarker, ProtocolField } from '../../../shared/types';

interface FieldTreeProps {
  fields: ProtocolField[];
  markers: PacketMarker[];
  /** Resolve a marker against the active packet (memoised upstream). */
  resolve: (marker: PacketMarker) => AnchorResolution;
  selectedRange: { start: number; end: number } | null;
  onSelectRange: (range: { start: number; end: number } | null) => void;
  onAnnotateField: (field: ProtocolField) => void;
  onOpenMarker: (marker: PacketMarker) => void;
}

type NodeProps = Omit<FieldTreeProps, 'fields'> & { field: ProtocolField; depth: number };

export function FieldTree({ fields, ...rest }: FieldTreeProps) {
  if (!fields.length) return <div className="empty-state">解析后将在这里显示协议层级字段。</div>;
  return (
    <div className="field-tree">
      {fields.map((node) => <FieldNode key={node.id} field={node} depth={0} {...rest} />)}
    </div>
  );
}

function FieldNode({
  field,
  depth,
  markers,
  resolve,
  selectedRange,
  onSelectRange,
  onAnnotateField,
  onOpenMarker
}: NodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = Boolean(field.children?.length);
  const fieldMarkers = markers.filter(
    (marker) => marker.anchor.kind === 'field' && marker.anchor.path === field.path
  );
  const selected = field.byteRange
    ? selectedRange !== null
      && field.byteRange.start >= selectedRange.start
      && field.byteRange.end <= selectedRange.end
    : false;

  return (
    <div className="field-node" style={{ '--depth': depth } as CSSProperties}>
      <div className={`field-row ${selected ? 'range-selected' : ''}`}>
        <span
          className={`chevron ${hasChildren ? '' : 'invisible'} ${expanded ? 'open' : ''}`}
          onClick={() => hasChildren && setExpanded((value) => !value)}
        >
          ⌄
        </span>
        <span
          className="field-key clickable-key"
          onClick={() => field.byteRange && onSelectRange(selected ? null : field.byteRange)}
          title={field.byteRange ? '点击在十六进制视图中高亮此字段字节' : '该模拟字段没有对应原始字节'}
        >
          {field.key}
        </span>
        <span className="field-value">{field.value}</span>
        <span className="field-description">{field.description}</span>
        <span className="field-actions">
          {fieldMarkers.map((marker) => (
            <button
              key={marker.id}
              className={`inline-marker marker-${marker.color} ${resolve(marker).status === 'detached' ? 'detached' : ''}`}
              title={marker.note}
              onClick={() => onOpenMarker(marker)}
            >
              ★
            </button>
          ))}
          <button
            className="bookmark-button"
            title="为此字段添加注释 / 书签"
            onClick={() => onAnnotateField(field)}
          >
            {fieldMarkers.length ? '✎' : '＋'}
          </button>
        </span>
      </div>
      {hasChildren && expanded && (
        <div className="field-children">
          {field.children!.map((child) => (
            <FieldNode key={child.id} field={child} depth={depth + 1} markers={markers} resolve={resolve} selectedRange={selectedRange} onSelectRange={onSelectRange} onAnnotateField={onAnnotateField} onOpenMarker={onOpenMarker} />
          ))}
        </div>
      )}
    </div>
  );
}
