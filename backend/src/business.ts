import { v4 as uuidv4 } from 'uuid';
import db from './db';
import {
  Ticket, Locker, TicketType, TicketStatus, LockerStatus, LockerSize,
  HOLD_SECONDS, MAX_REQUEUE,
  getAllLockers, getLocker, updateLocker,
  getTicketsByStatus, getTicket, updateTicket,
  refreshQueuePositions, logAudit, getRecentCompleted,
} from './models';

export interface CreateTicketInput {
  visitor_id: string;
  visitor_name: string;
  visitor_phone?: string;
  request_type: TicketType;
  from_locker_id?: string;
  target_size?: LockerSize;
  reason?: string;
}

export class BizError extends Error {
  code: string;
  constructor(code: string, msg: string) { super(msg); this.code = code; }
}

async function assertLockersNotLinked(lockerIds: string[], excludeTicketId?: string): Promise<void> {
  const placeholders = lockerIds.map(() => '?').join(',');
  const rows = await db.all<{ ticket_id: string }>(
    `SELECT ticket_id FROM lockers WHERE id IN (${placeholders}) AND ticket_id IS NOT NULL`,
    lockerIds
  );
  for (const r of rows) {
    if (excludeTicketId && r.ticket_id === excludeTicketId) continue;
    const t = await getTicket(r.ticket_id);
    if (t && t.status !== 'COMPLETED' && t.status !== 'CANCELLED' && t.status !== 'TIMEOUT' && t.status !== 'FAULT') {
      throw new BizError('LOCKER_BUSY', `柜门已被占用，无法重复分配`);
    }
  }
}

async function assertVisitorNoActiveSwap(visitorId: string, excludeTicketId?: string): Promise<void> {
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM tickets WHERE visitor_id = ? AND status IN ('QUEUING','CALLED','IN_PROGRESS') AND request_type = 'SWAP'`,
    [visitorId]
  );
  const conflict = rows.find(r => r.id !== excludeTicketId);
  if (conflict) throw new BizError('VISITOR_HAS_SWAP', '该观众已有一个进行中的换箱流程');
}

async function assertLockerOwned(lockerId: string, visitorId: string): Promise<void> {
  const locker = await getLocker(lockerId);
  if (!locker) throw new BizError('LOCKER_NOT_FOUND', '柜门不存在');
  if (!locker.ticket_id) throw new BizError('LOCKER_NOT_OCCUPIED', '该柜门当前未占用');
  const t = await getTicket(locker.ticket_id);
  if (!t || t.visitor_id !== visitorId) throw new BizError('LOCKER_NOT_OWNED', '该柜门不属于此观众');
}

export async function createTicket(input: CreateTicketInput): Promise<Ticket> {
  return await db.transaction(async (run) => {
    if (input.request_type === 'SWAP') {
      await assertVisitorNoActiveSwap(input.visitor_id);
      if (!input.from_locker_id) throw new BizError('BAD_REQUEST', '换箱必须指定原柜');
      await assertLockerOwned(input.from_locker_id, input.visitor_id);
      await assertLockersNotLinked([input.from_locker_id]);
    }
    if (input.request_type === 'RETRIEVE') {
      if (!input.from_locker_id) throw new BizError('BAD_REQUEST', '取包必须指定柜门');
      await assertLockerOwned(input.from_locker_id, input.visitor_id);
    }
    if (input.request_type === 'STORE') {
      if (!input.target_size) throw new BizError('BAD_REQUEST', '存包必须指定目标尺寸');
    }

    const qr = await db.get<{ c: number }>("SELECT COUNT(*) as c FROM tickets WHERE status IN ('QUEUING','CALLED')") || { c: 0 };
    const ticket: Ticket = {
      id: uuidv4().slice(0, 8).toUpperCase(),
      visitor_id: input.visitor_id,
      visitor_name: input.visitor_name,
      visitor_phone: input.visitor_phone || null,
      request_type: input.request_type,
      from_locker_id: input.from_locker_id || null,
      to_locker_id: null,
      target_size: input.target_size || null,
      reason: input.reason || null,
      status: 'QUEUING',
      operator: null,
      held_until: null,
      requeue_count: 0,
      queue_position: qr.c + 1,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
      result_note: null,
    };

    await db.run(
      `INSERT INTO tickets (id,visitor_id,visitor_name,visitor_phone,request_type,from_locker_id,to_locker_id,target_size,reason,status,operator,held_until,requeue_count,queue_position,created_at,updated_at,completed_at,result_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ticket.id, ticket.visitor_id, ticket.visitor_name, ticket.visitor_phone,
       ticket.request_type, ticket.from_locker_id, ticket.to_locker_id, ticket.target_size,
       ticket.reason, ticket.status, ticket.operator, ticket.held_until, ticket.requeue_count,
       ticket.queue_position, ticket.created_at, ticket.updated_at, ticket.completed_at, ticket.result_note]
    );
    await logAudit(ticket.id, 'CREATE', null, 'QUEUING', null, null, `发起${typeLabel(ticket.request_type)}`);
    await refreshQueuePositions();
    return ticket;
  });
}

