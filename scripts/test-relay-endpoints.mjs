// Regression test for the FigShot + Transfer relay routes in src/core/websocket-server.ts.
// Exercises every /transfer/* and /figshot/* endpoint plus the ERR_HTTP_HEADERS_SENT crash case.
// Uses a throwaway HOME, so it never touches your real ~/Documents/FigShot-Transfer-Backups.
//
// Usage (after `npm run build:local`):
//   node scripts/test-relay-endpoints.mjs            # tests dist/core/websocket-server.js on port 9333
//   node scripts/test-relay-endpoints.mjs <dist-module-path> <port>
import { mkdirSync, mkdtempSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
process.env.HOME = mkdtempSync(join(tmpdir(), 'relay-test-')); // must be set before the server module loads
const here = dirname(fileURLToPath(import.meta.url));
const [,, modArg, portArg] = process.argv;
const modPath = pathToFileURL(resolve(modArg || join(here, '..', 'dist', 'core', 'websocket-server.js'))).href;
const { FigmaWebSocketServer } = await import(modPath);
const port = Number(portArg || 9333);
let crashes = [];
process.on('uncaughtException', e => crashes.push(e.code || e.message));
process.on('unhandledRejection', e => crashes.push('rejection:' + (e && (e.code || e.message))));
const srv = new FigmaWebSocketServer({ port, host: '127.0.0.1' });
await srv.start();
const B = `http://127.0.0.1:${port}`;
const results = [];
async function t(name, method, path, body, check) {
  let status, txt;
  try {
    const r = await fetch(B + path, { signal: AbortSignal.timeout(10000), method, body, headers: body ? { 'Content-Type': 'application/json' } : {} });
    status = r.status; txt = Buffer.from(await r.arrayBuffer());
  } catch (e) { status = 'ERR ' + (e.cause?.code || e.message); txt = Buffer.alloc(0); }
  let ok; try { ok = check(status, txt); } catch { ok = false; }
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  [${status}]`);
}
const J = b => JSON.parse(b.toString());
await t('health', 'GET', '/health', null, s => s === 200);
await t('transfer ping', 'GET', '/transfer/ping', null, (s, b) => s === 200 && J(b).ok);
await t('transfer files', 'GET', '/transfer/files', null, (s, b) => s === 200 && Array.isArray(J(b).files));
await t('create job', 'POST', '/transfer/jobs', JSON.stringify({ id: 'job_test1', destFileKey: 'd1' }), (s, b) => s === 200 && J(b).ok);
await t('create job bad id', 'POST', '/transfer/jobs', JSON.stringify({ id: '!' }), s => s === 400);
await t('create job bad JSON', 'POST', '/transfer/jobs', '{not json', s => s === 500);
await t('list jobs', 'GET', '/transfer/jobs', null, (s, b) => s === 200 && J(b).jobs.some(j => j.id === 'job_test1'));
await t('list jobs ?dest', 'GET', '/transfer/jobs?dest=zzz', null, (s, b) => s === 200 && J(b).jobs.length === 0);
await t('get job', 'GET', '/transfer/jobs/job_test1', null, (s, b) => s === 200 && J(b).state === 'exporting');
await t('cancel job', 'POST', '/transfer/jobs/job_test1', JSON.stringify({ state: 'cancelled' }), (s, b) => s === 200 && J(b).state === 'cancelled');
await t('late chunk cannot un-cancel', 'POST', '/transfer/jobs/job_test1', JSON.stringify({ state: 'rebuilding' }), (s, b) => s === 200 && J(b).state === 'cancelled');
await t('resume un-cancels', 'POST', '/transfer/jobs/job_test1', JSON.stringify({ state: 'rebuilding', resume: true }), (s, b) => s === 200 && J(b).state === 'rebuilding');
await t('patch unknown job', 'POST', '/transfer/jobs/nojob', '{}', s => s === 404);
await t('put page', 'PUT', '/transfer/jobs/job_test1/pages/p1', JSON.stringify({ nodes: [1, 2, 3] }), (s, b) => s === 200 && J(b).ok);
await t('get page (memory)', 'GET', '/transfer/jobs/job_test1/pages/p1', null, (s, b) => s === 200 && J(b).nodes.length === 3);
await t('put image', 'PUT', '/transfer/jobs/job_test1/img/abcdef1234', 'BINARYDATA', (s, b) => s === 200);
await t('get image (memory)', 'GET', '/transfer/jobs/job_test1/img/abcdef1234', null, (s, b) => s === 200 && b.toString() === 'BINARYDATA');
srv.transferMemoryPages.clear(); srv.transferMemoryImages.clear(); srv.transferMemoryJobs.clear();
await t('get page (disk checkpoint)', 'GET', '/transfer/jobs/job_test1/pages/p1', null, (s, b) => s === 200 && J(b).nodes.length === 3);
await t('get image (disk checkpoint)', 'GET', '/transfer/jobs/job_test1/img/abcdef1234', null, (s, b) => s === 200 && b.toString() === 'BINARYDATA');
await t('get job (disk checkpoint)', 'GET', '/transfer/jobs/job_test1', null, (s, b) => s === 200 && J(b).state === 'rebuilding');
await t('list jobs (disk)', 'GET', '/transfer/jobs', null, (s, b) => s === 200 && J(b).jobs.some(j => j.id === 'job_test1'));
await t('missing page 404', 'GET', '/transfer/jobs/job_test1/pages/nope', null, s => s === 404);
await t('missing image 404', 'GET', '/transfer/jobs/job_test1/img/00000000', null, s => s === 404);
await t('delete job', 'DELETE', '/transfer/jobs/job_test1', null, (s, b) => s === 200 && J(b).ok);
await t('transfer unknown route', 'GET', '/transfer/nothing', null, s => s === 404);
await t('figshot post capture', 'POST', '/figshot/captures', JSON.stringify({ id: 'cap1', key: 'k', url: 'https://x', title: 'X', slices: [1], design: { a: 1 } }), (s, b) => s === 200 && J(b).ok);
await t('figshot list', 'GET', '/figshot/captures', null, (s, b) => s === 200 && J(b).captures[0].sliceCount === 1);
await t('figshot get', 'GET', '/figshot/captures/cap1', null, (s, b) => s === 200 && J(b).title === 'X');
await t('figshot get design', 'GET', '/figshot/captures/cap1?part=design', null, (s, b) => s === 200 && J(b).design.a === 1);
await t('figshot bad JSON', 'POST', '/figshot/captures', '{bad', s => s === 500);
await t('figshot delete', 'DELETE', '/figshot/captures/cap1', null, (s, b) => s === 200);
await t('figshot get missing', 'GET', '/figshot/captures/cap1', null, s => s === 404);
// --- The crash scenario: checkpoint file exists but can't be read ---
const jd = join(homedir(), 'Documents', 'FigShot-Transfer-Backups', 'job_crash');
mkdirSync(join(jd, 'page-p1.json'), { recursive: true });
mkdirSync(join(jd, 'images', 'abcdef1234.bin'), { recursive: true });
await t('CRASH CASE: unreadable page checkpoint', 'GET', '/transfer/jobs/job_crash/pages/p1', null, s => typeof s === 'number');
await new Promise(r => setTimeout(r, 200));
await t('CRASH CASE: unreadable image checkpoint', 'GET', '/transfer/jobs/job_crash/img/abcdef1234', null, s => typeof s === 'number');
await new Promise(r => setTimeout(r, 200));
// Accessibility check is read-only (never clicks). When access is missing it must name the
// program to switch on (the node binary), since Claude's helper disclaims responsibility.
await t('native check reports access state', 'GET', '/transfer/native/check', null, (s, b) => {
  const r = J(b); return s === 200 && typeof r.ok === 'boolean' && (r.ok || (r.needsAccess === true && /node/.test(r.accessApp || '')));
});
await t('server still alive after errors', 'GET', '/transfer/ping', null, s => s === 200);
console.log(results.join('\n'));
console.log(`\nServer crashes (uncaught errors): ${crashes.length}${crashes.length ? '  -> ' + crashes.join(', ') : ''}`);
console.log(`Passed ${results.filter(r => r.startsWith('PASS')).length}/${results.length}`);
await srv.stop().catch(() => {});
process.exit(crashes.length || results.some(r => r.startsWith('FAIL')) ? 1 : 0);
