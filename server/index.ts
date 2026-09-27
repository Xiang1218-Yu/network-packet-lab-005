import express, { type Request, type Response } from 'express';
import type {
  PacketScenario,
  ParseRequest,
  Protocol,
  PutMarkersRequest,
  SimulatedPacket
} from '../shared/types.js';
import { buildPacket, HTTP_SAMPLES, TCP_SAMPLES } from './frame.js';
import { allBundles, getBundle, putBundle } from './markerStore.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  response.header('Access-Control-Allow-Origin', '*');
  response.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Fail-Markers');
  response.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});

function isProtocol(value: unknown): value is Protocol { return value === 'HTTP' || value === 'TCP'; }
function isScenario(value: unknown): value is PacketScenario { return value === 'request' || value === 'response' || value === 'handshake'; }

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'network-packet-lab-api' }));

app.get('/api/simulate', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenario = isScenario(request.query.scenario) ? request.query.scenario : (protocol === 'HTTP' ? 'request' : 'handshake');
  response.json({ data: buildPacket(protocol, scenario, '') });
});

app.get('/api/packets', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenarios: PacketScenario[] = protocol === 'HTTP' ? ['request', 'response'] : ['handshake', 'request', 'response'];
  response.json({ data: scenarios.map((scenario) => buildPacket(protocol, scenario, '')) });
});

app.post('/api/parse', (request: Request<unknown, unknown, Partial<ParseRequest>>, response: Response) => {
  const protocol = isProtocol(request.body?.protocol) ? request.body.protocol : 'HTTP';
  const scenario = isScenario(request.body?.scenario) ? request.body.scenario : 'request';
  const raw = typeof request.body?.raw === 'string' ? request.body.raw : '';
  if (!raw.trim()) return response.status(400).json({ error: 'raw is required' });
  response.json({ data: buildPacket(protocol, scenario, raw) });
});

/* ------------------------------------------------------------------ */
/* Annotation / bookmark API                                          */
/* ------------------------------------------------------------------ */

/**
 * When the client sends `X-Fail-Markers: 1` every marker request fails.
 * It lets students verify that unsynced edits survive an interface outage.
 */
function failInjected(request: Request): boolean {
  return request.header('X-Fail-Markers') === '1';
}

app.get('/api/markers', (request, response) => {
  if (failInjected(request)) return response.status(503).json({ error: 'failure injected (markers)' });
  const frameId = typeof request.query.frameId === 'string' ? request.query.frameId : '';
  if (!frameId) {
    return response.status(400).json({ error: 'frameId query parameter is required' });
  }
  response.json({ data: getBundle(frameId) });
});

app.put('/api/markers/:frameId', (request: Request<{ frameId: string }, unknown, Partial<PutMarkersRequest>>, response: Response) => {
  if (failInjected(request)) return response.status(503).json({ error: 'failure injected (markers)' });
  const { frameId } = request.params;
  if (!Array.isArray(request.body?.markers)) {
    return response.status(400).json({ error: 'markers array is required' });
  }
  // Defensive: never let annotations be filed under a different frame.
  const markers = request.body.markers.map((entry) => ({ ...entry, frameId }));
  response.json({ data: putBundle(frameId, markers) });
});

app.get('/api/markers-export', (_request, response) => {
  response.json({ data: allBundles() });
});

app.get('/api/samples', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  response.json({ data: protocol === 'HTTP' ? HTTP_SAMPLES : TCP_SAMPLES });
});

app.listen(port, () => {
  console.log(`Network Packet Lab API listening on http://localhost:${port}`);
});
