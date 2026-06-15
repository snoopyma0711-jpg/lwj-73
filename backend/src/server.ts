import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { initDB } from './db';
import { seedDemoData } from './models';
import {
  createTicket, callNextTicket, callSpecificTicket, pickupCalled,
  completeTicket, cancelTicket, markFault, requeueIfNeeded, snapshot,
  BizError, typeLabel,
  createClosureOrder, getClosureOrders, getClosureOrder,
  getMigrationsByClosure, getMigrationsByVisitor,
  migrateVisitor, manualHandleMigration, cancelClosureOrder,
} from './business';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

async function main() {
  await initDB();
  await seedDemoData();

  const app = express();
  app.use(cors());
  app.use(express.json());

  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/static', express.static(publicDir));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
  });
  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
  });
  app.get('/m', (_req, res) => {
    res.sendFile(path.join(publicDir, 'mobile.html'));
  });

  function sendSnap(io: SocketIOServer) {
    snapshot().then(s => io.emit('snapshot', s));
  }

  app.get('/api/snapshot', async (_req, res) => {
    try { res.json(await snapshot()); }
    catch (e) { console.error(e); res.status(500).json({ ok: false }); }
  });

  app.post('/api/tickets', async (req, res) => {
    try {
      const t = await createTicket(req.body);
      res.json({ ok: true, data: t });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  app.post('/api/call-next', async (req, res) => {
    try {
      const { operator } = req.body || {};
      const t = await callNextTicket(operator || '系统');
      res.json({ ok: true, data: t });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  app.post('/api/tickets/:id/call', async (req, res) => {
    try {
      const { operator } = req.body || {};
      const t = await callSpecificTicket(req.params.id, operator || '系统');
      res.json({ ok: true, data: t });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  app.post('/api/tickets/:id/pickup', async (req, res) => {
    try {
      const t = await pickupCalled(req.params.id);
      res.json({ ok: true, data: t });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  app.post('/api/tickets/:id/complete', async (req, res) => {
    try {
      const { operator, note } = req.body || {};
      const t = await completeTicket(req.params.id, operator || '运营', note);
      res.json({ ok: true, data: t });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  app.post('/api/tickets/:id/cancel', async (req, res) => {
    try {
      const { operator, reason } = req.body || {};
      const t = await cancelTicket(req.params.id, operator || '运营', reason || '用户取消');
      res.json({ ok: true, data: t });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  app.post('/api/tickets/:id/fault', async (req, res) => {
    try {
      const { operator, locker_id, reason } = req.body || {};
      const t = await markFault(req.params.id, operator || '运营', locker_id, reason);
      res.json({ ok: true, data: t });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  app.get('/api/types', (_req, res) => {
    res.json({ ok: true, data: { HOLD_SECONDS: 60, MAX_REQUEUE: 2, typeLabel, sizeLabel: (s: string) => s === 'S' ? '小柜(S)' : s === 'M' ? '中柜(M)' : '大柜(L)' } });
  });

  app.post('/api/closure-orders', async (req, res) => {
    try {
      const { locker_ids, reason, operator } = req.body || {};
      if (!locker_ids || !Array.isArray(locker_ids) || locker_ids.length === 0) {
        res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: '请选择要闭柜的柜门' });
        return;
      }
      const order = await createClosureOrder(locker_ids, reason || '临时闭柜', operator || '运营');
      res.json({ ok: true, data: order });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  app.get('/api/closure-orders', async (_req, res) => {
    try { res.json({ ok: true, data: await getClosureOrders() }); }
    catch (e) { console.error(e); res.status(500).json({ ok: false }); }
  });

  app.get('/api/closure-orders/:id', async (req, res) => {
    try {
      const order = await getClosureOrder(req.params.id);
      if (!order) { res.status(404).json({ ok: false, message: '工单不存在' }); return; }
      const migrations = await getMigrationsByClosure(req.params.id);
      res.json({ ok: true, data: { ...order, migrations } });
    } catch (e) { console.error(e); res.status(500).json({ ok: false }); }
  });

  app.get('/api/closure-orders/:id/migrations', async (req, res) => {
    try { res.json({ ok: true, data: await getMigrationsByClosure(req.params.id) }); }
    catch (e) { console.error(e); res.status(500).json({ ok: false }); }
  });

  app.post('/api/migrations/:id/migrate', async (req, res) => {
    try {
      const { to_locker_id, operator } = req.body || {};
      if (!to_locker_id) { res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: '请指定目标柜门' }); return; }
      const mg = await migrateVisitor(req.params.id, to_locker_id, operator || '运营');
      res.json({ ok: true, data: mg });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  app.post('/api/migrations/:id/manual', async (req, res) => {
    try {
      const { operator, note } = req.body || {};
      const mg = await manualHandleMigration(req.params.id, operator || '运营', note || '');
      res.json({ ok: true, data: mg });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  app.get('/api/migrations/visitor/:visitorId', async (req, res) => {
    try { res.json({ ok: true, data: await getMigrationsByVisitor(req.params.visitorId) }); }
    catch (e) { console.error(e); res.status(500).json({ ok: false }); }
  });

  app.post('/api/closure-orders/:id/cancel', async (req, res) => {
    try {
      const { operator } = req.body || {};
      const order = await cancelClosureOrder(req.params.id, operator || '运营');
      res.json({ ok: true, data: order });
      sendSnap(io);
    } catch (e) {
      if (e instanceof BizError) res.status(400).json({ ok: false, code: e.code, message: e.message });
      else { console.error(e); res.status(500).json({ ok: false, message: String(e) }); }
    }
  });

  const server = http.createServer(app);
  const io = new SocketIOServer(server, { cors: { origin: '*' } });

  io.on('connection', async (socket) => {
    socket.emit('snapshot', await snapshot());
  });

  setInterval(async () => {
    const changed = await requeueIfNeeded();
    if (changed.length > 0) sendSnap(io);
    else io.emit('tick', { now: Date.now() });
  }, 500);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 寄存柜临时换箱协同台已启动！`);
    console.log(`   ├─ 电脑端运营台:  http://localhost:${PORT}/admin`);
    console.log(`   └─ 手机端观众端:  http://localhost:${PORT}/m\n`);
  });
}

main().catch(e => { console.error('启动失败:', e); process.exit(1); });
