/**
 * ชั้นสำหรับกระจายหลาย node
 *
 * แนวคิดหลักคือ **match affinity**: หนึ่งแมตช์อยู่บน node เดียวเสมอ
 * เพราะเกมผลัดตาเป็น single-writer อยู่แล้ว การพยายามแชร์ state ของแมตช์
 * ข้าม node มีแต่จะเพิ่ม lock กับ race โดยไม่ได้อะไรกลับมา
 *
 * สิ่งที่ต้องแชร์กันจริง ๆ มีแค่สี่อย่าง:
 *   1. ทะเบียนว่าห้อง/แมตช์ไหนอยู่ node ไหน  → ใช้ redirect client ไปให้ถูกที่
 *   2. คิวจับคู่                              → จับคู่ข้าม node ได้
 *   3. จำนวนคนออนไลน์รวมทุก node
 *   4. ช่องส่งข้อความระหว่าง node
 *
 * LocalCluster ใช้เมื่อรัน node เดียว (ค่าเริ่มต้น ไม่ต้องมี Redis)
 * RedisCluster ใช้เมื่อรันหลาย node
 */

export type DirectoryKind = "room" | "match" | "session";

export interface NodeLocation {
  nodeId: string;
  /** URL ที่ client ต่อ WebSocket เข้ามาได้โดยตรง */
  url: string;
}

export interface QueueEntry {
  sessionId: string;
  nodeId: string;
  url: string;
}

export interface PresenceCounts {
  online: number;
  inMatch: number;
  inQueue: number;
}

export interface ClusterTotals extends PresenceCounts {
  nodes: number;
}

export interface Cluster {
  readonly nodeId: string;
  readonly nodeUrl: string;
  readonly distributed: boolean;

  /** จองว่า key นี้เป็นของ node นี้ */
  claim(kind: DirectoryKind, key: string): Promise<void>;
  lookup(kind: DirectoryKind, key: string): Promise<NodeLocation | null>;
  release(kind: DirectoryKind, key: string): Promise<void>;

  /**
   * เข้าคิวจับคู่ ถ้ามีคนรออยู่แล้วจะคืนคู่ตรงข้ามมาเลย และคนที่ได้คู่คือ
   * เจ้าของแมตช์ อีกฝ่ายจะถูก redirect มาที่ node นี้
   */
  enqueue(entry: QueueEntry): Promise<QueueEntry | null>;
  dequeue(sessionId: string): Promise<void>;

  heartbeat(counts: PresenceCounts): Promise<void>;
  totals(): Promise<ClusterTotals>;

  /** ทำเครื่องหมายว่า id นี้ออนไลน์อยู่ ใช้แสดงสถานะเพื่อนข้าม node */
  markOnline(id: string): Promise<void>;
  markOffline(id: string): Promise<void>;
  onlineAmong(ids: string[]): Promise<string[]>;

  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: (message: any) => void): Promise<void>;

  close(): Promise<void>;
}

// ── node เดียว ───────────────────────────────────────────────────────────────

export class LocalCluster implements Cluster {
  readonly nodeId: string;
  readonly nodeUrl: string;
  readonly distributed = false;

  private readonly directory = new Map<string, NodeLocation>();
  private readonly queue: QueueEntry[] = [];
  private readonly handlers = new Map<string, ((message: any) => void)[]>();
  private readonly online = new Set<string>();
  private counts: PresenceCounts = { online: 0, inMatch: 0, inQueue: 0 };

  constructor(nodeId = "local", nodeUrl = "") {
    this.nodeId = nodeId;
    this.nodeUrl = nodeUrl;
  }

  async claim(kind: DirectoryKind, key: string): Promise<void> {
    this.directory.set(`${kind}:${key}`, { nodeId: this.nodeId, url: this.nodeUrl });
  }
  async lookup(kind: DirectoryKind, key: string): Promise<NodeLocation | null> {
    return this.directory.get(`${kind}:${key}`) ?? null;
  }
  async release(kind: DirectoryKind, key: string): Promise<void> {
    this.directory.delete(`${kind}:${key}`);
  }

