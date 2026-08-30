/* Testlauf: startet für JEDE Suite einen frischen Server mit eigenem
 * Datenverzeichnis, damit die Suiten sich nicht gegenseitig beeinflussen
 * (Gästenamen, Zähler und Auszeichnungen sind zustandsabhängig).
 *
 * Aufruf:  npm test
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChecker, wait } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const BASE_PORT = Number(process.env.TEST_PORT || 3199);
const KEY = 'test-schluessel';

const SUITES = ['./suite-exif.mjs', './suite-api.mjs', './suite-queue.mjs', './suite-features.mjs', './suite-archive.mjs', './suite-consistency.mjs', './suite-nachbereitung.mjs', './suite-kategorien.mjs'];

async function startServer(port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fotowand-test-'));
  const logs = [];
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, MOD_KEY: KEY, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw new Error('Server beendet:\n' + logs.join(''));
    try {
      if ((await fetch(base + '/api/health')).ok) break;
    } catch { /* noch nicht bereit */ }
    await wait(250);
    if (i === 59) throw new Error('Server nicht erreichbar:\n' + logs.join(''));
  }

  return {
    base,
    logs,
    dataDir,
    async stop() {
      if (proc.exitCode === null) {
        await new Promise((res) => { proc.once('exit', res); proc.kill(); });
      }
      // Kurz warten: SQLite gibt die Datei unter Windows verzögert frei.
      await wait(200);
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    },
  };
}

const results = [];
const ok = makeChecker(results);
let broke = null;

for (let i = 0; i < SUITES.length; i++) {
  const mod = await import(SUITES[i]);
  console.log(`\n\x1b[1m${mod.name}\x1b[0m`);
  let srv;
  try {
    srv = await startServer(BASE_PORT + i);
    await mod.default({ base: srv.base, key: KEY, ok, dataDir: srv.dataDir });
  } catch (e) {
    broke = e;
    console.error('  \x1b[31mABBRUCH\x1b[0m ' + e.message);
  } finally {
    if (srv) await srv.stop().catch(() => {});
  }
  if (broke) break;
}

const failed = results.filter((r) => !r.passed);
console.log(`\n  ${results.length - failed.length} von ${results.length} bestanden`);
if (failed.length) {
  console.log('\n  Fehlgeschlagen:');
  failed.forEach((f) => console.log('   - ' + f.name + (f.extra ? '  ' + f.extra : '')));
}
process.exit(failed.length || broke ? 1 : 0);
