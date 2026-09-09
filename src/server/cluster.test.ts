/**
 * ทดสอบชั้นกระจายหลาย node
 * LocalCluster ทดสอบตรง ๆ ส่วน RedisCluster ทดสอบกับ Redis จริงถ้ามีให้ต่อ
 * (ตั้ง TEST_REDIS_URL) ไม่งั้นข้ามไป เพื่อให้ bun test รันได้ทุกเครื่อง
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type Cluster, LocalCluster, RedisCluster } from "./cluster.js";
import { Hub, type Connection } from "./hub.js";
import type { ServerMessage } from "./protocol.js";

const REDIS_URL = process.env.TEST_REDIS_URL;

function contractTests(name: string, make: (nodeId: string, url: string) => Promise<Cluster> | Cluster) {
  describe(name, () => {
    const open: Cluster[] = [];
    const create = async (nodeId: string, url: string) => {
      const cluster = await make(nodeId, url);
      open.push(cluster);
      return cluster;
    };
    afterEach(async () => {
      while (open.length) await open.pop()!.close();
    });

    test("จองและค้นหาว่าห้องอยู่ node ไหน", async () => {
      const a = await create("node-a", "http://a.local");
      expect(await a.lookup("room", "AAAAAA")).toBeNull();
      await a.claim("room", "AAAAAA");
      const found = await a.lookup("room", "AAAAAA");
      expect(found?.nodeId).toBe("node-a");
      expect(found?.url).toBe("http://a.local");
      await a.release("room", "AAAAAA");
      expect(await a.lookup("room", "AAAAAA")).toBeNull();
    });

    test("คนแรกเข้าคิวแล้วรอ คนที่สองได้คู่ทันที", async () => {
      const a = await create("node-a", "http://a.local");
      expect(await a.enqueue({ sessionId: "p1", nodeId: "node-a", url: "http://a.local" })).toBeNull();
      const matched = await a.enqueue({ sessionId: "p2", nodeId: "node-a", url: "http://a.local" });
      expect(matched?.sessionId).toBe("p1");
    });

    test("คนเดิมเข้าคิวซ้ำไม่จับคู่กับตัวเอง", async () => {
      const a = await create("node-a", "http://a.local");
      await a.enqueue({ sessionId: "solo", nodeId: "node-a", url: "http://a.local" });
      expect(await a.enqueue({ sessionId: "solo", nodeId: "node-a", url: "http://a.local" })).toBeNull();
    });

    test("ส่งข้อความถึง node ปลายทางได้", async () => {
      const a = await create("node-a", "http://a.local");
      const received: unknown[] = [];
      await a.subscribe("node:node-a", (message) => received.push(message));
      await a.publish("node:node-a", { type: "redirect", sessionId: "p1", url: "http://b.local" });
      await Bun.sleep(60);
      expect(received).toEqual([{ type: "redirect", sessionId: "p1", url: "http://b.local" }]);
    });

    test("รายงานจำนวนคนออนไลน์", async () => {
      const a = await create("node-a", "http://a.local");
      await a.heartbeat({ online: 4, inMatch: 2, inQueue: 1 });
      const totals = await a.totals();
      expect(totals.online).toBe(4);
      expect(totals.inMatch).toBe(2);
      expect(totals.nodes).toBeGreaterThanOrEqual(1);
    });
  });
}

contractTests("LocalCluster", (nodeId, url) => new LocalCluster(nodeId, url));

if (REDIS_URL) {
  const prefix = `msktest:${crypto.randomUUID().slice(0, 8)}`;
  contractTests("RedisCluster", (nodeId, url) =>
    RedisCluster.connect({ url: REDIS_URL, nodeId, nodeUrl: url, prefix }),
  );

  describe("RedisCluster ข้าม node", () => {
    let a: RedisCluster;
    let b: RedisCluster;
    const prefix = `mskcross:${crypto.randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
      a = await RedisCluster.connect({ url: REDIS_URL, nodeId: "node-a", nodeUrl: "http://a.local", prefix });
      b = await RedisCluster.connect({ url: REDIS_URL, nodeId: "node-b", nodeUrl: "http://b.local", prefix });
    });
    afterAll(async () => {
      await a?.close();
      await b?.close();
    });

    test("node หนึ่งจองห้อง อีก node ค้นเจอว่าอยู่ที่ไหน", async () => {
      await a.claim("room", "CROSS1");
      const found = await b.lookup("room", "CROSS1");
      expect(found).toEqual({ nodeId: "node-a", url: "http://a.local" });
      await a.release("room", "CROSS1");
    });

    test("คิวจับคู่ใช้ร่วมกันข้าม node", async () => {
      expect(await a.enqueue({ sessionId: "x1", nodeId: "node-a", url: "http://a.local" })).toBeNull();
      const matched = await b.enqueue({ sessionId: "x2", nodeId: "node-b", url: "http://b.local" });
      expect(matched).toEqual({ sessionId: "x1", nodeId: "node-a", url: "http://a.local" });
    });

    test("pub/sub ส่งถึงกันข้าม node", async () => {
      const received: any[] = [];
      await a.subscribe("node:node-a", (message) => received.push(message));
      await Bun.sleep(80);
      await b.publish("node:node-a", { type: "redirect", sessionId: "x1", url: "http://b.local" });
      await Bun.sleep(150);
      expect(received.length).toBe(1);
      expect(received[0].url).toBe("http://b.local");
    });

    test("ยอดคนออนไลน์รวมทุก node", async () => {
      await a.heartbeat({ online: 3, inMatch: 2, inQueue: 0 });
      await b.heartbeat({ online: 5, inMatch: 0, inQueue: 1 });
      const totals = await a.totals();
      expect(totals.online).toBe(8);
      expect(totals.inMatch).toBe(2);
      expect(totals.nodes).toBe(2);
    });
  });

  describe("Hub สอง node จับคู่ข้ามเครื่องกัน", () => {
    test("คนที่รออยู่ถูกส่งไปต่อที่ node ของอีกฝ่าย แล้วเปิดแมตช์ได้", async () => {
      const prefix = `mskhub:${crypto.randomUUID().slice(0, 8)}`;
      const clusterA = await RedisCluster.connect({
        url: REDIS_URL!, nodeId: "hub-a", nodeUrl: "http://a.local", prefix,
      });
      const clusterB = await RedisCluster.connect({
        url: REDIS_URL!, nodeId: "hub-b", nodeUrl: "http://b.local", prefix,
      });
      const secret = "shared-secret-for-two-nodes";
      const hubA = new Hub({ cluster: clusterA, defaultTurnSeconds: 0, authSecret: secret });
      const hubB = new Hub({ cluster: clusterB, defaultTurnSeconds: 0, authSecret: secret });

      const alice = new Recorder();
      hubA.handleMessage(alice, { type: "hello", name: "อลิซ" });
      hubA.handleMessage(alice, { type: "quick_match" });
      await Bun.sleep(200);

      const bob = new Recorder();
      hubB.handleMessage(bob, { type: "hello", name: "บ็อบ" });
      hubB.handleMessage(bob, { type: "quick_match" });
      await Bun.sleep(300);

      // อลิซรออยู่ที่ node A แต่บ็อบมาเจอที่ node B → node B เป็นเจ้าของแมตช์
      const redirect = alice.last("redirect");
      expect(redirect?.url).toBe("http://b.local");

      // อลิซย้ายมาต่อที่ node B ด้วย token เดิม
      const aliceToken = alice.last("session")!.token;
      const aliceOnB = new Recorder();
      hubB.handleMessage(aliceOnB, { type: "hello", token: aliceToken });
      await Bun.sleep(100);

      expect(aliceOnB.last("match_start")?.matchId).toBe(bob.last("match_start")?.matchId);
      expect(aliceOnB.last("match_start")?.nodeUrl).toBe("http://b.local");
      expect(aliceOnB.last("state")?.state.board.filter((cell) => cell >= 0).length).toBe(60);

      hubA.dispose();
      hubB.dispose();
    });
  });
} else {
  describe.skip("RedisCluster (ตั้ง TEST_REDIS_URL เพื่อทดสอบ)", () => {
    test("ข้ามไป", () => {});
  });
}

class Recorder implements Connection {
  readonly id = `cluster_conn_${Math.random()}`;
  sessionId: string | null = null;
  messages: ServerMessage[] = [];
  send(message: ServerMessage): void {
    this.messages.push(message);
  }
  close(): void {}
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].type === type) return this.messages[i] as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
}
