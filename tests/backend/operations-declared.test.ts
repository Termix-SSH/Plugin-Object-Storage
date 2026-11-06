import { describe, expect, it } from "vitest";
import { parseManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../manifest.json";
import {
  parseAccount,
  registerOperations,
} from "../../src/backend/operations.js";
import type { ObjectStorageService } from "../../src/backend/service.js";

type Declared = {
  id: string;
  risk: string;
  permission: string;
  dryRun?: string;
};

const actions = (
  manifest.contributes as { operations: { actions: Declared[] } }
).operations.actions;

type Handler = {
  run: (input: Record<string, unknown>) => Promise<any>;
  describe?: (input: Record<string, unknown>) => Promise<string>;
};

const calls: string[] = [];
const service = {
  accounts: async () => [
    { id: 1, name: "Main", provider: "minio", status: "ok" },
    { id: 2, name: "Old", provider: "aws", status: "error" },
  ],
  buckets: async () => [
    { name: "docs", bytes: 2048, objects: 3 },
    { name: "new", bytes: null, objects: null },
  ],
  summary: async () => ({
    accounts: 2,
    failingAccounts: 1,
    buckets: 2,
    bytes: 2048,
    overQuota: [{ account: "Main", bucket: "docs", percent: 120 }],
  }),
  listObjects: async () => ({
    folders: ["a/"],
    objects: [{ key: "b.txt", size: 5 }],
  }),
  createBucket: async (_id: number, name: string) => {
    calls.push(`create ${name}`);
    return { bucket: name };
  },
  removeObjects: async (_id: number, bucket: string, input: any) => {
    calls.push(`delete ${bucket} ${input.keys}`);
    return { deleted: 1, failed: [] };
  },
  share: async () => ({ url: "https://x/y", expiresAt: "later" }),
} as unknown as ObjectStorageService;

const handlers = new Map<string, Handler>();
registerOperations(
  {
    operations: {
      register: (id: string, handler: never) => handlers.set(id, handler),
    },
  } as unknown as PluginContext,
  service,
);

describe("declared actions", () => {
  it("is a valid manifest", () => {
    expect(parseManifest(manifest).errors ?? []).toEqual([]);
  });

  it("has a handler for every declared action and nothing else", () => {
    expect([...handlers.keys()].sort()).toEqual(
      actions.map((a) => a.id).sort(),
    );
  });

  it("describes every change before it runs", () => {
    for (const action of actions) {
      if (action.risk !== "read") {
        expect(["edit", "manage"]).toContain(action.permission);
        expect(action.dryRun).toBeTruthy();
      }
    }
  });
});

describe("handlers", () => {
  it("reads a login value", () => {
    expect(parseAccount("3")).toBe(3);
    expect(() => parseAccount("nope")).toThrow("Pick a login");
  });

  it("flags failing logins", async () => {
    const result = await handlers.get("object-storage.list-accounts")!.run({});
    expect(result.data).toMatchObject({ status: "fail", value: 1 });
    expect(result.data.options[0]).toEqual({ value: "1", label: "Main" });
  });

  it("lists buckets with sizes", async () => {
    const result = await handlers
      .get("object-storage.list-buckets")!
      .run({ account: "1" });
    expect(result.data.rows[0]).toMatchObject({ name: "docs", size: "2.0 KB" });
  });

  it("fails the limits signal when a bucket is over", async () => {
    const result = await handlers.get("object-storage.usage")!.run({});
    expect(result.data.status).toBe("fail");
    expect(result.summary).toBe("1 buckets near their limit");
  });

  it("lists folders and objects", async () => {
    const result = await handlers
      .get("object-storage.list-objects")!
      .run({ account: "1", bucket: "docs" });
    expect(result.summary).toBe("1 folders, 1 objects");
  });

  it("describes and runs the changes", async () => {
    expect(
      await handlers.get("object-storage.create-bucket")!.describe!({
        name: "x",
      }),
    ).toBe("Would create the bucket x");
    await handlers
      .get("object-storage.create-bucket")!
      .run({ account: "1", name: "x" });
    await handlers
      .get("object-storage.delete-object")!
      .run({ account: "1", bucket: "docs", key: "b.txt" });
    expect(calls).toEqual(["create x", "delete docs b.txt"]);
    await expect(
      handlers
        .get("object-storage.delete-object")!
        .run({ account: "1", bucket: "docs" }),
    ).rejects.toThrow("Object is required");
  });
});
