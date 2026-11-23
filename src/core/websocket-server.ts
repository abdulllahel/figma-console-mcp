/**
 * WebSocket Bridge Server (Multi-Client)
 *
 * Creates a WebSocket server that multiple Desktop Bridge plugin instances connect to.
 * Each instance represents a different Figma file and is identified by its fileKey
 * (sent via FILE_INFO on connection). Per-file state (selection, document changes,
 * console logs) is maintained independently.
 *
 * Active file tracking: The "active" file is automatically switched when the user
 * interacts with a file (selection/page changes) or can be set explicitly via
 * setActiveFile(). All backward-compatible getters return data from the active file.
 *
 * Data flow: MCP Server ←WebSocket→ ui.html ←postMessage→ code.js ←figma.*→ Figma
 */

import { WebSocketServer as WSServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'http';
import type { Server as HttpServer } from 'http';
import { readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, statSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { execFile } from 'child_process';
import { createChildLogger } from './logger.js';
import { PACKAGE_ROOT } from './resolve-package-root.js';
import type { ConsoleLogEntry } from './types/index.js';

// Read version from package.json using the resolved package root.
// PACKAGE_ROOT uses import.meta.url in ESM (production) and __dirname in CJS (Jest).
let SERVER_VERSION = '0.0.0';
try {
  SERVER_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')).version;
} catch {
  // Non-critical — version will show as 0.0.0
}

/** This package's version, as published — what MCP clients are told in `initialize`. */
export function getServerVersion(): string {
  return SERVER_VERSION;
}

/**
 * Extract the PLUGIN_VERSION constant from figma-desktop-bridge/code.js source.
 * Returns null when the constant is absent or malformed.
 */
export function parseBundledPluginVersion(codeJsSource: string): string | null {
  const match = codeJsSource.match(/var PLUGIN_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/);
  return match ? match[1] : null;
}

// The version of the plugin files THIS package ships — i.e. what a manifest
// re-import would install. This is deliberately NOT the package version:
// server-only releases (deps, docs, server code) bump package.json without
// touching figma-desktop-bridge/, and comparing the plugin against
// SERVER_VERSION would falsely nag users to re-import an already-current
// plugin (seen live: plugin 1.33.0 + server 1.33.1 → spurious update banner).
let BUNDLED_PLUGIN_VERSION = SERVER_VERSION;
try {
  const parsed = parseBundledPluginVersion(
    readFileSync(join(PACKAGE_ROOT, 'figma-desktop-bridge', 'code.js'), 'utf-8')
  );
  if (parsed) BUNDLED_PLUGIN_VERSION = parsed;
} catch {
  // Non-critical — fall back to SERVER_VERSION (pre-v1.33.2 behavior)
}

/** Version of the plugin files bundled with this server (what a re-import installs). */
export function getBundledPluginVersion(): string {
  return BUNDLED_PLUGIN_VERSION;
}

/**
 * Compare two `major.minor.patch` strings. Returns <0 when a precedes b, 0 when
 * equal, >0 when a follows b, and null when either side isn't parseable.
 */
export function compareSemver(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const parts = v.trim().split('.');
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => Number(p));
    return nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * A plugin needs re-importing when it reports no version (predates version
 * reporting) or an OLDER version than the plugin files this server ships.
 * The server's own package version is irrelevant here.
 *
 * The direction matters. This used to be a bare `!==`, which also fired when
 * the connected plugin was NEWER than the server's bundled copy — telling the
 * user to re-import, which can only ever install the same or a newer plugin,
 * so the banner could never be cleared. That is not a rare state: the port
 * range means several server instances run at once, and during an upgrade the
 * older ones keep an outdated BUNDLED_PLUGIN_VERSION in memory (it is parsed
 * once at module load) while the freshly re-imported plugin is already current.
 * Every stale server then nags a correctly-updated plugin. Observed live on
 * v1.39.0 with four leftover v1.38.2 servers.
 *
 * An older server has nothing to offer a newer plugin, so it stays quiet.
 */
export function computePluginUpdateAvailable(
  pluginVersion: string | null,
  bundledPluginVersion: string
): boolean {
  if (!pluginVersion) return true;
  const cmp = compareSemver(pluginVersion, bundledPluginVersion);
  // Unparseable on either side — fall back to the conservative inequality so a
  // genuinely odd plugin build still prompts rather than passing silently.
  if (cmp === null) return pluginVersion !== bundledPluginVersion;
  return cmp < 0;
}

const logger = createChildLogger({ component: 'websocket-server' });

export interface WebSocketServerOptions {
  port: number;
  host?: string;
  /**
   * Version of the plugin files shipped with this server, used for the
   * FILE_INFO version handshake. Defaults to the PLUGIN_VERSION parsed from
   * the packaged figma-desktop-bridge/code.js. Overridable for tests.
   */
  bundledPluginVersion?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  method: string;
  timeoutId: ReturnType<typeof setTimeout>;
  createdAt: number;
  targetFileKey: string;
}

/**
 * A request that timed out before the plugin answered. Figma can't interrupt a
 * running plugin script, so the plugin may still be working on it, and
 * commands sent after it wait in line behind it.
 */
interface AbandonedRequest {
  method: string;
  sentAt: number;
  timedOutAt: number;
  targetFileKey: string;
  /** Socket the request went out on; a reconnect means the plugin restarted. */
  ws: WebSocket;
}

/** A file whose plugin stopped answering: two requests in a row timed out. */
interface StalledFile {
  method: string;
  sentAt: number;
  since: number;
  ws: WebSocket;
}

/** Forget timed-out requests after this long; a reply that late is just logged as unsolicited. */
const ABANDONED_REQUEST_TTL_MS = 15 * 60 * 1000;
/** Stop failing fast after this long, so a plugin that recovered without replying gets traffic again. */
const STALL_MAX_MS = 10 * 60 * 1000;

export interface ConnectedFileInfo {
  fileName: string;
  fileKey: string | null;
  currentPage?: string;
  currentPageId?: string;
  editorType?: 'figma' | 'figjam' | 'dev';
  connectedAt: number;
  /** Version reported by the imported plugin's code.js (FILE_INFO). Null when the plugin predates version reporting. */
  pluginVersion?: string | null;
  /** True when the imported plugin's version differs from the plugin files bundled with this server — the user should re-import manifest.json. */
  pluginUpdateAvailable?: boolean;
}

export interface SelectionInfo {
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    width?: number;
    height?: number;
  }>;
  count: number;
  page: string;
  timestamp: number;
}

export interface DocumentChangeEntry {
  hasStyleChanges: boolean;
  hasNodeChanges: boolean;
  changedNodeIds: string[];
  changeCount: number;
  timestamp: number;
}

/**
 * v1.25.0: A single metadata-only change captured by the plugin and forwarded
 * over the WebSocket. Tracks the two fields Figma REST never exposes in version
 * snapshots — `description` and `annotations` — so `figma_diff_versions` can
 * surface them by correlating buffer entries to the diff time window.
 *
 * The plugin captures these on `figma.on('documentchange')` when a PROPERTY_CHANGE
 * touches one of those fields. Only the NEW value is captured (Figma's event
 * doesn't include before/after). The diff engine treats the from-version's
 * value as "whatever it was at the start of the window" — buffer entries
 * within the window are interpreted as "during this version range, the field
 * was edited; final value at end of window is shown."
 */
export interface MetadataChangeEntry {
  node_id: string;
  node_name: string | null;
  node_type: string | null;
  field: 'description' | 'annotations';
  new_value: any;
  timestamp: number;
}

/**
 * Per-file client connection state.
 * Each Figma file with the Desktop Bridge plugin open gets its own ClientConnection.
 */
export interface ClientConnection {
  ws: WebSocket;
  fileInfo: ConnectedFileInfo;
  selection: SelectionInfo | null;
  documentChanges: DocumentChangeEntry[];
  /** v1.25.0: per-file ring buffer of description/annotation change events */
  metadataChanges: MetadataChangeEntry[];
  consoleLogs: ConsoleLogEntry[];
  lastActivity: number;
  lastPongAt: number;
  gracePeriodTimer: ReturnType<typeof setTimeout> | null;
}

export class FigmaWebSocketServer extends EventEmitter {
  private transferMemoryJobs = new Map<string, any>();
  private transferMemoryPages = new Map<string, Buffer>();
  private transferMemoryImages = new Map<string, Buffer>();
  private wss: WSServer | null = null;
  private httpServer: HttpServer | null = null;
  /** Named clients indexed by fileKey — each represents a connected Figma file */
  private clients: Map<string, ClientConnection> = new Map();
  /** Clients awaiting FILE_INFO identification, mapped to their pending timeout */
  private _pendingClients: Map<WebSocket, ReturnType<typeof setTimeout>> = new Map();
  /** The fileKey of the currently active (targeted) file */
  private _activeFileKey: string | null = null;
  /**
   * When true, the active file is pinned: new connections, reconnects, and
   * user interaction (selection/page changes) will NOT move the active target.
   * Lets the agent work in one file while the user works in another without
   * commands silently routing to the wrong file. Cleared if the locked file
   * disconnects.
   */
  private _targetLocked = false;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private abandonedRequests: Map<string, AbandonedRequest> = new Map();
  private stalledFiles: Map<string, StalledFile> = new Map();
  private requestIdCounter = 0;
  private options: WebSocketServerOptions;
  private _isStarted = false;
  private _startedAt = Date.now();
  private consoleBufferSize = 1000;
  private documentChangeBufferSize = 200;
  /** Heartbeat interval for detecting dead connections via ping/pong */
  private _heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebSocketServerOptions) {
    super();
    this.options = options;
    this._startedAt = Date.now();
  }

  // ---- Custom fiGapture relay: browser extension -> Desktop Bridge plugin (in-memory) ----
  private fiGaptureCaptures = new Map<string, any>();
  private fiGaptureBytes = 0;
  private static readonly FIGAPTURE_MAX_BYTES = 900 * 1024 * 1024;

  /**
   * Crash-safe JSON response. Serializes BEFORE sending headers (a huge or
   * circular body can make JSON.stringify throw), and never writes a second
   * response — writing headers twice throws ERR_HTTP_HEADERS_SENT, which
   * previously crashed the whole server.
   */
  private sendJson(res: ServerResponse, code: number, body: unknown): void {
    if (res.headersSent || res.writableEnded) return;
    let payload: string;
    try {
      payload = JSON.stringify(body);
    } catch (e) {
      code = 500;
      payload = JSON.stringify({ error: 'Response could not be serialized: ' + String((e as any)?.message || e) });
    }
    try {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(payload);
    } catch (e) {
      logger.warn({ err: String((e as any)?.message || e) }, 'Failed to send HTTP response');
    }
  }

  private readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private fiGaptureSummary(c: any) {
    return {
      id: c.id, key: c.key, url: c.url, title: c.title, createdAt: c.createdAt,
      sliceCount: Array.isArray(c.slices) ? c.slices.length : 0,
      hasLayers: !!c.figmaJson, hasDesign: !!c.design,
      pageWidth: c.pageWidth, pageHeight: c.pageHeight, dpr: c.dpr, bytes: c._bytes,
    };
  }

  /** Returns true when the request belonged to the fiGapture relay and was handled. */
  private handleFiGaptureRoute(req: IncomingMessage, res: ServerResponse, url: string): boolean {
    if (!url.startsWith('/fiGapture/')) return false;
    const json = (code: number, body: unknown) => this.sendJson(res, code, body);
    const path = url.split('?')[0];

    if (req.method === 'GET' && path === '/fiGapture/captures') {
      json(200, { captures: Array.from(this.fiGaptureCaptures.values()).map(c => this.fiGaptureSummary(c)) });
      return true;
    }
    const m = path.match(/^\/fiGapture\/captures\/([A-Za-z0-9_\-]+)$/);
    if (m && req.method === 'GET') {
      const c = this.fiGaptureCaptures.get(m[1]);
      if (!c) { json(404, { error: 'unknown capture' }); return true; }
      if (url.indexOf('part=design') !== -1) { json(200, { id: c.id, url: c.url, title: c.title, design: c.design || null }); return true; }
      json(200, c);
      return true;
    }
    if (m && req.method === 'DELETE') {
      const c = this.fiGaptureCaptures.get(m[1]);
      if (c) { this.fiGaptureBytes -= c._bytes || 0; this.fiGaptureCaptures.delete(m[1]); }
      json(200, { ok: true });
      return true;
    }
    if (req.method === 'POST' && path === '/fiGapture/captures') {
      this.readBody(req, 700 * 1024 * 1024).then(buf => {
        const c = JSON.parse(buf.toString('utf8'));
        if (!c || typeof c.id !== 'string' || !/^[A-Za-z0-9_\-]+$/.test(c.id)) { json(400, { error: 'bad id' }); return; }
        c._bytes = buf.length;
        // Re-capturing the same URL replaces the older capture.
        for (const [id, old] of this.fiGaptureCaptures) {
          if (id === c.id || (c.key && old.key === c.key)) { this.fiGaptureBytes -= old._bytes || 0; this.fiGaptureCaptures.delete(id); }
        }
        this.fiGaptureCaptures.set(c.id, c);
        this.fiGaptureBytes += c._bytes;
        // Keep memory bounded: drop the oldest captures first.
        while (this.fiGaptureBytes > FigmaWebSocketServer.FIGAPTURE_MAX_BYTES && this.fiGaptureCaptures.size > 1) {
          const oldest = this.fiGaptureCaptures.keys().next().value as string;
          this.fiGaptureBytes -= this.fiGaptureCaptures.get(oldest)._bytes || 0;
          this.fiGaptureCaptures.delete(oldest);
        }
        json(200, { ok: true, id: c.id, count: this.fiGaptureCaptures.size });
      }).catch(err => json(500, { error: String(err && err.message || err) }));
      return true;
    }
    json(404, { error: 'not found' });
    return true;
  }


  // ---- Page Transfer relay: source file plugin -> disk backup -> destination file plugin ----
  private static readonly TRANSFER_ROOT = join(homedir(), 'Documents', 'fiGapture-Transfer-Backups');

  private transferDir(id: string): string | null {
    if (!/^[A-Za-z0-9_\-]{3,80}$/.test(id)) return null;
    return join(FigmaWebSocketServer.TRANSFER_ROOT, id);
  }

  private readJob(id: string): any | null {
    if (this.transferMemoryJobs.has(id)) return this.transferMemoryJobs.get(id);
    const d = this.transferDir(id);
    if (!d) return null;
    try { return JSON.parse(readFileSync(join(d, 'job.json'), 'utf8')); } catch { return null; }
  }

  private writeJob(job: any): void {
    if (!job || !job.id) return;
    this.transferMemoryJobs.set(String(job.id), job);
    try {
      const d = this.transferDir(String(job.id));
      if (d) {
        if (!existsSync(d)) mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
      }
    } catch (e) {
      console.warn('Failed to write job to disk', e);
    }
  }

  private handleTransferRoute(req: IncomingMessage, res: ServerResponse, url: string): boolean {
    if (!url.startsWith('/transfer/')) return false;
    const json = (code: number, body: unknown) => this.sendJson(res, code, body);
    const fail = (err: unknown) => json(500, { error: String((err as any)?.message || err) });
    const path = url.split('?')[0];
    const query = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');
    const root = FigmaWebSocketServer.TRANSFER_ROOT;

    if (req.method === 'GET' && path === '/transfer/ping') { json(200, { ok: true, root, native: 1 }); return true; }

    if (req.method === 'GET' && path === '/transfer/files') {
      const now = Date.now();
      const files = Array.from(this.clients.entries())
        .filter(([, c]) => c.ws.readyState === WebSocket.OPEN && (now - c.lastPongAt) < 90000)
        .map(([fileKey, c]) => ({ fileKey, fileName: c.fileInfo?.fileName || '' }));
      json(200, { files });
      return true;
    }

    if (req.method === 'GET' && path === '/transfer/jobs') {
      const dest = query.get('dest');
      const out: any[] = [];
      for (const job of this.transferMemoryJobs.values()) {
        if (dest && job.destFileKey !== dest) continue;
        out.push(job);
      }
      try {
        if (existsSync(root)) for (const name of readdirSync(root)) {
          if (this.transferMemoryJobs.has(name)) continue;
          const job = this.readJob(name);
          if (!job) continue;
          if (dest && job.destFileKey !== dest) continue;
          out.push(job);
        }
      } catch (e) {}
      out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      json(200, { jobs: out.slice(0, 50), root });
      return true;
    }

    if (req.method === 'POST' && path === '/transfer/jobs') {
      this.readBody(req, 5 * 1024 * 1024).then(buf => {
        const job = JSON.parse(buf.toString('utf8'));
        if (!job || !this.transferDir(String(job.id))) { json(400, { error: 'bad id' }); return; }
        job.createdAt = job.createdAt || Date.now();
        job.state = job.state || 'exporting';
        this.writeJob(job);
        json(200, { ok: true, dir: this.transferDir(job.id) });
      }).catch(fail);
      return true;
    }

    const jm = path.match(/^\/transfer\/jobs\/([A-Za-z0-9_\-]+)$/);
    if (jm) {
      if (req.method === 'GET') { const j = this.readJob(jm[1]); json(j ? 200 : 404, j || { error: 'unknown job' }); return true; }
      if (req.method === 'POST') {
        this.readBody(req, 5 * 1024 * 1024).then(buf => {
          const cur = this.readJob(jm[1]);
          if (!cur) { json(404, { error: 'unknown job' }); return; }
          const patch = JSON.parse(buf.toString('utf8'));
          if (cur.state === 'cancelled' && patch.state !== 'cancelled' && !patch.resume) {
            patch.state = 'cancelled';
          }
          const next = Object.assign({}, cur, patch, { id: cur.id, updatedAt: Date.now() });
          this.writeJob(next);
          json(200, next);
        }).catch(fail);
        return true;
      }
      if (req.method === 'DELETE') {
        const d = this.transferDir(jm[1]);
        try { if (d && existsSync(d)) rmSync(d, { recursive: true, force: true }); json(200, { ok: true }); } catch (e) { fail(e); }
        return true;
      }
    }

    const pm = path.match(/^\/transfer\/jobs\/([A-Za-z0-9_\-]+)\/pages\/([A-Za-z0-9_\-]+)$/);
    if (pm) {
      const key = pm[1] + ':' + pm[2];
      if (req.method === 'PUT') {
        this.readBody(req, 600 * 1024 * 1024).then(buf => {
          this.transferMemoryPages.set(key, buf);
          try {
            const d = this.transferDir(pm[1]);
            if (d) {
              if (!existsSync(d)) mkdirSync(d, { recursive: true });
              writeFileSync(join(d, 'page-' + pm[2] + '.json'), buf);
            }
          } catch (e) {}
          json(200, { ok: true, bytes: buf.length });
        }).catch(fail);
        return true;
      }
      if (req.method === 'GET') {
        const memBuf = this.transferMemoryPages.get(key);
        if (memBuf) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(memBuf);
          return true;
        }
        const d = this.transferDir(pm[1]);
        const file = d ? join(d, 'page-' + pm[2] + '.json') : null;
        if (file && existsSync(file)) {
          try { const data = readFileSync(file); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(data); return true; } catch {}
        }
        json(404, { error: 'no page' });
        return true;
      }
    }

    const im = path.match(/^\/transfer\/jobs\/([A-Za-z0-9_\-]+)\/img\/([A-Za-z0-9]{8,64})$/);
    if (im) {
      const key = im[1] + ':' + im[2];
      if (req.method === 'PUT') {
        this.readBody(req, 200 * 1024 * 1024).then(buf => {
          this.transferMemoryImages.set(key, buf);
          try {
            const d = this.transferDir(im[1]);
            if (d) {
              const imgDir = join(d, 'images');
              if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true });
              writeFileSync(join(imgDir, im[2] + '.bin'), buf);
            }
          } catch (e) {}
          json(200, { ok: true });
        }).catch(fail);
        return true;
      }
      if (req.method === 'GET') {
        const memBuf = this.transferMemoryImages.get(key);
        if (memBuf) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(memBuf);
          return true;
        }
        const d = this.transferDir(im[1]);
        const file = d ? join(d, 'images', im[2] + '.bin') : null;
        if (file && existsSync(file)) {
          try { const data = readFileSync(file); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(data); return true; } catch {}
        }
        json(404, { error: 'no image' });
        return true;
      }
    }

    // ---- Automatic native copy/paste (macOS): press Figma's own Edit ▸ Copy / Edit ▸ Paste ----
    if (path.startsWith('/transfer/native/')) {
      // Claude (and other hosts) start this server through a helper that disclaims
      // responsibility, so macOS asks for Accessibility for THIS binary ("node"),
      // not for Claude. Tell the plugin exactly which app to switch on.
      const njson = (code: number, b: any) => json(code, b && b.needsAccess ? { ...b, accessApp: this.accessApp() } : b);
      const body = () => this.readBody(req, 64 * 1024).then(b => { try { return JSON.parse(b.toString('utf8') || '{}'); } catch { return {}; } });
      if (req.method === 'GET' && path === '/transfer/native/check') {
        this.nativeFront('').then(f => njson(200, { ok: !f.needsAccess, platform: process.platform, ...f })).catch(fail);
        return true;
      }
      if (req.method === 'POST' && path === '/transfer/native/open-settings') {
        execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], () => njson(200, { ok: true }));
        return true;
      }
      if (req.method === 'POST' && path === '/transfer/native/focus') {
        body().then(b => this.nativeFocus(String(b.fileName || ''), b)).then(r => njson(200, r)).catch(fail);
        return true;
      }
      if (req.method === 'POST' && path === '/transfer/native/copy') {
        body().then(b => this.nativeCopy(String(b.fileName || ''), String(b.fileKey || ''))).then(r => njson(200, r)).catch(fail);
        return true;
      }
      if (req.method === 'POST' && path === '/transfer/native/paste') {
        body().then(b => this.nativePaste(String(b.fileName || ''), String(b.srcFileKey || ''), Number(b.changeCount || 0), b.kind === 'h2d' ? 'h2d' : 'figma')).then(r => njson(200, r)).catch(fail);
        return true;
      }
      // fiGapture: where is the plugin panel right now? (pointer position minus the click's
      // position inside the panel; read at click time, before the user moves the mouse)
      if (req.method === 'POST' && path === '/transfer/native/locate') {
        body().then(b => this.nativeLocate(b)).then(r => njson(200, r)).catch(fail);
        return true;
      }
      // fiGapture: put the captured page layers on the clipboard (as Figma's paste format)
      if (req.method === 'POST' && path === '/transfer/native/set-clipboard') {
        this.readBody(req, 300 * 1024 * 1024)
          .then(buf => { let b: any = {}; try { b = JSON.parse(buf.toString('utf8') || '{}'); } catch {} return this.nativeSetClipboard(String(b.html || '')); })
          .then(r => njson(200, r)).catch(fail);
        return true;
      }
    }

    json(404, { error: 'not found' });
    return true;
  }

  // ---------- macOS automation helpers for the Copy/Paste tab ----------
  private run(cmd: string, args: string[], timeoutMs = 15000): Promise<{ out: string; err: string; code: number }> {
    return new Promise(resolve => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (e: any, out, err) => {
        resolve({ out: String(out || ''), err: String(err || (e && e.message) || ''), code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 });
      });
    });
  }

  /** Path of the program macOS checks for Accessibility (this server's node binary). */
  private accessApp(): string {
    try { return realpathSync(process.execPath); } catch { return process.execPath; }
  }

  private axTrustedOk = false;
  /** True when macOS lets this server control other apps (Accessibility). Cached once granted. */
  private async axTrusted(): Promise<boolean> {
    if (this.axTrustedOk) return true;
    const r = await this.run('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("ApplicationServices"); String($.AXIsProcessTrusted())']);
    if (r.code !== 0) return true; // can't tell: let the real call report its own error
    this.axTrustedOk = r.out.trim() === 'true';
    return this.axTrustedOk;
  }

  private static readonly FIGMA_PROC = 'first process whose bundle identifier is "com.figma.Desktop"';

  /** Is Figma the frontmost app, and is the given file the visible tab? */
  private async nativeFront(fileName: string): Promise<{ frontmost: boolean; title: string; matches: boolean | null; needsAccess?: boolean; error?: string }> {
    if (process.platform !== 'darwin') return { frontmost: false, title: '', matches: null, error: 'Automatic copy/paste only works on macOS.' };
    if (!(await this.axTrusted())) return { frontmost: false, title: '', matches: null, needsAccess: true, error: 'macOS Accessibility permission is needed.' };
    const r = await this.run('osascript', ['-e',
      `tell application "System Events" to tell ${FigmaWebSocketServer.FIGMA_PROC}
        set t to ""
        if frontmost then get name of menu bar item 1 of menu bar 1
        try
          set t to name of front window
        end try
        return (frontmost as text) & "\n" & t
      end tell`]);
    if (r.code !== 0) {
      const needsAccess = /assistive access|not allowed to send keystrokes|not allowed assistive|-25211/i.test(r.err);
      return { frontmost: false, title: '', matches: null, needsAccess, error: needsAccess ? 'macOS Accessibility permission is needed.' : r.err.trim() };
    }
    const [front, ...rest] = r.out.trim().split('\n');
    const title = rest.join('\n').trim();
    let matches: boolean | null = null;
    if (fileName && title) {
      // The title names the focused file. Pick the LONGEST connected file name it contains, so
      // "Helping Design System" is not mistaken for "Helping" (split view shows both).
      const names = Array.from(new Set([fileName, ...Array.from(this.clients.values()).map(c => c.fileInfo?.fileName || '')])).filter(Boolean);
      const hit = names.filter(n => title.includes(n)).sort((a, b) => b.length - a.length)[0];
      matches = hit ? hit === fileName : null;
    }
    return { frontmost: front === 'true', title, matches };
  }

  /** Send a real Cmd+<key> to Figma, exactly as if it was typed on the keyboard. */
  private async pressShortcut(key: 'c' | 'v'): Promise<{ ok: boolean; error?: string; needsAccess?: boolean }> {
    const r = await this.run('osascript', ['-e', `tell application "System Events" to keystroke "${key}" using command down`]);
    if (r.code === 0) return { ok: true };
    const needsAccess = /assistive access|not allowed to send keystrokes|not allowed assistive|-25211/i.test(r.err);
    return { ok: false, needsAccess, error: needsAccess ? 'macOS Accessibility permission is needed.' : 'Could not press Cmd+' + key.toUpperCase() + ': ' + r.err.trim() };
  }

  /**
   * Give Figma's canvas keyboard focus with one real mouse click on empty canvas.
   * Figma only copies/pastes after a real click on the canvas; focus inside the plugin
   * panel swallows Cmd+C / Cmd+V. The plugin tells us where its panel is on screen
   * (screen position of the button click minus its position inside the panel); we click
   * just left of the panel, which is canvas, then put the pointer back where it was.
   */
  private async nativeFocus(fileName: string, b: any): Promise<any> {
    if (process.platform !== 'darwin') return { ok: false, error: 'Automatic copy/paste only works on macOS.' };
    if (!fileName || (typeof b.clientX !== 'number' && typeof b.panelX !== 'number')) return { ok: false, error: 'Missing file name or click position.' };
    const f = await this.nativeFront(fileName);
    if (f.needsAccess || f.error) return { ok: false, needsAccess: !!f.needsAccess, error: f.error };
    if (!f.frontmost || f.matches === false) return { ok: false, notFront: true, title: f.title, error: 'Click inside "' + fileName + '" first so it is the active file, then try again.' };
    const n = (v: any) => (typeof v === 'number' && isFinite(v) ? v : null);
    const sx = n(b.screenX), sy = n(b.screenY), cx = n(b.clientX), cy = n(b.clientY);
    const js = `ObjC.import('CoreGraphics');
      function loc(){ var p=$.CGEventGetLocation($.CGEventCreate(null)); return {x:p.x,y:p.y}; }
      function post(t,x,y){ var e=$.CGEventCreateMouseEvent(null,t,{x:x,y:y},0); $.CGEventPost(0,e); }
      var a = loc(), sx = ${sx}, sy = ${sy}, cx = ${cx}, cy = ${cy};
      // Where was the click? Prefer the event's screen position; fall back to the pointer now.
      // The pointer is still on the button that was just clicked; the event's own screen
      // coordinates proved unreliable inside Figma's plugin frame, so use the pointer.
      var px = a.x, py = a.y;
      var left = px - (cx || 0), top = py - (cy || 0);
      var plx = ${n(b.panelX)}, ply = ${n(b.panelY)};
      if (plx !== null && ply !== null) { left = plx; top = ply; }
      var tx = left - 60, ty = top + 40;
      post(5, tx, ty); delay(0.05);
      post(1, tx, ty); delay(0.05);
      post(2, tx, ty); delay(0.08);
      post(5, a.x, a.y);
      JSON.stringify({ clicked: {x: tx, y: ty}, panel: {x: left, y: top}, pointer: a, eventScreen: {x: sx, y: sy} });`;
    const r = await this.run('osascript', ['-l', 'JavaScript', '-e', js]);
    if (r.code !== 0) {
      const needsAccess = /assistive access|not allowed|-25211/i.test(r.err);
      return { ok: false, needsAccess, error: needsAccess ? 'macOS Accessibility permission is needed.' : 'Could not click the canvas: ' + r.err.trim() };
    }
    let info: any = {}; try { info = JSON.parse(r.out.trim()); } catch {}
    await this.sleep(150);
    return { ok: true, ...info };
  }

  /** Where is the plugin panel on screen? Pointer position now minus the click's position inside the panel. */
  private async nativeLocate(b: any): Promise<any> {
    if (process.platform !== 'darwin') return { ok: false, error: 'Automatic paste only works on macOS.' };
    const n = (v: any) => (typeof v === 'number' && isFinite(v) ? v : 0);
    const r = await this.run('osascript', ['-l', 'JavaScript', '-e',
      'ObjC.import("CoreGraphics"); var p = $.CGEventGetLocation($.CGEventCreate(null)); JSON.stringify({ x: p.x, y: p.y })']);
    let p: any = null; try { p = JSON.parse(r.out.trim()); } catch {}
    if (!p) return { ok: false, error: 'Could not read the pointer position.' };
    return { ok: true, panelX: p.x - n(b.clientX), panelY: p.y - n(b.clientY) };
  }

  /** Put HTML (Figma's paste format) on the macOS clipboard; returns the clipboard's change counter. */
  private async nativeSetClipboard(html: string): Promise<any> {
    if (process.platform !== 'darwin') return { ok: false, error: 'Automatic paste only works on macOS.' };
    if (!html) return { ok: false, error: 'Nothing to put on the clipboard.' };
    const file = join(tmpdir(), 'fiGapture-clip-' + process.pid + '-' + Date.now() + '.html');
    writeFileSync(file, html, 'utf8');
    try {
      const r = await this.run('osascript', ['-l', 'JavaScript', '-e',
        `ObjC.import("AppKit"); var s = $.NSString.stringWithContentsOfFileEncodingError(${JSON.stringify(file)}, 4, null);
         var pb = $.NSPasteboard.generalPasteboard; pb.clearContents; var ok = pb.setStringForType(s, "public.html");
         JSON.stringify({ ok: !!ok, changeCount: Number(pb.changeCount) })`], 60000);
      let j: any = null; try { j = JSON.parse(r.out.trim()); } catch {}
      if (!j || !j.ok) return { ok: false, error: 'Could not write the clipboard: ' + (r.err.trim() || 'unknown error') };
      const now = await this.readClipboard();
      if (!now.isH2d) return { ok: false, error: 'The clipboard did not keep the layers.' };
      return { ok: true, changeCount: now.changeCount, bytes: now.bytes };
    } finally { try { rmSync(file, { force: true }); } catch {} }
  }

  /** Read the clipboard: change counter plus the Figma file key from Figma's clipboard metadata. */
  private async readClipboard(): Promise<{ changeCount: number; isFigma: boolean; isH2d?: boolean; fileKey: string; bytes: number }> {
    const r = await this.run('osascript', ['-l', 'JavaScript', '-e',
      `ObjC.import("AppKit"); var pb = $.NSPasteboard.generalPasteboard; var h = pb.stringForType("public.html"); h = h && !h.isNil() ? ObjC.unwrap(h) : "";
       var m = h.match(/\\(figmeta\\)([A-Za-z0-9+\\/=]+)\\(\\/figmeta\\)/); var key = "";
       if (m) { try { var d = $.NSData.alloc.initWithBase64EncodedStringOptions(m[1], 0); var s = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(d, 4)); key = JSON.parse(s).fileKey || ""; } catch (e) {} }
       JSON.stringify({ changeCount: Number(pb.changeCount), isFigma: h.indexOf("(figma)") >= 0, isH2d: h.indexOf("(figh2d)") >= 0, fileKey: key, bytes: h.length })`]);
    try { return JSON.parse(r.out.trim()); } catch { return { changeCount: -1, isFigma: false, isH2d: false, fileKey: '', bytes: 0 }; }
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  private async nativeCopy(fileName: string, fileKey: string): Promise<any> {
    const f = await this.nativeFront(fileName);
    if (f.needsAccess || f.error) return { ok: false, needsAccess: !!f.needsAccess, error: f.error };
    if (!f.frontmost || f.matches === false) return { ok: false, notFront: true, title: f.title, error: 'Click inside "' + fileName + '" first so it is the active file, then try again.' };
    const before = await this.readClipboard();
    const k = await this.pressShortcut('c');
    if (!k.ok) return k;
    // Big pages take a moment to serialise; wait (max 30 s) for Figma layers to land on the clipboard.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await this.sleep(250);
      const now = await this.readClipboard();
      if (now.changeCount !== before.changeCount && !now.isFigma && Date.now() > deadline - 27000) {
        return { ok: false, notCopied: true, error: 'Cmd+C copied text instead of layers — the canvas did not get focus. Keep the plugin panel over the canvas (not over the side panels) and try again.' };
      }
      if (now.changeCount !== before.changeCount && now.isFigma) {
        if (fileKey && now.fileKey && now.fileKey !== fileKey) return { ok: false, error: 'The clipboard holds layers from a different file — click inside "' + fileName + '" and try again.' };
        return { ok: true, changeCount: now.changeCount, bytes: now.bytes, fileKey: now.fileKey };
      }
      if (now.changeCount === before.changeCount && Date.now() > deadline - 26000) {
        // Nothing at all after 4 s: Figma ignored Cmd+C (canvas did not get focus).
        return { ok: false, notCopied: true, error: 'Figma did not copy (the canvas did not get focus). Make sure the plugin panel sits over the canvas, then try again.' };
      }
    }
    return { ok: false, error: 'Copy did not finish within 30 seconds.' };
  }

  private async nativePaste(fileName: string, srcFileKey: string, changeCount: number, kind: 'figma' | 'h2d' = 'figma'): Promise<any> {
    const f = await this.nativeFront(fileName);
    if (f.needsAccess || f.error) return { ok: false, needsAccess: !!f.needsAccess, error: f.error };
    if (!f.frontmost || f.matches === false) return { ok: false, notFront: true, title: f.title, error: 'Click inside "' + fileName + '" first so it is the active file, then click Paste again.' };
    const clip = await this.readClipboard();
    if (kind === 'h2d' ? !clip.isH2d : !clip.isFigma) return { ok: false, clipboardChanged: true, error: 'The clipboard no longer holds Figma layers.' };
    if (srcFileKey && clip.fileKey && clip.fileKey !== srcFileKey) return { ok: false, clipboardChanged: true, error: 'The clipboard holds layers from another file.' };
    if (changeCount && clip.changeCount !== changeCount) return { ok: false, clipboardChanged: true, error: 'Something else was copied after the page was copied.' };
    const k = await this.pressShortcut('v');
    if (!k.ok) return k;
    return { ok: true };
  }

  /**
   * Handle HTTP requests on the same port as WebSocket.
   * Serves a JSON `/health` (also at `/`) endpoint with version and connected-file
   * info. No plugin-UI route exists — the plugin loads its own `ui.html` from disk
   * via the Figma plugin runtime; the legacy `/plugin/ui` bootloader endpoint was
   * removed in the Phase 3 cleanup.
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers for Figma plugin iframe (sandboxed, origin: null)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '/';

    try {
      if (this.handleFiGaptureRoute(req, res, url)) return;
      if (this.handleTransferRoute(req, res, url)) return;
    } catch (err) {
      logger.error({ err: String((err as any)?.message || err), url }, 'fiGapture/Transfer route failed');
      this.sendJson(res, 500, { error: String((err as any)?.message || err) });
      return;
    }

    // Health/version endpoint
    if (url === '/health' || url === '/') {
      const now = Date.now();
      const connectedClients = Array.from(this.clients.values()).filter(
        c => c.ws.readyState === WebSocket.OPEN && (now - c.lastPongAt) < 90000
      ).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: SERVER_VERSION,
        clients: this.clients.size,
        connectedClients,
        fiGaptureCaptures: this.fiGaptureCaptures.size,
        uptime: Math.floor((now - this._startedAt) / 1000),
      }));
      return;
    }

    // 404 for anything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /**
   * Start the HTTP + WebSocket server.
   * HTTP serves the plugin UI content; WebSocket handles plugin communication.
   */
  async start(): Promise<void> {
    if (this._isStarted) return;

    return new Promise((resolve, reject) => {
      let rejected = false;
      const rejectOnce = (error: any) => {
        if (!rejected) {
          rejected = true;
          reject(error);
        }
      };

      try {
        // Create HTTP server first — handles plugin UI requests
        this.httpServer = createHttpServer((req, res) => this.handleHttpRequest(req, res));

        // Attach WebSocket server to the HTTP server (shares the same port)
        this.wss = new WSServer({
          server: this.httpServer,
          maxPayload: 100 * 1024 * 1024, // 100MB — screenshots and large component data can be big
          verifyClient: (info, callback) => {
            // Mitigate Cross-Site WebSocket Hijacking (CSWSH):
            // Reject connections from unexpected browser origins.
            const origin = info.origin;
            // Exact match only — startsWith would let e.g.
            // https://www.figma.com.attacker.example through.
            const allowed =
              !origin ||                           // No origin — local process (e.g. Node.js client)
              origin === 'null' ||                  // Sandboxed iframe / Figma Desktop plugin UI
              origin === 'https://www.figma.com' ||
              origin === 'https://figma.com';
            if (allowed) {
              callback(true);
            } else {
              logger.warn({ origin }, 'Rejected WebSocket connection from unauthorized origin');
              callback(false, 403, 'Unauthorized Origin');
            }
          },
        });

        // Error handler for startup failures (EADDRINUSE, etc.)
        // Must be on BOTH httpServer and wss — the WSS re-emits HTTP server errors
        // and throws if no listener is attached.
        const onStartupError = (error: any) => {
          if (!this._isStarted) {
            try { if (this.wss) { this.wss.close(); this.wss = null; } } catch { /* ignore */ }
            try { if (this.httpServer) { this.httpServer.close(); this.httpServer = null; } } catch { /* ignore */ }
            rejectOnce(error);
          } else {
            logger.error({ error }, 'HTTP/WebSocket server error');
          }
        };

        this.httpServer.on('error', onStartupError);
        this.wss.on('error', onStartupError);

        // Start listening on the HTTP server (which also handles WS upgrades)
        this.httpServer.listen(this.options.port, this.options.host || 'localhost', () => {
          this._isStarted = true;
          this.startHeartbeat();
          logger.info(
            { port: this.options.port, host: this.options.host || 'localhost' },
            'WebSocket bridge server started (with HTTP plugin UI endpoint)'
          );
          resolve();
        });

        this.wss.on('connection', (ws: WebSocket) => {
          // Add to pending until FILE_INFO identifies the file
          const pendingTimeout = setTimeout(() => {
            if (this._pendingClients.has(ws)) {
              this._pendingClients.delete(ws);
              logger.warn('Pending WebSocket client timed out without sending FILE_INFO');
              ws.close(1000, 'File identification timeout');
            }
          }, 30000);
          this._pendingClients.set(ws, pendingTimeout);

          // Send server identity to the client for debugging and logging
          try {
            ws.send(JSON.stringify({
              type: 'SERVER_HELLO',
              data: {
                port: (this.wss!.address() as any)?.port,
                pid: process.pid,
                serverVersion: SERVER_VERSION,
                startedAt: this._startedAt,
              },
            }));
          } catch {
            // Non-critical — client will still work without SERVER_HELLO
          }

          logger.info(
            { totalClients: this.clients.size, pendingClients: this._pendingClients.size },
            'New WebSocket connection (pending file identification)'
          );

          ws.on('message', (data: import('ws').RawData) => {
            try {
              let text: string;
              if (typeof data === 'string') {
                text = data;
              } else if (Buffer.isBuffer(data)) {
                text = data.toString();
              } else if (Array.isArray(data)) {
                text = Buffer.concat(data).toString();
              } else {
                text = Buffer.from(data as ArrayBuffer).toString();
              }
              const message = JSON.parse(text);
              this.handleMessage(message, ws);
            } catch (error) {
              logger.error({ error }, 'Failed to parse WebSocket message');
            }
          });

          ws.on('close', (code: number, reason: Buffer) => {
            this.handleClientDisconnect(ws, code, reason.toString());
          });

          ws.on('error', (error: any) => {
            logger.error({ error }, 'WebSocket client error');
          });

          // Track pong responses for heartbeat-based liveness detection.
          // Browser WebSocket clients auto-respond to pings per RFC 6455 —
          // no plugin-side code changes needed.
          (ws as any).isAlive = true;
          ws.on('pong', () => {
            (ws as any).isAlive = true;
            // Update lastPongAt on the named client if identified
            const found = this.findClientByWs(ws);
            if (found) {
              found.client.lastPongAt = Date.now();
            }
          });
        });
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  /**
   * Find a named client connection by its WebSocket reference
   */
  private findClientByWs(ws: WebSocket): { fileKey: string; client: ClientConnection } | null {
    for (const [fileKey, client] of this.clients) {
      if (client.ws === ws) return { fileKey, client };
    }
    return null;
  }

  /**
   * Handle incoming message from a plugin UI WebSocket connection
   */
  private handleMessage(message: any, ws: WebSocket): void {
    // Response to a command we sent
    if (message.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;

      // Verify the response arrived on the socket belonging to the file the
      // command targeted — a matching id alone must not let a different
      // client resolve (or spoof) another file's request.
      const sender = this.findClientByWs(ws);
      const socketVerified = sender
        ? sender.fileKey === pending.targetFileKey
        // Pre-identification socket (no FILE_INFO yet): only safe when it is
        // unambiguous — exactly one socket connected to the server at all.
        : (this.wss?.clients.size ?? 0) === 1;

      if (!socketVerified) {
        logger.warn(
          {
            id: message.id,
            method: pending.method,
            senderFileKey: sender?.fileKey ?? null,
            targetFileKey: pending.targetFileKey,
          },
          'Ignoring response from unexpected socket (id matched, sender did not) — treating as unsolicited'
        );
        // Leave the pending request in place; fall through to unsolicited handling.
      } else {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(message.id);
        this.clearStall(pending.targetFileKey);

        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    // Reply to a request we already gave up on: the plugin finished it late.
    if (message.id && this.abandonedRequests.has(message.id)) {
      const abandoned = this.abandonedRequests.get(message.id)!;
      if (abandoned.ws === ws) {
        this.abandonedRequests.delete(message.id);
        this.clearStall(abandoned.targetFileKey);
        logger.info(
          {
            id: message.id,
            method: abandoned.method,
            fileKey: abandoned.targetFileKey,
            secondsAfterTimeout: Math.round((Date.now() - abandoned.timedOutAt) / 1000),
            failed: !!message.error,
          },
          'Plugin answered a request after it timed out; the result was discarded'
        );
        return;
      }
    }

    // Unsolicited data from plugin (FILE_INFO, events, forwarded data)
    if (message.type) {
      // FILE_INFO promotes pending clients to named clients
      if (message.type === 'FILE_INFO' && message.data) {
        this.handleFileInfo(message.data, ws);
      }

      // Buffer document changes for the specific file
      if (message.type === 'DOCUMENT_CHANGE' && message.data) {
        const found = this.findClientByWs(ws);
        if (found) {
          const entry: DocumentChangeEntry = {
            hasStyleChanges: message.data.hasStyleChanges,
            hasNodeChanges: message.data.hasNodeChanges,
            changedNodeIds: message.data.changedNodeIds || [],
            changeCount: message.data.changeCount || 0,
            timestamp: message.data.timestamp || Date.now(),
          };
          found.client.documentChanges.push(entry);
          if (found.client.documentChanges.length > this.documentChangeBufferSize) {
            found.client.documentChanges.shift();
          }
          found.client.lastActivity = Date.now();
        }
        this.emit('documentChange', { fileKey: found?.fileKey ?? null, ...message.data });
      }

      // v1.25.0: buffer description/annotation changes for the specific file.
      // These are the diff-engine blind spots that Figma REST doesn't expose;
      // the diff engine consults this buffer when correlating to a version
      // range, so changes made while the plugin was connected become visible.
      if (message.type === 'METADATA_CHANGE' && message.data) {
        const found = this.findClientByWs(ws);
        if (found) {
          const changes: any[] = Array.isArray(message.data.changes) ? message.data.changes : [];
          for (const c of changes) {
            if (!c || typeof c.node_id !== 'string' || !c.field) continue;
            const entry: MetadataChangeEntry = {
              node_id: c.node_id,
              node_name: c.node_name ?? null,
              node_type: c.node_type ?? null,
              field: c.field === 'annotations' ? 'annotations' : 'description',
              new_value: c.new_value,
              timestamp: typeof c.timestamp === 'number' ? c.timestamp : Date.now(),
            };
            found.client.metadataChanges.push(entry);
            if (found.client.metadataChanges.length > this.documentChangeBufferSize) {
              found.client.metadataChanges.shift();
            }
          }
          found.client.lastActivity = Date.now();
        }
        this.emit('metadataChange', { fileKey: found?.fileKey ?? null, changes: message.data.changes });
      }

      // Track selection changes — user interaction makes this the active file
      if (message.type === 'SELECTION_CHANGE' && message.data) {
        const found = this.findClientByWs(ws);
        if (found) {
          found.client.selection = message.data as SelectionInfo;
          found.client.lastActivity = Date.now();
          if (!this._targetLocked) this._activeFileKey = found.fileKey;
        }
        this.emit('selectionChange', { fileKey: found?.fileKey ?? null, ...message.data });
      }

      // Track page changes — user interaction makes this the active file
      if (message.type === 'PAGE_CHANGE' && message.data) {
        const found = this.findClientByWs(ws);
        if (found) {
          found.client.fileInfo.currentPage = message.data.pageName;
          found.client.fileInfo.currentPageId = message.data.pageId || null;
          found.client.lastActivity = Date.now();
          if (!this._targetLocked) this._activeFileKey = found.fileKey;
        }
        this.emit('pageChange', { fileKey: found?.fileKey ?? null, ...message.data });
      }

      // Capture console logs for the specific file
      if (message.type === 'CONSOLE_CAPTURE' && message.data) {
        const found = this.findClientByWs(ws);
        const data = message.data;
        const entry: ConsoleLogEntry = {
          timestamp: data.timestamp || Date.now(),
          level: data.level || 'log',
          message: typeof data.message === 'string' ? data.message.substring(0, 1000) : String(data.message),
          args: Array.isArray(data.args) ? data.args.slice(0, 10) : [],
          source: 'plugin',
        };
        if (found) {
          found.client.consoleLogs.push(entry);
          if (found.client.consoleLogs.length > this.consoleBufferSize) {
            found.client.consoleLogs.shift();
          }
          found.client.lastActivity = Date.now();
        }
        this.emit('consoleLog', entry);
      }

      this.emit('pluginMessage', message);
      return;
    }

    logger.debug({ message }, 'Unhandled WebSocket message');
  }

  /**
   * Handle FILE_INFO message — promotes pending clients to named clients.
   * This is the critical multi-client identification step: each plugin reports
   * its fileKey on connect, allowing the server to track multiple files.
   */
  private handleFileInfo(data: any, ws: WebSocket): void {
    const fileKey = data.fileKey || null;

    if (!fileKey) {
      logger.warn('FILE_INFO received without fileKey — client remains pending');
      return;
    }

    // Remove from pending clients (cancel identification timeout)
    const pendingTimeout = this._pendingClients.get(ws);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      this._pendingClients.delete(ws);
    }

    // Check if this ws was already registered under a different fileKey
    // (shouldn't happen in practice — each plugin instance is per-file)
    const previousEntry = this.findClientByWs(ws);
    if (previousEntry && previousEntry.fileKey !== fileKey) {
      this.clients.delete(previousEntry.fileKey);
      if (this._activeFileKey === previousEntry.fileKey) {
        this._activeFileKey = null;
        // The pinned plugin navigated to a different file — the old pin is
        // meaningless, so release it rather than silently re-pinning the new file.
        this._targetLocked = false;
      }
      // In-flight commands to the old file can never receive a response now —
      // reject them immediately instead of leaving them to hang until timeout
      // (mirrors the same-file replacement path below).
      this.rejectPendingRequestsForFile(previousEntry.fileKey, 'Plugin switched files');
      logger.info(
        { oldFileKey: previousEntry.fileKey, newFileKey: fileKey },
        'WebSocket client switched files'
      );
      this.emit('fileDisconnected', {
        fileKey: previousEntry.fileKey,
        fileName: previousEntry.client.fileInfo.fileName,
      });
    }

    // If same fileKey already connected with a DIFFERENT ws, clean up old connection
    const existing = this.clients.get(fileKey);
    if (existing && existing.ws !== ws) {
      logger.info({ fileKey }, 'Replacing existing connection for same file');
      if (existing.gracePeriodTimer) {
        clearTimeout(existing.gracePeriodTimer);
      }
      // Reject any in-flight commands before replacing — the old ws close event
      // won't find this fileKey in the map after overwrite, so pending requests
      // would hang until timeout otherwise.
      this.rejectPendingRequestsForFile(fileKey, 'Connection replaced by same file reconnection');
      if (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING) {
        existing.ws.close(1000, 'Replaced by same file reconnection');
      }
    }

    // Version handshake: the plugin reports its code.js version in FILE_INFO.
    // Figma caches plugin files at the app level, so a version mismatch means
    // the user is running stale plugin code and must re-import manifest.json.
    // A missing version means the plugin predates version reporting — also stale.
    // Compared against the BUNDLED plugin version (what a re-import would
    // install), NOT the server's package version — server-only releases don't
    // change the plugin files, so they must not trigger the re-import banner.
    const bundledPluginVersion =
      this.options.bundledPluginVersion ?? BUNDLED_PLUGIN_VERSION;
    const pluginVersion: string | null = data.pluginVersion || null;
    const pluginUpdateAvailable = computePluginUpdateAvailable(
      pluginVersion,
      bundledPluginVersion
    );
    if (pluginUpdateAvailable) {
      logger.warn(
        { fileKey, pluginVersion, bundledPluginVersion, serverVersion: SERVER_VERSION },
        'Imported plugin version differs from the plugin files bundled with this server — re-import manifest.json to update'
      );
      try {
        ws.send(
          JSON.stringify({
            type: 'PLUGIN_UPDATE_AVAILABLE',
            serverVersion: SERVER_VERSION,
            bundledPluginVersion,
            pluginVersion,
          })
        );
      } catch {
        // Non-critical notification — never let it disrupt registration
      }
    }

    // Create client connection (preserve per-file state from previous connection of same file)
    this.clients.set(fileKey, {
      ws,
      fileInfo: {
        fileName: data.fileName,
        fileKey,
        currentPage: data.currentPage,
        currentPageId: data.currentPageId || null,
        editorType: data.editorType || 'figma',
        connectedAt: Date.now(),
        pluginVersion,
        pluginUpdateAvailable,
      },
      selection: existing?.selection || null,
      documentChanges: existing?.documentChanges || [],
      metadataChanges: existing?.metadataChanges || [],
      consoleLogs: existing?.consoleLogs || [],
      lastActivity: Date.now(),
      lastPongAt: Date.now(),
      gracePeriodTimer: null,
    });

    // Most recently connected file becomes active (user just opened the plugin there).
    // On bulk reconnect the order is non-deterministic, but the first user interaction
    // (SELECTION_CHANGE or PAGE_CHANGE) will correct the active file immediately.
    // Skip when the target is pinned so a new or reconnecting plugin can't steal it.
    // Invariant: a locked target always has an active file — every path that nulls
    // _activeFileKey also releases the lock — so there is no "locked but nothing
    // active" case to re-adopt here, and a crash-reconnect within the grace window
    // keeps its active key (the grace timer is cleared before it can fire).
    if (!this._targetLocked) {
      this._activeFileKey = fileKey;
    }

    logger.info(
      {
        fileName: data.fileName,
        fileKey,
        totalClients: this.clients.size,
        isActive: this._activeFileKey === fileKey,
      },
      'File connected via WebSocket'
    );

    // Emit both events for backward compat and new features
    this.emit('connected');
    this.emit('fileConnected', { fileKey, fileName: data.fileName });
  }

  /**
   * Handle a client WebSocket disconnecting.
   * Starts a grace period before removing the client to allow reconnection.
   */
  private handleClientDisconnect(ws: WebSocket, code: number, reason: string): void {
    // Check if it was a pending client (never identified itself)
    const pendingTimeout = this._pendingClients.get(ws);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      this._pendingClients.delete(ws);
      logger.info('Pending WebSocket client disconnected before file identification');
      this.emit('disconnected');
      return;
    }

    // Find which named client this belongs to
    const found = this.findClientByWs(ws);
    if (!found) {
      logger.debug('Unknown WebSocket client disconnected');
      this.emit('disconnected');
      return;
    }

    const { fileKey, client } = found;
    logger.info(
      { fileKey, fileName: client.fileInfo.fileName, code, reason },
      'File disconnected from WebSocket'
    );

    // Start grace period — keep state but clean up if not reconnected
    client.gracePeriodTimer = setTimeout(() => {
      client.gracePeriodTimer = null;
      // Only remove if the client in the map is still the disconnected one
      const current = this.clients.get(fileKey);
      if (current && current.ws === ws) {
        this.clients.delete(fileKey);
        this.rejectPendingRequestsForFile(fileKey, 'WebSocket client disconnected');

        // If active file disconnected, switch to another connected file.
        // Release any lock — the pinned file is gone, so honoring the lock
        // would strand every command against a dead connection.
        if (this._activeFileKey === fileKey) {
          this._activeFileKey = null;
          if (this._targetLocked) {
            this._targetLocked = false;
            logger.info({ fileKey }, 'Target lock released — locked file disconnected');
          }
          for (const [fk, c] of this.clients) {
            if (c.ws.readyState === WebSocket.OPEN) {
              this._activeFileKey = fk;
              break;
            }
          }
        }

        this.emit('fileDisconnected', { fileKey, fileName: client.fileInfo.fileName });
      }
    }, 5000);

    this.emit('disconnected');
  }

  /**
   * Send a command to a plugin UI and wait for the response.
   * By default targets the active file. Pass targetFileKey to target a specific file.
   */
  sendCommand(method: string, params: Record<string, any> = {}, timeoutMs = 15000, targetFileKey?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const fileKey = targetFileKey || this._activeFileKey;

      if (!fileKey) {
        reject(new Error('No active file connected. Make sure the Desktop Bridge plugin is open in Figma.'));
        return;
      }

      const client = this.clients.get(fileKey);
      if (!client || client.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('No WebSocket client connected. Make sure the Desktop Bridge plugin is open in Figma.'));
        return;
      }

      const stall = this.getStall(fileKey, client.ws);
      if (stall) {
        const busyFor = Math.round((Date.now() - stall.sentAt) / 1000);
        reject(new Error(
          `The Desktop Bridge plugin is still busy with ${stall.method}, sent ${busyFor}s ago, ` +
          `so ${method} was not sent. Figma can't interrupt a running plugin script, and commands ` +
          `sent now would wait behind it (and could run long after you gave up on them). ` +
          `Wait for it to finish, or close and reopen the Desktop Bridge plugin to stop it.`
        ));
        return;
      }

      const id = `ws_${++this.requestIdCounter}_${Date.now()}`;
      const sentAt = Date.now();
      // An earlier request to this file that timed out and is still unanswered:
      // if this one times out too, the plugin is stuck rather than slow.
      const queuedBehind = this.oldestAbandonedFor(fileKey, client.ws);

      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          this.pruneAbandoned();
          this.abandonedRequests.set(id, {
            method,
            sentAt,
            timedOutAt: Date.now(),
            targetFileKey: fileKey,
            ws: client.ws,
          });
          let detail = '';
          if (queuedBehind && this.abandonedRequests.has(queuedBehind.id)) {
            const earlier = queuedBehind.request;
            this.stalledFiles.set(fileKey, {
              method: earlier.method,
              sentAt: earlier.sentAt,
              since: Date.now(),
              ws: client.ws,
            });
            detail =
              ` The plugin is still busy with an earlier ${earlier.method} sent ` +
              `${Math.round((Date.now() - earlier.sentAt) / 1000)}s ago that also timed out. ` +
              `Figma can't interrupt a running plugin script, so commands wait behind it. ` +
              `Commands to this file will now fail immediately until it finishes, or until ` +
              `the Desktop Bridge plugin is closed and reopened.`;
            logger.warn(
              { fileKey, method, blockedBy: earlier.method, blockedForSeconds: Math.round((Date.now() - earlier.sentAt) / 1000) },
              'Plugin is not answering: a second request timed out behind an earlier one'
            );
          } else if (method === 'EXECUTE_CODE') {
            detail =
              ' The script may still be running in Figma; commands sent before it finishes will wait behind it.';
          }
          reject(new Error(`WebSocket command ${method} timed out after ${timeoutMs}ms.${detail}`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        method,
        timeoutId,
        createdAt: Date.now(),
        targetFileKey: fileKey,
      });

      const message = JSON.stringify({ id, method, params });
      try {
        client.ws.send(message);
      } catch (sendError) {
        this.pendingRequests.delete(id);
        clearTimeout(timeoutId);
        reject(new Error(`Failed to send WebSocket command ${method}: ${sendError instanceof Error ? sendError.message : String(sendError)}`));
        return;
      }
      client.lastActivity = Date.now();

      logger.debug({ id, method, fileKey }, 'Sent WebSocket command');
    });
  }

  /**
   * Start the heartbeat interval that pings all connected clients every 30s.
   * Detects silently dropped connections (e.g., macOS sleep, network change)
   * that the OS TCP keepalive would take 30-120s to catch.
   * Browser WebSocket clients auto-respond to pings per RFC 6455.
   */
  private startHeartbeat(): void {
    this._heartbeatInterval = setInterval(() => {
      if (!this.wss) return;
      for (const ws of this.wss.clients) {
        if ((ws as any).isAlive === false) {
          logger.info('Terminating unresponsive WebSocket client (missed heartbeat pong)');
          ws.terminate();
          continue;
        }
        (ws as any).isAlive = false;
        ws.ping();
      }
    }, 30000);
  }

  /**
   * Check if any named client is connected (transport availability check).
   * Checks both socket readyState and heartbeat pong freshness to avoid
   * reporting phantom-connected state on silently dropped connections.
   */
  isClientConnected(): boolean {
    const now = Date.now();
    for (const [, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN && (now - client.lastPongAt) < 90000) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether the server has been started
   */
  isStarted(): boolean {
    return this._isStarted;
  }

  /**
   * Get the bound address info (port, host, family).
   * Only available after the server has started listening.
   * Returns the actual port — critical when using port 0 for OS-assigned ports.
   */
  address(): import('net').AddressInfo | null {
    // Use the HTTP server's address (which is the actual listening socket)
    if (this.httpServer) {
      const addr = this.httpServer.address();
      if (typeof addr === 'string' || !addr) return null;
      return addr as import('net').AddressInfo;
    }
    // Fallback for backward compat
    if (!this.wss) return null;
    const addr = this.wss.address();
    if (typeof addr === 'string') return null;
    return addr as import('net').AddressInfo;
  }

  // ============================================================================
  // Active file getters (backward compatible — return active file's state)
  // ============================================================================

  /**
   * Get info about the currently active Figma file.
   * Returns null if no file is active or connected.
   */
  getConnectedFileInfo(): ConnectedFileInfo | null {
    if (!this._activeFileKey) return null;
    const client = this.clients.get(this._activeFileKey);
    return client?.fileInfo || null;
  }

  /**
   * Get the current user selection in the active Figma file
   */
  getCurrentSelection(): SelectionInfo | null {
    if (!this._activeFileKey) return null;
    const client = this.clients.get(this._activeFileKey);
    return client?.selection || null;
  }

  /**
   * Get buffered document change events from the active file
   */
  getDocumentChanges(options?: {
    count?: number;
    since?: number;
  }): DocumentChangeEntry[] {
    if (!this._activeFileKey) return [];
    const client = this.clients.get(this._activeFileKey);
    if (!client) return [];

    let filtered = [...client.documentChanges];

    if (options?.since !== undefined) {
      filtered = filtered.filter((e) => e.timestamp >= options.since!);
    }

    if (options?.count !== undefined && options.count > 0) {
      filtered = filtered.slice(-options.count);
    }

    return filtered;
  }

  /**
   * Clear document change buffer for the active file
   */
  clearDocumentChanges(): number {
    if (!this._activeFileKey) return 0;
    const client = this.clients.get(this._activeFileKey);
    if (!client) return 0;
    const count = client.documentChanges.length;
    client.documentChanges = [];
    return count;
  }

  /**
   * v1.25.0: Get buffered description/annotation change events for a file.
   *
   * Used by `figma_diff_versions` to surface changes that Figma REST doesn't
   * expose. The diff engine passes a time window (from-version → to-version
   * `last_modified` timestamps converted to Unix ms) and optional scoping by
   * node IDs.
   *
   * Defaults to the active file if `fileKey` is omitted.
   */
  getMetadataChanges(options?: {
    fileKey?: string;
    since?: number;
    until?: number;
    nodeIds?: string[];
  }): MetadataChangeEntry[] {
    const fileKey = options?.fileKey ?? this._activeFileKey;
    if (!fileKey) return [];
    const client = this.clients.get(fileKey);
    if (!client) return [];

    let filtered = [...client.metadataChanges];

    if (options?.since !== undefined) {
      filtered = filtered.filter((e) => e.timestamp >= options.since!);
    }
    if (options?.until !== undefined) {
      filtered = filtered.filter((e) => e.timestamp <= options.until!);
    }
    if (options?.nodeIds && options.nodeIds.length > 0) {
      const set = new Set(options.nodeIds);
      filtered = filtered.filter((e) => set.has(e.node_id));
    }

    return filtered;
  }

  /**
   * v1.25.0: Clear metadata-change buffer for the active file.
   */
  clearMetadataChanges(): number {
    if (!this._activeFileKey) return 0;
    const client = this.clients.get(this._activeFileKey);
    if (!client) return 0;
    const count = client.metadataChanges.length;
    client.metadataChanges = [];
    return count;
  }

  /**
   * Get console logs from the active file with optional filtering
   */
  getConsoleLogs(options?: {
    count?: number;
    level?: ConsoleLogEntry['level'] | 'all';
    since?: number;
  }): ConsoleLogEntry[] {
    if (!this._activeFileKey) return [];
    const client = this.clients.get(this._activeFileKey);
    if (!client) return [];

    let filtered = [...client.consoleLogs];

    if (options?.since !== undefined) {
      filtered = filtered.filter((log) => log.timestamp >= options.since!);
    }

    if (options?.level && options.level !== 'all') {
      filtered = filtered.filter((log) => log.level === options.level);
    }

    if (options?.count !== undefined && options.count > 0) {
      filtered = filtered.slice(-options.count);
    }

    return filtered;
  }

  /**
   * Clear console log buffer for the active file
   */
  clearConsoleLogs(): number {
    if (!this._activeFileKey) return 0;
    const client = this.clients.get(this._activeFileKey);
    if (!client) return 0;
    const count = client.consoleLogs.length;
    client.consoleLogs = [];
    return count;
  }

  /**
   * Get console monitoring status for the active file
   */
  getConsoleStatus() {
    const client = this._activeFileKey ? this.clients.get(this._activeFileKey) : null;
    const logs = client?.consoleLogs || [];

    return {
      isMonitoring: !!(client && client.ws.readyState === WebSocket.OPEN),
      anyClientConnected: this.isClientConnected(),
      logCount: logs.length,
      bufferSize: this.consoleBufferSize,
      workerCount: 0,
      oldestTimestamp: logs[0]?.timestamp,
      newestTimestamp: logs[logs.length - 1]?.timestamp,
    };
  }

  // ============================================================================
  // Multi-client methods
  // ============================================================================

  /**
   * Get info about all connected Figma files.
   * Returns an array of ConnectedFileInfo for each file with an active WebSocket.
   */
  getConnectedFiles(): (ConnectedFileInfo & { isActive: boolean })[] {
    const files: (ConnectedFileInfo & { isActive: boolean })[] = [];
    for (const [fileKey, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        files.push({
          ...client.fileInfo,
          isActive: fileKey === this._activeFileKey,
        });
      }
    }
    return files;
  }

  /**
   * Get the last pong timestamp for the active client.
   * Returns null if no active client or no pong received yet.
   */
  getActiveClientLastPongAt(): number | null {
    if (!this._activeFileKey) return null;
    const client = this.clients.get(this._activeFileKey);
    return client?.lastPongAt ?? null;
  }

  /**
   * Set the active file by fileKey. Returns true if the file is connected.
   *
   * Pass `lock: true` to pin the target so subsequent connections, reconnects,
   * and user interaction won't move it. Any explicit switch resets the lock to
   * the value passed here (default: unlocked), so switching without `lock`
   * releases a prior lock.
   */
  setActiveFile(fileKey: string, lock = false): boolean {
    const client = this.clients.get(fileKey);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      this._activeFileKey = fileKey;
      this._targetLocked = lock;
      logger.info({ fileKey, fileName: client.fileInfo.fileName, locked: lock }, 'Active file switched');
      this.emit('activeFileChanged', { fileKey, fileName: client.fileInfo.fileName, locked: lock });
      return true;
    }
    return false;
  }

  /**
   * Get the currently active file's key
   */
  getActiveFileKey(): string | null {
    return this._activeFileKey;
  }

  /**
   * Pin the current active file so connections, reconnects, and user
   * interaction won't move the target. Returns false if no file is active.
   */
  lockTarget(): boolean {
    if (!this._activeFileKey) return false;
    this._targetLocked = true;
    logger.info({ fileKey: this._activeFileKey }, 'Target locked');
    return true;
  }

  /** Release the target lock; the active file resumes following user activity. */
  unlockTarget(): void {
    this._targetLocked = false;
    logger.info({ fileKey: this._activeFileKey }, 'Target unlocked');
  }

  /** Whether the active file is currently pinned. */
  isTargetLocked(): boolean {
    return this._targetLocked;
  }

  /**
   * Get the editor type of the currently active file.
   * Returns 'figma' if no file is connected or editorType wasn't reported.
   */
  getEditorType(): 'figma' | 'figjam' | 'dev' {
    if (!this._activeFileKey) return 'figma';
    const client = this.clients.get(this._activeFileKey);
    return client?.fileInfo?.editorType || 'figma';
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Reject pending requests that were sent to a specific file
   */
  /** The file's stall, if it still applies to this socket and hasn't expired. */
  private getStall(fileKey: string, ws: WebSocket): StalledFile | null {
    const stall = this.stalledFiles.get(fileKey);
    if (!stall) return null;
    if (stall.ws !== ws || Date.now() - stall.since > STALL_MAX_MS) {
      this.stalledFiles.delete(fileKey);
      return null;
    }
    return stall;
  }

  private clearStall(fileKey: string): void {
    if (this.stalledFiles.delete(fileKey)) {
      logger.info({ fileKey }, 'Plugin is answering again');
    }
  }

  private oldestAbandonedFor(fileKey: string, ws: WebSocket): { id: string; request: AbandonedRequest } | null {
    let oldest: { id: string; request: AbandonedRequest } | null = null;
    for (const [id, request] of this.abandonedRequests) {
      if (request.targetFileKey !== fileKey || request.ws !== ws) continue;
      if (Date.now() - request.timedOutAt > ABANDONED_REQUEST_TTL_MS) continue;
      if (!oldest || request.sentAt < oldest.request.sentAt) oldest = { id, request };
    }
    return oldest;
  }

  private pruneAbandoned(): void {
    const now = Date.now();
    for (const [id, request] of this.abandonedRequests) {
      if (now - request.timedOutAt > ABANDONED_REQUEST_TTL_MS || request.ws.readyState !== WebSocket.OPEN) {
        this.abandonedRequests.delete(id);
      }
    }
  }

  private rejectPendingRequestsForFile(fileKey: string, reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.targetFileKey === fileKey) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(reason));
        this.pendingRequests.delete(id);
      }
    }
  }

  /**
   * Reject all pending requests (used during shutdown)
   */
  private rejectPendingRequests(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  /**
   * Stop the server and clean up all connections
   */
  async stop(): Promise<void> {
    // Clear heartbeat interval
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }

    // Clear all per-client grace period timers
    for (const [, client] of this.clients) {
      if (client.gracePeriodTimer) {
        clearTimeout(client.gracePeriodTimer);
        client.gracePeriodTimer = null;
      }
    }

    // Clear pending client identification timeouts
    for (const [, timeout] of this._pendingClients) {
      clearTimeout(timeout);
    }
    this._pendingClients.clear();

    this.rejectPendingRequests('WebSocket server shutting down');
    this.abandonedRequests.clear();
    this.stalledFiles.clear();

    // Terminate all connected clients so wss.close() resolves promptly
    if (this.wss) {
      for (const ws of this.wss.clients) {
        ws.terminate();
      }
    }
    this.clients.clear();
    this._activeFileKey = null;
    this._targetLocked = false;

    // Close WS server first (handles WebSocket connections)
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
    }

    // Then close HTTP server (releases the port)
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    this._isStarted = false;
    logger.info('WebSocket bridge server stopped');
  }
}
