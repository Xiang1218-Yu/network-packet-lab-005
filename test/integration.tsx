/**
 * Integration test for useAnnotations, run inside jsdom against the real
 * express server. Covers: local-first edits, failure retention + reload retry,
 * strict migration (no misattachment), and capture save/export/import.
 */
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { buildPacket } from '../server/frame.ts';
import { useAnnotations } from '../client/src/annotations/useAnnotations.ts';
import { readStorage, STORAGE_KEYS } from '../client/src/storage.ts';

// ---- jsdom setup -------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).localStorage = dom.window.localStorage;
if (!(globalThis as any).crypto) Object.defineProperty(globalThis, 'crypto', { value: dom.window.crypto, configurable: true });
(globalThis as any).TextEncoder = TextEncoder;
(globalThis as any).TextDecoder = TextDecoder;
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let api: ReturnType<typeof useAnnotations> | null = null;
function Harness() {
  api = useAnnotations();
  return React.createElement('div');
}

async function main() {
const container = document.getElementById('root')!;
const root = createRoot(container);
await act(async () => {
  root.render(React.createElement(Harness));
});
const A = () => api!;
const tick = (ms = 100) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const assert = (cond: boolean, msg: string) => {
  if (!cond) { console.error('✗ FAIL:', msg); process.exitCode = 1; }
  else console.log('✓', msg);
};

const API_BASE = globalThis.__PACKET_LAB_API_BASE__ ?? 'http://localhost:3001';
const httpResponse = buildPacket('HTTP', 'response', '');
const httpRequest = buildPacket('HTTP', 'request', '');

// ---- 1. adopt + edit while API failing -------------------------------
act(() => { A().setFailMarkers(true); });
act(() => { A().adoptFrame(httpResponse); });
await tick(50);

const ctField = httpResponse.fields[1].children!.find((c) => c.path === 'http.headers["Content-Type"]')!;
act(() => { A().addFieldMarker(ctField, 'amber', '这里 Content-Type 决定如何解析 body'); });
await tick(800);

assert(A().markers.length === 1, '字段标记已创建');
assert(A().saveStatus === 'error', `故障注入下状态为 error（实际 ${A().saveStatus}）`);
assert(readStorage<any[]>(STORAGE_KEYS.pending, []).includes(httpResponse.frameId), '未提交 frameId 已持久化到 pending');

// byte marker
act(() => { A().addByteMarker({ start: 96, end: 104 }, 'rose', '注意 body 开头的 JSON'); });
await tick(800);
assert(A().markers.length === 2, '字节标记也已创建且未因失败丢失');
assert(readStorage<Record<string, any[]>>(STORAGE_KEYS.markers, {})[httpResponse.frameId]?.length === 2, '两个标记都已写入 localStorage');

// ---- 2. "reload" with a brand new hook instance ----------------------
let api2: ReturnType<typeof useAnnotations> | null = null;
function Harness2() { api2 = useAnnotations(); return null; }
const c2 = document.createElement('div'); document.body.appendChild(c2);
const root2 = createRoot(c2);
await act(async () => { root2.render(React.createElement(Harness2)); });
const B = () => api2!;

// Still failing: adopt frame, edits must be intact locally
act(() => { B().adoptFrame(httpResponse); });
await tick(1000);
assert(B().markers.length === 2, `重载后（接口仍故障）标记保留在本地（实际 ${B().markers.length}）`);

// Recover API: pending edits flush automatically
act(() => { B().setFailMarkers(false); });
await tick(1200);
assert(B().saveStatus === 'saved', `接口恢复后自动提交成功（实际 ${B().saveStatus}）`);
assert(!readStorage<any[]>(STORAGE_KEYS.pending, []).includes(httpResponse.frameId), '提交成功后 pending 清空');

// Server actually persisted them
const res = await fetch(`${API_BASE}/api/markers?frameId=${httpResponse.frameId}`);
const serverBundle = await res.json() as any;
assert(serverBundle.data.markers.length === 2, `服务端持久化了 2 个标记（实际 ${serverBundle.data.markers.length}）`);

// ---- 3. migration: delete Content-Type header, re-parse -------------
const editedRaw = 'HTTP/1.1 200 OK\r\nContent-Length: 47\r\nCache-Control: no-store\r\n\r\n{"devices":[{"id":"edge-01","status":"online"}]}';
const edited = buildPacket('HTTP', 'response', editedRaw);
let report: any;
act(() => { report = B().replaceActiveFrame(edited); });
await tick(900);
assert(report.detached.length === 2, `字段被删+字节移位后 2 条标记全部脱落（实际 detached ${report.detached.length}）`);
assert(B().markers.length === 0, '新包上没有错误套用旧标记');
assert(B().captures.length >= 1 && B().captures.some((c) => c.frameId === httpResponse.frameId), '旧帧已自动归档，脱落标记随旧帧保留');

// ---- 4. migration follows semantic path + identical bytes -----------
act(() => { B().loadCapture(B().captures.find((c) => c.frameId === httpResponse.frameId)!); });
await tick(600);
assert(B().markers.length === 2, '重新载入归档后 2 条标记恢复');
const reordered = buildPacket('HTTP', 'response', 'HTTP/1.1 200 OK\r\nCache-Control: no-store\r\nContent-Length: 47\r\nContent-Type: application/json\r\n\r\n{"devices":[{"id":"edge-01","status":"online"}]}');
let report2: any;
act(() => { report2 = B().replaceActiveFrame(reordered); });
await tick(900);
assert(report2.attached.length === 2, `等长重排后字段路径+相同字节的 2 条标记跟随（实际 attached ${report2.attached.length}）`);
assert(B().markers.length === 2, '新包上标记仍正确关联');

// ---- 5. parsing a completely different packet never misattaches ----
let report3: any;
act(() => { report3 = B().replaceActiveFrame(httpRequest); });
await tick(500);
assert(report3.attached.length === 0, '切换到另一份包（request）时没有标记被错误套用');
assert(B().markers.length === 0, 'request 包上标记数为 0');

// ---- 6. export / import roundtrip ------------------------------------
act(() => { B().adoptFrame(httpResponse); });
act(() => { B().saveCapture('测试响应'); });
await tick(300);
const exported = JSON.parse(B().exportAllCaptures());
assert(exported.format === 'packet-lab-captures' && exported.captures.length >= 2, '导出全部捕获格式正确');
const single = JSON.parse(B().exportCapture(exported.captures.find((c:any)=>c.label==='测试响应')));
assert(single.format === 'packet-lab-capture' && single.markers.length === 2, '单帧导出携带 2 个标记');

// re-import
const importResult = await B().importFile(JSON.stringify(single), true);
await tick(50);
assert(importResult.imported === 1 && B().markers.length === 2, '导入后帧与标记恢复');

// malformed import rejected
let rejected = false;
try { await B().importFile('{"hello":"world"}', false); } catch { rejected = true; }
assert(rejected, '无效导入文件被拒绝');

// ---- 7. TCP layer markers anchor across TCP scenarios ---------------
const tcpReq = buildPacket('TCP', 'request', '');
act(() => { B().adoptFrame(tcpReq); });
const flagsField = tcpReq.fields[2].children!.find((c) => c.path === 'tcp.flags')!;
act(() => { B().addFieldMarker(flagsField, 'violet', 'PSH+ACK 表示有数据'); });
await tick(900);
const tcpResp = buildPacket('TCP', 'response', '');
let report4: any;
act(() => { report4 = B().replaceActiveFrame(tcpResp); });
await tick(900);
assert(report4.attached.length === 1, 'TCP flags 语义路径在 response 场景仍解析，标记跟随');
const resolution = B().resolveActive(B().markers[0]);
assert(resolution.status === 'attached' && resolution.fieldValue === 'ACK,PSH', `标记指向新包真实 flags 值（实际 ${resolution.status}/${resolution.fieldValue}）`);

console.log('\n集成测试完成。');

}

export { main };
