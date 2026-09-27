import { useRef, useState } from 'react';
import type { SavedCapture } from '../../../shared/types';
import type { ImportResult } from './useAnnotations';

interface CapturesPanelProps {
  captures: SavedCapture[];
  activeFrameId: string | null;
  onSave: (label: string) => void;
  onLoad: (capture: SavedCapture) => void;
  onRemove: (frameId: string) => void;
  onExportOne: (capture: SavedCapture) => string;
  onExportAll: () => string;
  onImport: (text: string, loadFirst: boolean) => Promise<ImportResult>;
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function CapturesPanel({
  captures,
  activeFrameId,
  onSave,
  onLoad,
  onRemove,
  onExportOne,
  onExportAll,
  onImport
}: CapturesPanelProps) {
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const save = () => {
    onSave(label.trim());
    setLabel('');
    setMessage('当前帧与标记已保存到本地捕获库');
    setTimeout(() => setMessage(''), 2500);
  };

  const importFromFile = async (file: File) => {
    try {
      const text = await file.text();
      const result = await onImport(text, true);
      setMessage(`导入成功 ${result.imported} 份捕获${result.skipped ? `，跳过 ${result.skipped} 份无效项` : ''}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导入失败');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
      setTimeout(() => setMessage(''), 4000);
    }
  };

  return (
    <div className="captures-panel">
      <div className="capture-save-row">
        <input
          className="capture-label-input"
          placeholder="给这次捕获起个名字（可选）"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button className="button tiny primary" onClick={save}>保存当前帧</button>
      </div>
      <div className="capture-toolbar">
        <button className="link-button" onClick={() => downloadText(`packet-lab-captures-${Date.now()}.json`, onExportAll())}>
          ↧ 导出全部（{captures.length}）
        </button>
        <button className="link-button" onClick={() => fileInput.current?.click()}>
          ↥ 导入捕获
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFromFile(file);
          }}
        />
      </div>
      {message && <p className="capture-message">{message}</p>}
      {captures.length === 0 && <p className="captures-empty">保存的捕获帧会出现在这里，可随时重新载入并保留全部标记。</p>}
      <ul className="captures-list">
        {captures.map((capture) => (
          <li key={capture.frameId} className={capture.frameId === activeFrameId ? 'active' : ''}>
            <button className="capture-entry" onClick={() => onLoad(capture)} title="重新载入此捕获">
              <span className="capture-entry-label">{capture.label}</span>
              <span className="capture-entry-meta">
                {capture.packet.protocol} · {capture.markers.length} 个标记 · {new Date(capture.savedAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
            </button>
            <button
              className="capture-icon-button"
              title="导出此捕获 JSON"
              onClick={() => downloadText(`capture-${capture.frameId}.json`, onExportOne(capture))}
            >
              ↧
            </button>
            <button className="capture-icon-button danger" title="删除" onClick={() => onRemove(capture.frameId)}>×</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