export async function callNextTicket(operator: string): Promise<Ticket | null> {
  return await db.transaction(async () => {
    const called = await db.get<{ id: string }>("SELECT id FROM tickets WHERE status = 'CALLED' LIMIT 1");
    if (called) {
      const t = await getTicket(called.id);
      if (t) throw new BizError('HAS_CALLING', `当前已有叫号：${t.id}（${t.visitor_name}）`);
    }
    const row = await db.get<{ id: string }>("SELECT id FROM tickets WHERE status = 'QUEUING' ORDER BY created_at ASC LIMIT 1");
    if (!row) return null;
    const t = await getTicket(row.id);
    if (!t) return null;
    const oldStatus = t.status;
    const patch: Partial<Ticket> = {
      status: 'CALLED',
      operator,
      held_until: Date.now() + HOLD_SECONDS * 1000,
    };
    await updateTicket(t.id, patch);
    await logAudit(t.id, 'CALL', oldStatus, 'CALLED', null, operator, '叫号');
    await refreshQueuePositions();
    return { ...t, ...patch };
  });
}

export async function callSpecificTicket(ticketId: string, operator: string): Promise<Ticket> {
  return await db.transaction(async () => {
    const t = await getTicket(ticketId);
    if (!t) throw new BizError('NOT_FOUND', '单据不存在');
    if (t.status !== 'QUEUING') throw new BizError('BAD_STATUS', '只能对排队中的单子叫号');
    const called = await db.get<{ id: string }>("SELECT id FROM tickets WHERE status = 'CALLED' LIMIT 1");
    if (called) {
      const ct = await getTicket(called.id);
      if (ct) throw new BizError('HAS_CALLING', `当前已有叫号：${ct.id}（${ct.visitor_name}）`);
    }
    const oldStatus = t.status;
    const patch: Partial<Ticket> = {
      status: 'CALLED',
      operator,
      held_until: Date.now() + HOLD_SECONDS * 1000,
    };
    await updateTicket(t.id, patch);
    await logAudit(t.id, 'CALL', oldStatus, 'CALLED', null, operator, '叫号');
    await refreshQueuePositions();
    return { ...t, ...patch };
  });
}

async function findIdleLocker(size: LockerSize, excludeId?: string): Promise<Locker | undefined> {
  if (excludeId) {
    return db.get<Locker>(
      "SELECT * FROM lockers WHERE size = ? AND status = 'IDLE' AND id != ? ORDER BY zone, row_no, col_no LIMIT 1",
      [size, excludeId]
    );
  }
  return db.get<Locker>(
    "SELECT * FROM lockers WHERE size = ? AND status = 'IDLE' ORDER BY zone, row_no, col_no LIMIT 1",
    [size]
  );
}

export async function pickupCalled(ticketId: string): Promise<Ticket> {
  return await db.transaction(async () => {
    const t = await getTicket(ticketId);
    if (!t) throw new BizError('NOT_FOUND', '单据不存在');
    if (t.status !== 'CALLED') throw new BizError('BAD_STATUS', '当前单不是叫号状态');
    const oldStatus = t.status;
    const patch: Partial<Ticket> = { status: 'IN_PROGRESS', held_until: null };
    if (t.request_type === 'STORE' && !t.to_locker_id) {
      const target = await findIdleLocker(t.target_size || 'M');
      if (!target) throw new BizError('NO_LOCKER', `没有空闲的${sizeLabel(t.target_size || 'M')}柜`);
      patch.to_locker_id = target.id;
    }
    if (t.request_type === 'SWAP' && !t.to_locker_id) {
      const target = await findIdleLocker(t.target_size || 'M', t.from_locker_id || undefined);
      if (!target) throw new BizError('NO_LOCKER', `没有空闲的${sizeLabel(t.target_size || 'M')}柜`);
      patch.to_locker_id = target.id;
    }
    await updateTicket(t.id, patch);
    await logAudit(t.id, 'PICKUP', oldStatus, 'IN_PROGRESS', patch.to_locker_id || null, t.operator, '观众到场，开始办理');
    return { ...t, ...patch };
  });
}

