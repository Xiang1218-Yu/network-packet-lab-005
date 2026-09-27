import { useMemo, useRef, useState } from 'react';
import type { ByteRange, PacketMarker, SimulatedPacket } from '../../../shared/types';
import type { AnchorResolution } from '../../../shared/types';
import { toHex, toUtf8Bytes } from '../../../shared/markers';

interface HexViewProps {
  packet: SimulatedPacket | null;
  markers: PacketMarker[];
  resolve: (marker: PacketMarker) => AnchorResolution;
  selectedRange: ByteRange | null;
  onSelectRange: (range: ByteRange | null) => void;
  onAnnotateRange: (range: ByteRange) => void;
  onAnnotateRow: (range: ByteRange) => void;
  onOpenMarker: (marker: PacketMarker) => void;
}

interface FlatByte {
  index: number;
  value: number;
}

interface DragState {
  anchor: number;
  current: number;
}

function printable(byte: number): string {
  return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '·';
}

export function HexView({
  packet,
  markers,
  resolve,
  selectedRange,
  onSelectRange,
  onAnnotateRange,
  onAnnotateRow,
  onOpenMarker
}: HexViewProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);

  const bytes = useMemo<FlatByte[]>(
    () => (packet ? Array.from(toUtf8Bytes(packet.raw), (value: number, index: number) => ({ index, value })) : []),
    [packet]
  );
  const rows = useMemo(() => {
    const grouped: FlatByte[][] = [];
    for (let index = 0; index < bytes.length; index += 16) grouped.push(bytes.slice(index, index + 16));
    return grouped;
  }, [bytes]);

  const attachedByteMarkers = useMemo(() => markers.filter((marker) => {
    if (marker.anchor.kind !== 'bytes') return false;
    return resolve(marker).status === 'attached';
  }), [markers, resolve]);

  const dragRange: ByteRange | null = drag
    ? { start: Math.min(drag.anchor, drag.current), end: Math.max(drag.anchor, drag.current) + 1 }
    : null;
  const effectiveRange = dragRange ?? selectedRange;

  const markerAt = (index: number): PacketMarker | undefined =>
    attachedByteMarkers.find((marker) => {
      const anchor = marker.anchor as Extract<PacketMarker['anchor'], { kind: 'bytes' }>;
      return index >= anchor.start && index < anchor.end;
    });

  const beginDrag = (index: number) => (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    setDrag({ anchor: index, current: index });
  };
  const enterByte = (index: number) => {
    if (drag) setDrag({ ...drag, current: index });
  };
  const endDrag = () => {
    if (!drag) return;
    const range = {
      start: Math.min(drag.anchor, drag.current),
      end: Math.max(drag.anchor, drag.current) + 1
    };
    if (range.end - range.start > 1) {
      suppressClick.current = true;
      onSelectRange(range);
    }
    setDrag(null);
  };

  const clickByte = (index: number) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const hit = markerAt(index);
    if (hit) {
      onOpenMarker(hit);
      return;
    }
    const range = { start: index, end: index + 1 };
    onSelectRange(
      selectedRange && selectedRange.start === range.start && selectedRange.end === range.end ? null : range
    );
  };

  if (!packet || !rows.length) return <div className="empty-state">没有可显示的十六进制内容。</div>;

  return (
    <div className="hex-view" onMouseLeave={endDrag} onMouseUp={endDrag}>
      <div className="hex-header">
        <span>OFFSET</span>
        <span>HEX BYTES（拖拽选择范围 · 点击标记）</span>
        <span>ASCII</span>
      </div>
      {rows.map((row, rowIndex) => {
        const rowStart = rowIndex * 16;
        const rowEnd = Math.min(rowStart + 16, bytes.length);
        return (
          <div className="hex-row" key={rowStart}>
            <code className="hex-offset">{rowStart.toString(16).padStart(4, '0')}</code>
            <div className="hex-bytes">
              {row.map(({ index, value }) => {
                const marker = markerAt(index);
                const inRange = effectiveRange && index >= effectiveRange.start && index < effectiveRange.end;
                return (
                  <button
                    key={index}
                    type="button"
                    className={`hex-byte ${marker ? `has-marker marker-${marker.color}` : ''} ${inRange ? 'range-selected' : ''}`}
                    onMouseDown={beginDrag(index)}
                    onMouseEnter={() => enterByte(index)}
                    onClick={() => clickByte(index)}
                    title={marker ? marker.note : `字节 ${index}`}
                  >
                    {toHex([value])}
                  </button>
                );
              })}
              <button
                type="button"
                className="hex-row-bookmark"
                title="给整行十六进制加书签"
                onClick={() => onAnnotateRow({ start: rowStart, end: rowEnd })}
              >
                ＋行
              </button>
            </div>
            <code className="ascii">
              {row.map(({ index, value }) => {
                const marker = markerAt(index);
                return (
                  <span key={index} className={marker ? `ascii-byte marker-${marker.color}` : 'ascii-byte'}>
                    {printable(value)}
                  </span>
                );
              })}
            </code>
          </div>
        );
      })}
      <HexSelectionBar range={effectiveRange} bytes={bytes} onAnnotate={onAnnotateRange} onClear={() => onSelectRange(null)} />
    </div>
  );
}

function HexSelectionBar({
  range,
  bytes,
  onAnnotate,
  onClear
}: {
  range: ByteRange | null;
  bytes: FlatByte[];
  onAnnotate: (range: ByteRange) => void;
  onClear: () => void;
}) {
  if (!range) {
    return <div className="hex-selection-bar">未选中字节 · 在上方拖拽可选择一段字节范围。</div>;
  }
  const slice = bytes.slice(range.start, range.end).map((entry) => entry.value);
  const previewText = Array.from(new TextDecoder().decode(Uint8Array.from(slice)))
    .map((character) => (character.charCodeAt(0) >= 32 && character.charCodeAt(0) <= 126 ? character : '·'))
    .join('');
  return (
    <div className="hex-selection-bar">
      <span>
        已选 <strong>[{range.start}, {range.end})</strong> · {range.end - range.start} 字节 ·{' '}
        <code>{toHex(slice).slice(0, 47)}{slice.length > 8 ? '…' : ''}</code> ·{' '}
        <em>{previewText.slice(0, 24)}</em>
      </span>
      <span className="hex-selection-actions">
        <button className="button tiny primary" onClick={() => onAnnotate(range)}>＋ 标记此范围</button>
        <button className="button tiny ghost" onClick={onClear}>清除选择</button>
      </span>
    </div>
  );
}
