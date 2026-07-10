#!/usr/bin/env tsx
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import next from 'next';
import { WebSocketServer } from 'ws';
import type { ClientMessage } from '../shared/schema';
import { resolveConfig } from '../server/config';
import { getRuntime } from '../server/runtime';
import { allowedHost, allowedOrigin, isLoopbackBind } from '../server/origin';

const dev = process.argv.includes('--dev');
const noOpen = process.argv.includes('--no-open') || !!process.env.ORBSERVATORY_NO_OPEN || !!process.env.CLAUDE_VIZ_NO_OPEN;

const runtime = getRuntime();
await runtime.ready;
const cfg = resolveConfig(runtime.settings.get());
const hostname = cfg.host;
const port = cfg.port;

const app = next({ dev, hostname, port, dir: fileURLToPath(new URL('..', import.meta.url)) });
const handle = app.getRequestHandler();
await app.prepare();

const guard = isLoopbackBind(hostname);

const server = createServer((req, res) => {
  if (guard && !(allowedHost(req.headers.host, port) && allowedOrigin(req.headers.origin, port))) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  void handle(req, res).catch((err) => {
    console.error('next request failed', err);
    if (!res.headersSent) res.statusCode = 500;
    res.end('Internal Server Error');
  });
});

const wss = new WebSocketServer({ noServer: true });
const nextUpgrade = (app as unknown as {
  getUpgradeHandler?: () => (req: Parameters<typeof server.emit>[1], socket: Duplex, head: Buffer) => Promise<void>;
}).getUpgradeHandler?.();

server.on('upgrade', (req, socket, head) => {
  if (guard && !(allowedHost(req.headers.host, port) && allowedOrigin(req.headers.origin, port))) {
    socket.destroy();
    return;
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || `${hostname}:${port}`}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }
  if (nextUpgrade) {
    void nextUpgrade(req, socket, head).catch((err) => {
      console.error('next upgrade failed', err);
      socket.destroy(err);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const sub = runtime.addWebSocket(ws);
  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(String(message)) as ClientMessage;
      void sub.handle(parsed).catch((err: Error) => sub.send({ type: 'error', message: String(err.message || err) }));
    } catch (err) {
      sub.send({ type: 'error', message: String((err as Error).message || err) });
    }
  });
  ws.on('close', () => runtime.removeSubscriber(sub));
});

server.listen(port, hostname, () => {
  const displayHost = hostname === '127.0.0.1' || hostname === '0.0.0.0' ? 'localhost' : hostname;
  const url = `http://${displayHost}:${port}`;
  console.log(`orbservatory listening on ${url}`);
  if (!noOpen) openBrowser(url);
});

let closing = false;
const shutdown = () => {
  if (closing) process.exit(130);
  closing = true;
  for (const client of wss.clients) client.terminate();
  wss.close();
  runtime.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function openBrowser(target: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [target], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    console.log(`Open ${target} in your browser.`);
  }
}
