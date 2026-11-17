// CLI entry: node src/server.mjs [--port N]   (0 = the system picks a free port; TOWER_PORT also works)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = await loadConfig({ root });
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

if (!LOOPBACK.has(cfg.host)) {
  console.warn(
    `Warnung: host ist ${cfg.host}. Jeder, der diese Adresse erreicht, liest /api/state ` +
      `(Ordner, Titel, Fragen der Sessions). Mit der Vorgabe 127.0.0.1 lauscht der Daemon nur lokal.`,
  );
}

const server = createApp(cfg);
server.on('error', (err) => {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
});
// Print the real port: with `--port 0` it is only known after binding.
server.listen(cfg.port, cfg.host, () => {
  console.log(`Agent Tower -> http://127.0.0.1:${server.address().port}   (PID ${process.pid})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