export async function completeTicket(ticketId: string, operator: string, note?: string): Promise<Ticket> {
  return await db.transaction(async () => {
    const t = await getTicket(ticketId);
    if (!t) throw new BizError('NOT_FOUND', '单据不存在');
    if (t.status !== 'IN_PROGRESS') throw new BizError('BAD_STATUS', '只能完成进行中的单子');
    const oldStatus = t.status;

    if (t.request_type === 'STORE') {
      if (!t.to_locker_id) throw new BizError('NO_LOCKER', '未分配目标柜');
      const locker = await getLocker(t.to_locker_id);
      if (!locker || locker.status !== 'IDLE') throw new BizError('LOCKER_BUSY', '目标柜状态异常');
      await updateLocker(t.to_locker_id, { status: 'OCCUPIED', ticket_id: t.id });
    }
    if (t.request_type === 'RETRIEVE') {
      if (!t.from_locker_id) throw new BizError('BAD_REQUEST', '取包必须指定原柜');
      const locker = await getLocker(t.from_locker_id);
      if (!locker || locker.status !== 'OCCUPIED') throw new BizError('LOCKER_BAD_STATE', '原柜状态异常');
      if (locker.ticket_id && locker.ticket_id !== t.from_locker_id) {
        const orig = await getTicket(locker.ticket_id);
        if (!orig || orig.visitor_id !== t.visitor_id) throw new BizError('LOCKER_NOT_OWNED', '柜门归属校验失败');
      }
      await updateLocker(t.from_locker_id, { status: 'IDLE', ticket_id: null });
    }
    if (t.request_type === 'SWAP') {
      if (!t.from_locker_id || !t.to_locker_id) throw new BizError('BAD_REQUEST', '换箱必须指定原柜和目标柜');
      const from = await getLocker(t.from_locker_id);
      const to = await getLocker(t.to_locker_id);
      if (!from || !to) throw new BizError('LOCKER_NOT_FOUND', '柜门不存在');
      if (from.status !== 'OCCUPIED') throw new BizError('LOCKER_BAD_STATE', '原柜未被占用');
      if (to.status !== 'IDLE') throw new BizError('LOCKER_BAD_STATE', '目标柜未空闲');
      await updateLocker(t.from_locker_id, { status: 'IDLE', ticket_id: null });
      await updateLocker(t.to_locker_id, { status: 'OCCUPIED', ticket_id: t.id });
    }

    const patch: Partial<Ticket> = {
      status: 'COMPLETED',
      operator: operator || t.operator,
      completed_at: Date.now(),
      result_note: note || `${typeLabel(t.request_type)}完成`,
      queue_position: null,
      held_until: null,
    };
    await updateTicket(t.id, patch);
    await logAudit(t.id, 'COMPLETE', oldStatus, 'COMPLETED', null, operator || t.operator, patch.result_note!);
    await refreshQueuePositions();
    return { ...t, ...patch };
  });
}

export async function cancelTicket(ticketId: string, operator: string, reason: string): Promise<Ticket> {
  return await db.transaction(async () => {
    const t = await getTicket(ticketId);
    if (!t) throw new BizError('NOT_FOUND', '单据不存在');
    if (t.status === 'COMPLETED' || t.status === 'CANCELLED' || t.status === 'TIMEOUT' || t.status === 'FAULT') {
      throw new BizError('BAD_STATUS', '该单据已结束，无法取消');
    }
    const oldStatus = t.status;
    const patch: Partial<Ticket> = {
      status: 'CANCELLED',
      operator: operator || t.operator,
      completed_at: Date.now(),
      result_note: `取消：${reason}`,
      queue_position: null,
      held_until: null,
    };
    await updateTicket(t.id, patch);
    await logAudit(t.id, 'CANCEL', oldStatus, 'CANCELLED', null, operator || t.operator, reason);
    await refreshQueuePositions();
    return { ...t, ...patch };
  });
}