  async enqueue(entry: QueueEntry): Promise<QueueEntry | null> {
    const index = this.queue.findIndex((waiting) => waiting.sessionId !== entry.sessionId);
    if (index >= 0) return this.queue.splice(index, 1)[0];
    if (!this.queue.some((waiting) => waiting.sessionId === entry.sessionId)) this.queue.push(entry);
    return null;
  }
  async dequeue(sessionId: string): Promise<void> {
    const index = this.queue.findIndex((entry) => entry.sessionId === sessionId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  async heartbeat(counts: PresenceCounts): Promise<void> {
    this.counts = counts;
  }
  async totals(): Promise<ClusterTotals> {
    return { ...this.counts, inQueue: this.queue.length, nodes: 1 };
  }

  async markOnline(id: string): Promise<void> {
    this.online.add(id);
  }
  async markOffline(id: string): Promise<void> {
    this.online.delete(id);
  }
  async onlineAmong(ids: string[]): Promise<string[]> {
    return ids.filter((id) => this.online.has(id));
  }

  async publish(channel: string, message: unknown): Promise<void> {
    for (const handler of this.handlers.get(channel) ?? []) handler(message);
  }
  async subscribe(channel: string, handler: (message: any) => void): Promise<void> {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
  }

  async close(): Promise<void> {
    this.directory.clear();
    this.queue.length = 0;
    this.handlers.clear();
  }
}

// ── หลาย node ผ่าน Redis ────────────────────────────────────────────────────

const PRESENCE_TTL_SECONDS = 30;
const DIRECTORY_TTL_SECONDS = 6 * 60 * 60;

export interface RedisClusterOptions {
  url: string;
  nodeId: string;
  nodeUrl: string;
  /** คั่นข้อมูลของหลาย environment ที่ใช้ Redis ตัวเดียวกัน */
  prefix?: string;
}

export class RedisCluster implements Cluster {
  readonly nodeId: string;
  readonly nodeUrl: string;
  readonly distributed = true;

  private readonly prefix: string;
  private readonly commands: RedisLike;
  /** การ subscribe ทำให้ connection ใช้ทำอย่างอื่นไม่ได้ จึงต้องแยกตัว */
  private readonly listener: RedisLike;
  private readonly handlers = new Map<string, ((message: any) => void)[]>();

  constructor(options: RedisClusterOptions, factory: (url: string) => RedisLike = defaultRedisFactory) {
    this.nodeId = options.nodeId;
    this.nodeUrl = options.nodeUrl;
    this.prefix = options.prefix ?? "msk";
    this.commands = factory(options.url);
    this.listener = factory(options.url);
  }

  static async connect(options: RedisClusterOptions): Promise<RedisCluster> {
    const cluster = new RedisCluster(options);
    await cluster.commands.set(cluster.key("hello"), cluster.nodeId, "EX", 60);
    return cluster;
  }

  private key(...parts: string[]): string {
    return [this.prefix, ...parts].join(":");
  }

  async claim(kind: DirectoryKind, key: string): Promise<void> {
    await this.commands.set(
      this.key("dir", kind, key),
      JSON.stringify({ nodeId: this.nodeId, url: this.nodeUrl }),
      "EX",
      DIRECTORY_TTL_SECONDS,
    );
  }

  async lookup(kind: DirectoryKind, key: string): Promise<NodeLocation | null> {
    const raw = await this.commands.get(this.key("dir", kind, key));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as NodeLocation;
    } catch {
      return null;
    }
  }

  async release(kind: DirectoryKind, key: string): Promise<void> {
    await this.commands.del(this.key("dir", kind, key));
  }

  /**
   * ดึงคนที่รออยู่ออกมาทีละคนจนกว่าจะได้คนที่ไม่ใช่ตัวเอง
   * ใช้ LPOP/RPUSH ของ Redis ซึ่ง atomic อยู่แล้ว จึงไม่มีทางที่สอง node
   * จะหยิบคนเดียวกันไปจับคู่พร้อมกัน
   */
  async enqueue(entry: QueueEntry): Promise<QueueEntry | null> {
    const queueKey = this.key("queue");
    for (let attempt = 0; attempt < 20; attempt++) {
      const raw = await this.commands.lpop(queueKey);
      if (!raw) break;
      try {
        const waiting = JSON.parse(raw) as QueueEntry;
        if (waiting.sessionId !== entry.sessionId) return waiting;
      } catch {
        // ข้อมูลเสีย ทิ้งไปแล้วลองตัวถัดไป
      }
    }
    await this.commands.rpush(queueKey, JSON.stringify(entry));
    return null;
  }

  /**
   * เอาออกจากคิวโดยไม่ต้องล็อกทั้งคิว — ทำเครื่องหมายไว้ว่ายกเลิกแล้ว
   * แล้วปล่อยให้ฝั่งที่หยิบไปเจอเองว่าใช้ไม่ได้ (ตรวจตอน redirect)
   */
  async dequeue(sessionId: string): Promise<void> {
    await this.commands.set(this.key("cancelled", sessionId), "1", "EX", 300);
  }

  async isCancelled(sessionId: string): Promise<boolean> {
    return Boolean(await this.commands.get(this.key("cancelled", sessionId)));
  }

  async heartbeat(counts: PresenceCounts): Promise<void> {
    await this.commands.set(
      this.key("presence", this.nodeId),
      JSON.stringify(counts),
      "EX",
      PRESENCE_TTL_SECONDS,
    );
  }

  async totals(): Promise<ClusterTotals> {
    const keys = await this.commands.keys(this.key("presence", "*"));
    const totals: ClusterTotals = { online: 0, inMatch: 0, inQueue: 0, nodes: 0 };
    for (const key of keys) {
      const raw = await this.commands.get(key);
      if (!raw) continue;
      try {
        const counts = JSON.parse(raw) as PresenceCounts;
        totals.online += counts.online;
        totals.inMatch += counts.inMatch;
        totals.inQueue += counts.inQueue;
        totals.nodes += 1;
      } catch {
        // ข้าม node ที่ข้อมูลเสีย
      }
    }
    return totals;
  }

  async markOnline(id: string): Promise<void> {
    // TTL เผื่อ node ล่มโดยไม่ได้ล้างสถานะ เพื่อนจะได้ไม่ค้างว่าออนไลน์ตลอดกาล
    await this.commands.set(this.key("online", id), this.nodeId, "EX", PRESENCE_TTL_SECONDS * 2);
  }

  async markOffline(id: string): Promise<void> {
    await this.commands.del(this.key("online", id));
  }

  async onlineAmong(ids: string[]): Promise<string[]> {
    const online: string[] = [];
    for (const id of ids) {
      if (await this.commands.get(this.key("online", id))) online.push(id);
    }
    return online;
  }

  async publish(channel: string, message: unknown): Promise<void> {
    await this.commands.publish(this.key("ch", channel), JSON.stringify(message));
  }

  async subscribe(channel: string, handler: (message: any) => void): Promise<void> {
    const full = this.key("ch", channel);
    const list = this.handlers.get(full) ?? [];
    list.push(handler);
    this.handlers.set(full, list);
    if (list.length > 1) return;

    await this.listener.subscribe(full, (raw: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      for (const listener of this.handlers.get(full) ?? []) listener(parsed);
    });
  }

  async close(): Promise<void> {
    await this.commands.del(this.key("presence", this.nodeId)).catch(() => {});
    this.listener.close();
    this.commands.close();
  }
}

/** เท่าที่ cluster นี้ใช้จาก Redis client ของ Bun */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  lpop(key: string): Promise<string | null>;
  rpush(key: string, value: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, handler: (message: string) => void): Promise<unknown>;
  close(): void;
}

function defaultRedisFactory(url: string): RedisLike {
  return new Bun.RedisClient(url) as unknown as RedisLike;
}
