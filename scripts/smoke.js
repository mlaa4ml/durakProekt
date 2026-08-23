import { WebSocket } from 'ws';
import { createServer } from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

function wsSend(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function wsOnceMessage(ws, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const onMsg = (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
    const t = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        ws.off('message', onMsg);
        reject(new Error('WS timeout'));
      }
    }, 200);
  });
}

async function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = new (await import('node:http')).request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d.toString()));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const PORT = Number(process.env.SMOKE_PORT || 8099);

  const serverProc = (await import('node:child_process')).spawn(
    'node',
    ['server/index.js'],
    {
      env: { ...process.env, PORT },
      stdio: 'inherit',
    },
  );

  const wsUrl = `ws://localhost:${PORT}`;
  await waitFor(() => httpGetJson(`http://localhost:${PORT}/health`).catch(() => null), {
    timeoutMs: 30000,
  });

  const health = await httpGetJson(`http://localhost:${PORT}/health`);
  if (!health.ok) throw new Error('Health returned ok=false');

  const w1 = new WebSocket(wsUrl);
  const w2 = new WebSocket(wsUrl);
  await Promise.all([
    new Promise((res) => w1.on('open', res)),
    new Promise((res) => w2.on('open', res)),
  ]);

  const mkPlayerId = () => Math.random().toString(36).slice(2, 7);
  const name1 = `p1-${mkPlayerId()}`;
  const name2 = `p2-${mkPlayerId()}`;

  wsSend(w1, { type: 'createRoom', name: name1, label: null, numPlayers: 2, deckSize: 24, throwInPolicy: null });
  const roomsOrJoined = await wsOnceMessage(w1, (m) => m.type === 'joined' && m.roomId);
  const roomId = roomsOrJoined.roomId;
  const playerId1 = roomsOrJoined.playerId;

  wsSend(w2, { type: 'join', roomId, name: name2 });
  const joined2 = await wsOnceMessage(w2, (m) => m.type === 'joined' && m.roomId === roomId);
  const playerId2 = joined2.playerId;

  let state;
  let finished = false;
  const MAX_TURNS = 2000;
  for (let i = 0; i < MAX_TURNS && !finished; i++) {
    const who = i % 2 === 0 ? w1 : w2;
    const other = i % 2 === 0 ? w2 : w1;
    const msg = await wsOnceMessage(who, (m) => m.type === 'state');
    state = msg.state;
    finished = state && state.finished;
    const you = msg.you;
    const legal = msg.legalActions;
    const legalArr = Array.isArray(legal) ? legal : [];
    if (!legalArr.length) {
      // skip: server might send state when not your turn
      // but it still sends legalActions empty for non-turn. We'll just continue.
      continue;
    }

    // Simple decision: pick first legal action.
    // (We don't import bot here to avoid coupling; we're verifying protocol + move validity.)
    const action = legalArr[0];
    wsSend(who, { type: 'action', action });

    // give other socket a moment
    void other;
  }

  w1.close();
  w2.close();

  serverProc.kill('SIGKILL');

  if (!finished) throw new Error('Game did not finish within turn limit');

  console.log('=== Итог: 1/1 smoke проверки пройдено ===');
}

run().catch((e) => {
  console.error('SMOKE FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
