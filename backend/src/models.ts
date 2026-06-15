import { v4 as uuidv4 } from 'uuid';
import db from './db';

export type LockerSize = 'S' | 'M' | 'L';
export type LockerStatus = 'IDLE' | 'OCCUPIED' | 'RESERVED' | 'FAULT';
export type TicketType = 'STORE' | 'RETRIEVE' | 'SWAP';
export type TicketStatus = 'QUEUING' | 'CALLED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'TIMEOUT' | 'FAULT';

export interface Locker {
  id: string;
  zone: string;
  row_no: number;
  col_no: number;
  size: LockerSize;
  status: LockerStatus;
  ticket_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface Ticket {
  id: string;
  visitor_id: string;
  visitor_name: string;
  visitor_phone: string | null;
  request_type: TicketType;
  from_locker_id: string | null;
  to_locker_id: string | null;
  target_size: LockerSize | null;
  reason: string | null;
  status: TicketStatus;
  operator: string | null;
  held_until: number | null;
  requeue_count: number;
  queue_position: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  result_note: string | null;
}

export interface AuditLog {
  id: string;
  ticket_id: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  locker_id: string | null;
  operator: string | null;
  note: string | null;
  created_at: number;
}

export type ClosureStatus = 'PENDING' | 'MIGRATING' | 'COMPLETED' | 'CANCELLED';
export type MigrationStatus = 'PENDING' | 'MIGRATING' | 'COMPLETED' | 'MANUAL';

export interface ClosureOrder {
  id: string;
  locker_ids: string;
  reason: string;
  operator: string;
  status: ClosureStatus;
  total_affected: number;
  completed_count: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface Migration {
  id: string;
  closure_id: string;
  visitor_id: string;
  visitor_name: string;
  visitor_phone: string | null;
  from_locker_id: string;
  to_locker_id: string | null;
  status: MigrationStatus;
  operator: string | null;
  note: string | null;
  queue_position: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export const HOLD_SECONDS = 60;
export const MAX_REQUEUE = 2;

function now() { return Date.now(); }

export async function logAudit(ticketId: string, action: string, fs: string | null, ts: string | null, lockerId: string | null, operator: string | null, note: string | null) {
  await db.run(
    'INSERT INTO audit_logs (id,ticket_id,action,from_status,to_status,locker_id,operator,note,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [uuidv4(), ticketId, action, fs, ts, lockerId, operator, note, now()]
  );
}

export async function getAllLockers(): Promise<Locker[]> {
  return db.all<Locker>('SELECT * FROM lockers ORDER BY zone, row_no, col_no');
}

export async function getLocker(id: string): Promise<Locker | undefined> {
  return db.get<Locker>('SELECT * FROM lockers WHERE id = ?', [id]);
}

export async function updateLocker(id: string, patch: Partial<Locker>) {
  const keys = Object.keys(patch).filter(k => k !== 'id');
  const setPart = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => (patch as any)[k]);
  await db.run(`UPDATE lockers SET ${setPart}, updated_at = ? WHERE id = ?`, [...vals, now(), id]);
}

export async function getTicketsByStatus(statuses: TicketStatus[]): Promise<Ticket[]> {
  const placeholders = statuses.map(() => '?').join(',');
  return db.all<Ticket>(
    `SELECT * FROM tickets WHERE status IN (${placeholders}) ORDER BY created_at ASC`,
    statuses
  );
}

export async function getTicket(id: string): Promise<Ticket | undefined> {
  return db.get<Ticket>('SELECT * FROM tickets WHERE id = ?', [id]);
}

export async function updateTicket(id: string, patch: Partial<Ticket>) {
  const keys = Object.keys(patch).filter(k => k !== 'id');
  const setPart = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => (patch as any)[k]);
  await db.run(`UPDATE tickets SET ${setPart}, updated_at = ? WHERE id = ?`, [...vals, now(), id]);
}

export async function refreshQueuePositions() {
  const list = await db.all<{ id: string }>("SELECT id FROM tickets WHERE status = 'QUEUING' ORDER BY created_at ASC");
  for (let i = 0; i < list.length; i++) {
    await db.run('UPDATE tickets SET queue_position = ? WHERE id = ?', [i + 1, list[i].id]);
  }
}

export async function getRecentCompleted(limit = 30): Promise<Ticket[]> {
  return db.all<Ticket>(
    `SELECT * FROM tickets WHERE status IN ('COMPLETED','CANCELLED','TIMEOUT','FAULT') ORDER BY COALESCE(completed_at, updated_at) DESC LIMIT ?`,
    [limit]
  );
}

export async function getAuditLogs(ticketId: string): Promise<AuditLog[]> {
  return db.all<AuditLog>('SELECT * FROM audit_logs WHERE ticket_id = ? ORDER BY created_at ASC', [ticketId]);
}

export async function seedDemoData(): Promise<void> {
  const { c } = (await db.get<{ c: number }>('SELECT COUNT(*) as c FROM lockers')) || { c: 0 };
  if (c > 0) return;

  const zones = ['A区', 'B区'];
  const rows = [1, 2, 3];
  const cols = [1, 2, 3, 4];
  const sizeOrder: LockerSize[] = ['S', 'M', 'L'];

  let idx = 0;
  const createdLockers: Locker[] = [];

  for (const zone of zones) {
    for (const r of rows) {
      for (const c of cols) {
        const size = sizeOrder[idx % 3];
        const id = `${zone[0]}${r}-${c}`;
        const t = now();
        await db.run(
          'INSERT INTO lockers (id,zone,row_no,col_no,size,status,ticket_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [id, zone, r, c, size, 'IDLE', null, t, t]
        );
        createdLockers.push({ id, zone, row_no: r, col_no: c, size, status: 'IDLE', ticket_id: null, created_at: t, updated_at: t });
        idx++;
      }
    }
  }

  const demoOccupied = [
    { locker: 'A1-1', visitorId: 'V1001', name: '张小美', phone: '138****0001' },
    { locker: 'A1-2', visitorId: 'V1002', name: '李大勇', phone: '139****0002' },
    { locker: 'A1-3', visitorId: 'V1003', name: '王小丽', phone: '137****0003' },
    { locker: 'A2-2', visitorId: 'V1004', name: '陈浩然', phone: '136****0004' },
    { locker: 'A2-3', visitorId: 'V1005', name: '刘思琪', phone: '135****0005' },
    { locker: 'A3-1', visitorId: 'V1006', name: '赵俊峰', phone: '134****0006' },
    { locker: 'B1-1', visitorId: 'V1007', name: '孙雨桐', phone: '133****0007' },
    { locker: 'B1-4', visitorId: 'V1008', name: '周天宇', phone: '132****0008' },
    { locker: 'B2-2', visitorId: 'V1009', name: '吴梓萱', phone: '131****0009' },
    { locker: 'B3-3', visitorId: 'V1010', name: '郑浩宇', phone: '130****0010' },
  ];

  const past = now() - 1000 * 60 * 60 * 2;
  for (let i = 0; i < demoOccupied.length; i++) {
    const d = demoOccupied[i];
    const tid = `T${2000 + i}`;
    const t = past + i * 60000;
    await db.run(
      'INSERT INTO tickets (id,visitor_id,visitor_name,visitor_phone,request_type,from_locker_id,to_locker_id,target_size,reason,status,operator,held_until,requeue_count,queue_position,created_at,updated_at,completed_at,result_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [tid, d.visitorId, d.name, d.phone, 'STORE', null, d.locker, null, '入场存包', 'COMPLETED', '运营-李姐', null, 0, null, t, t + 30000, t + 30000, '存包完成']
    );
    await updateLocker(d.locker, { status: 'OCCUPIED', ticket_id: tid });
  }

  await updateLocker('A2-4', { status: 'FAULT', ticket_id: null });
  await updateLocker('B3-2', { status: 'FAULT', ticket_id: null });

  const queuingList = [
    { visitorId: 'V1011', name: '钱沐阳', phone: '151****1011', type: 'STORE' as TicketType, targetSize: 'M' as LockerSize, reason: '大袋子要存', ago: 3 },
    { visitorId: 'V1001', name: '张小美', phone: '138****0001', type: 'RETRIEVE' as TicketType, fromLocker: 'A1-1', reason: '要拿水', ago: 2.5 },
    { visitorId: 'V1012', name: '冯可欣', phone: '152****1012', type: 'STORE' as TicketType, targetSize: 'L' as LockerSize, reason: 'cos道具箱', ago: 2 },
    { visitorId: 'V1004', name: '陈浩然', phone: '136****0004', type: 'SWAP' as TicketType, fromLocker: 'A2-2', targetSize: 'L' as LockerSize, reason: '买了周边装不下', ago: 1.5 },
    { visitorId: 'V1013', name: '褚子墨', phone: '153****1013', type: 'RETRIEVE' as TicketType, fromLocker: 'B1-1', reason: '赶场取包', ago: 1 },
    { visitorId: 'V1002', name: '李大勇', phone: '139****0002', type: 'SWAP' as TicketType, fromLocker: 'A1-2', targetSize: 'M' as LockerSize, reason: '想换近一点的柜', ago: 0.5 },
  ];

  for (let i = 0; i < queuingList.length; i++) {
    const q = queuingList[i];
    const tid = `T${3000 + i}`;
    const ct = now() - Math.floor(q.ago * 60000);
    await db.run(
      'INSERT INTO tickets (id,visitor_id,visitor_name,visitor_phone,request_type,from_locker_id,to_locker_id,target_size,reason,status,operator,held_until,requeue_count,queue_position,created_at,updated_at,completed_at,result_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [tid, q.visitorId, q.name, q.phone, q.type, q.fromLocker || null, null, q.targetSize || null, q.reason, 'QUEUING', null, null, 0, i + 1, ct, ct, null, null]
    );
  }

  await db.run(
    'INSERT INTO tickets (id,visitor_id,visitor_name,visitor_phone,request_type,from_locker_id,to_locker_id,target_size,reason,status,operator,held_until,requeue_count,queue_position,created_at,updated_at,completed_at,result_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ['T4001', 'V1005', '刘思琪', '135****0005', 'SWAP', 'A2-3', 'A3-2', 'L', '换到旁边L柜', 'IN_PROGRESS', '运营-王哥', null, 0, null, now() - 45000, now() - 15000, null, '原柜物品已取出，正在装新柜']
  );

  await db.run(
    'INSERT INTO tickets (id,visitor_id,visitor_name,visitor_phone,request_type,from_locker_id,to_locker_id,target_size,reason,status,operator,held_until,requeue_count,queue_position,created_at,updated_at,completed_at,result_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ['T5001', 'V1008', '周天宇', '132****0008', 'RETRIEVE', 'B1-4', null, null, '柜门打不开', 'FAULT', '巡场-小张', null, 0, null, now() - 900000, now() - 600000, now() - 600000, 'B1-4柜门机械故障，已登记走人工取件']
  );

  const cancels = [
    { id: 'T6001', vid: 'V1014', name: '卫佳怡', phone: '154****1014', type: 'STORE' as TicketType, note: '排队太久走了', status: 'TIMEOUT' as TicketStatus, requeue: 2, ago: 20 },
    { id: 'T6002', vid: 'V1015', name: '蒋明轩', phone: '155****1015', type: 'RETRIEVE' as TicketType, from: 'B2-2', note: '自己找到包了', status: 'CANCELLED' as TicketStatus, ago: 12 },
  ];

  for (const c of cancels) {
    const ct = now() - c.ago * 60000;
    await db.run(
      'INSERT INTO tickets (id,visitor_id,visitor_name,visitor_phone,request_type,from_locker_id,to_locker_id,target_size,reason,status,operator,held_until,requeue_count,queue_position,created_at,updated_at,completed_at,result_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [c.id, c.vid, c.name, c.phone, c.type, (c as any).from || null, null, null, c.note, c.status, '运营-李姐', null, (c as any).requeue || 0, null, ct, ct + 180000, ct + 180000, c.note]
    );
  }

  await refreshQueuePositions();
  console.log('✅ 演示数据已初始化');
}