export async function markFault(ticketId: string, operator: string, lockerId?: string, reason?: string): Promise<Ticket> {
  return await db.transaction(async () => {
    const t = await getTicket(ticketId);
    if (!t) throw new BizError('NOT_FOUND', '单据不存在');
    if (t.status === 'COMPLETED' || t.status === 'CANCELLED' || t.status === 'TIMEOUT' || t.status === 'FAULT') {
      throw new BizError('BAD_STATUS', '该单据已结束');
    }
    const oldStatus = t.status;
    if (lockerId) {
      const l = await getLocker(lockerId);
      if (!l) throw new BizError('LOCKER_NOT_FOUND', '柜门不存在');
      if (l.status !== 'FAULT') {
        await updateLocker(lockerId, { status: 'FAULT', ticket_id: null });
      }
    }
    const patch: Partial<Ticket> = {
      status: 'FAULT',
      operator: operator || t.operator,
      completed_at: Date.now(),
      result_note: `故障：${reason || '柜门故障'}`,
      queue_position: null,
      held_until: null,
    };
    await updateTicket(t.id, patch);
    await logAudit(t.id, 'FAULT', oldStatus, 'FAULT', lockerId || null, operator || t.operator, reason || '柜门故障');
    await refreshQueuePositions();
    return { ...t, ...patch };
  });
}

export async function requeueIfNeeded(): Promise<Ticket[]> {
  const called = await db.all<Ticket>("SELECT * FROM tickets WHERE status = 'CALLED' AND held_until IS NOT NULL");
  const requeued: Ticket[] = [];
  const now = Date.now();
  for (const t of called) {
    if (t.held_until && now >= t.held_until) {
      const result = await db.transaction<Ticket>(async () => {
        const oldStatus = t.status;
        let finalT: Ticket;
        if (t.requeue_count >= MAX_REQUEUE) {
          const patch: Partial<Ticket> = {
            status: 'TIMEOUT',
            completed_at: now,
            result_note: `超时${MAX_REQUEUE + 1}次，已作废`,
            queue_position: null,
            held_until: null,
          };
          await updateTicket(t.id, patch);
          await logAudit(t.id, 'TIMEOUT_FINAL', oldStatus, 'TIMEOUT', null, '系统', patch.result_note!);
          finalT = { ...t, ...patch };
        } else {
          const newCount = t.requeue_count + 1;
          const patch: Partial<Ticket> = {
            status: 'QUEUING',
            requeue_count: newCount,
            held_until: null,
          };
          await updateTicket(t.id, patch);
          await logAudit(t.id, 'REQUEUE', oldStatus, 'QUEUING', null, '系统', `超时回队（第${newCount}次）`);
          finalT = { ...t, ...patch };
        }
        await refreshQueuePositions();
        return finalT;
      });
      requeued.push(result);
    }
  }
  return requeued;
}

export async function snapshot() {
  const [lockers, queuing, called, inProgress, faultsTimeoutCancelled, completed] = await Promise.all([
    getAllLockers(),
    getTicketsByStatus(['QUEUING']),
    getTicketsByStatus(['CALLED']),
    getTicketsByStatus(['IN_PROGRESS']),
    (async () => {
      const faults = await getTicketsByStatus(['FAULT']);
      const tc = await getTicketsByStatus(['TIMEOUT', 'CANCELLED']);
      const filtered = tc.filter(t => (t.result_note || '').includes('故障') || t.status === 'FAULT');
      return [...faults, ...filtered];
    })(),
    getRecentCompleted(30),
  ]);
  return {
    lockers,
    queuing: queuing.sort((a,b) => (a.queue_position||0) - (b.queue_position||0)),
    called,
    inProgress,
    faults: faultsTimeoutCancelled,
    completed,
    now: Date.now(),
  };
}

export function typeLabel(t: TicketType) {
  return t === 'STORE' ? '存包' : t === 'RETRIEVE' ? '取包' : '换箱';
}
export function sizeLabel(s: LockerSize) {
  return s === 'S' ? '小柜(S)' : s === 'M' ? '中柜(M)' : '大柜(L)';
}
