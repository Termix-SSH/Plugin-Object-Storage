import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { fakeS3 } from "./fake-s3.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

let db: TestDb;
let mock: MockPluginContext;
let server: http.Server;
let port: number;
let s3: ReturnType<typeof fakeS3>;

async function setup(permissions: string[]) {
  db = await createTestDb(pluginDir);
  db.sqlite
    .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
    .run("user-1", "user-1");
  let routes: Router | null = null;
  mock = createMockCtx({
    sandbox: true,
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (routes = express.Router()),
    permissions,
    fetch: s3 as never,
  });
  await activate(mock.ctx);
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    mock.setActor("user-1");
    next();
  });
  app.use((req, res, next) => routes!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
}

async function raw(method: string, path: string, body?: unknown, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body
      ? { "content-type": "application/json", ...headers }
      : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function request(method: string, path: string, body?: unknown) {
  const response = await raw(method, path, body);
  return { status: response.status, body: await response.json() };
}

const ALL = ["view", "edit", "manage"].map((n) => `object-storage.${n}`);

async function addAccount(key = "AKIDEXAMPLE") {
  const created = await request("POST", "/accounts", {
    provider: "minio",
    name: "Main",
    endpoint: "http://minio.local:9000",
    region: "us-east-1",
    pathStyle: true,
    accessKeyId: key,
    secretAccessKey: "secret-value",
  });
  expect(created.status).toBe(201);
  return created.body.id as number;
}

const B = (id: number, bucket = "docs") => `/accounts/${id}/buckets/${bucket}`;

beforeEach(async () => {
  s3 = fakeS3();
  await setup(ALL);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("accounts", () => {
  it("lists the providers", async () => {
    const result = await request("GET", "/providers");
    expect(result.body.providers.map((p: { id: string }) => p.id)).toContain(
      "minio",
    );
  });

  it("stores the keys sealed and never sends them back", async () => {
    await addAccount();
    const list = await request("GET", "/accounts");
    expect(list.body.accounts).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("secret-value");
    expect(JSON.stringify(list.body)).not.toContain("AKIDEXAMPLE");
  });

  it("refuses a duplicate name, a bad endpoint and missing keys", async () => {
    await addAccount();
    const dupe = await request("POST", "/accounts", {
      provider: "minio",
      name: "Main",
      endpoint: "http://x.local",
      region: "r",
      accessKeyId: "a",
      secretAccessKey: "b",
    });
    expect(dupe.status).toBe(409);
    const bad = await request("POST", "/accounts", {
      provider: "minio",
      name: "Other",
      endpoint: "ftp://x",
      region: "r",
      accessKeyId: "a",
      secretAccessKey: "b",
    });
    expect(bad.status).toBe(400);
    const none = await request("POST", "/accounts", {
      provider: "minio",
      name: "Third",
      endpoint: "http://x.local",
      region: "r",
    });
    expect(none.status).toBe(400);
  });

  it("tests the login and reports refused keys", async () => {
    const good = await addAccount();
    s3.seed("docs", "a.txt", "hi");
    expect((await request("POST", `/accounts/${good}/test`)).body).toEqual({
      buckets: 1,
    });
    const bad = await request("POST", "/accounts", {
      provider: "minio",
      name: "Bad",
      endpoint: "http://minio.local:9000",
      region: "us-east-1",
      accessKeyId: "WRONG",
      secretAccessKey: "x",
    });
    const refused = await request("POST", `/accounts/${bad.body.id}/test`);
    expect(refused.status).toBe(403);
    const list = await request("GET", "/accounts");
    expect(
      list.body.accounts.find((a: { name: string }) => a.name === "Bad").status,
    ).toBe("error");
  });

  it("keeps the saved keys when an edit leaves them empty", async () => {
    const id = await addAccount();
    await request("PUT", `/accounts/${id}`, { name: "Renamed" });
    expect((await request("POST", `/accounts/${id}/test`)).status).toBe(200);
  });

  it("sends only the endpoint host as an allowed private host", async () => {
    const id = await addAccount();
    await request("POST", `/accounts/${id}/test`);
    const call = s3.mock.calls[0][1] as { allowPrivateHosts: string[] };
    expect(call.allowPrivateHosts).toEqual(["minio.local"]);
  });
});

describe("buckets and objects", () => {
  it("creates, lists and deletes a bucket", async () => {
    const id = await addAccount();
    expect(
      (await request("POST", `/accounts/${id}/buckets`, { name: "docs" }))
        .status,
    ).toBe(201);
    const bad = await request("POST", `/accounts/${id}/buckets`, {
      name: "Bad Name",
    });
    expect(bad.status).toBe(400);
    const list = await request("GET", `/accounts/${id}/buckets`);
    expect(list.body.buckets.map((b: { name: string }) => b.name)).toEqual([
      "docs",
    ]);
    s3.seed("docs", "x", "1");
    expect((await request("DELETE", B(id))).status).toBe(409);
    await request("POST", `${B(id)}/delete`, { keys: ["x"] });
    expect((await request("DELETE", B(id))).status).toBe(200);
  });

  it("lists folders and objects and pages through results", async () => {
    const id = await addAccount();
    s3.seed("docs", "a.txt", "aa");
    s3.seed("docs", "dir/b.txt", "bbb");
    for (let i = 0; i < 3; i++) s3.seed("docs", `f${i}.txt`, "x");
    const top = await request("GET", `${B(id)}/objects?prefix=`);
    expect(top.body.folders).toEqual(["dir/"]);
    expect(top.body.objects.map((o: { key: string }) => o.key)).toContain(
      "a.txt",
    );
    const inner = await request("GET", `${B(id)}/objects?prefix=dir/`);
    expect(inner.body.objects[0]).toMatchObject({ key: "dir/b.txt", size: 3 });
  });

  it("reads details with metadata", async () => {
    const id = await addAccount();
    s3.seed("docs", "a b/ü.txt", "hello");
    const head = await request(
      "GET",
      `${B(id)}/head?key=${encodeURIComponent("a b/ü.txt")}`,
    );
    expect(head.body).toMatchObject({
      size: 5,
      contentType: "text/plain",
      metadata: { owner: "me" },
    });
  });

  it("downloads whole and by range, and sends risky types as downloads", async () => {
    const id = await addAccount();
    s3.seed("docs", "a.txt", "0123456789");
    s3.seed("docs", "page.html", "<script>1</script>", "text/html");
    const full = await raw("GET", `${B(id)}/download?key=a.txt`);
    expect(await full.text()).toBe("0123456789");
    expect(full.headers.get("content-disposition")).toContain("attachment");
    const part = await raw("GET", `${B(id)}/download?key=a.txt`, undefined, {
      range: "bytes=2-4",
    });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("234");
    const html = await raw("GET", `${B(id)}/download?key=page.html&inline=1`);
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("content-security-policy")).toBe("sandbox");
    const text = await raw("GET", `${B(id)}/download?key=a.txt&inline=1`);
    expect(text.headers.get("content-disposition")).toContain("inline");
    const missing = await raw("GET", `${B(id)}/download?key=none`);
    expect(missing.status).toBe(404);
  });

  it("uploads a small file in one request", async () => {
    const id = await addAccount();
    s3.seed("docs", "keep", "1");
    const form = new FormData();
    form.append("file", new Blob(["hello"]), "dir/hello.txt");
    const response = await fetch(
      `http://127.0.0.1:${port}${B(id)}/upload?prefix=up/`,
      { method: "POST", body: form },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).saved).toEqual(["up/dir/hello.txt"]);
    expect(
      s3.buckets.get("docs")!.get("up/dir/hello.txt")!.body.toString(),
    ).toBe("hello");
  });

  it("uploads a big file in parts", async () => {
    const id = await addAccount();
    s3.seed("docs", "keep", "1");
    const big = Buffer.alloc(8 * 1024 * 1024 * 2 + 1234, 7);
    const form = new FormData();
    form.append("file", new Blob([big]), "big.bin");
    const response = await fetch(
      `http://127.0.0.1:${port}${B(id)}/upload?prefix=`,
      { method: "POST", body: form },
    );
    expect(response.status).toBe(200);
    const stored = s3.buckets.get("docs")!.get("big.bin")!;
    expect(stored.body.length).toBe(big.length);
    expect(stored.body.equals(big)).toBe(true);
    expect(s3.uploads.size).toBe(0);
  });

  it("refuses an upload with no file", async () => {
    const id = await addAccount();
    s3.seed("docs", "keep", "1");
    const response = await fetch(
      `http://127.0.0.1:${port}${B(id)}/upload?prefix=`,
      { method: "POST", body: new FormData() },
    );
    expect(response.status).toBe(400);
  });

  it("deletes a folder with everything in it", async () => {
    const id = await addAccount();
    s3.seed("docs", "dir/a", "1");
    s3.seed("docs", "dir/sub/b", "2");
    s3.seed("docs", "other", "3");
    const result = await request("POST", `${B(id)}/delete`, {
      prefixes: ["dir/"],
    });
    expect(result.body).toEqual({ deleted: 2, failed: [] });
    expect([...s3.buckets.get("docs")!.keys()]).toEqual(["other"]);
  });

  it("copies, moves and renames folders", async () => {
    const id = await addAccount();
    s3.seed("docs", "a/x", "1");
    s3.seed("docs", "a/y/z", "2");
    expect(
      (
        await request("POST", `${B(id)}/copy`, {
          from: "a",
          to: "copy",
          folder: true,
        })
      ).body,
    ).toEqual({ count: 2 });
    await request("POST", `${B(id)}/move`, { from: "a/x", to: "moved" });
    expect([...s3.buckets.get("docs")!.keys()].sort()).toEqual([
      "a/y/z",
      "copy/x",
      "copy/y/z",
      "moved",
    ]);
    const same = await request("POST", `${B(id)}/move`, {
      from: "moved",
      to: "moved",
    });
    expect(same.status).toBe(400);
  });

  it("makes a folder and a temporary link", async () => {
    const id = await addAccount();
    s3.seed("docs", "a.txt", "1");
    await request("POST", `${B(id)}/folder`, { prefix: "new" });
    expect(s3.buckets.get("docs")!.has("new/")).toBe(true);
    const link = await request("POST", `${B(id)}/share`, {
      key: "a.txt",
      seconds: 999_999_999,
    });
    const url = new URL(link.body.url);
    expect(url.pathname).toBe("/docs/a.txt");
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBe(7 * 86_400);
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
});

describe("bucket settings", () => {
  it("reads settings and marks missing ones as empty or unsupported", async () => {
    const id = await addAccount();
    s3.seed("docs", "a", "1");
    const result = await request("GET", `${B(id)}/settings`);
    expect(result.body.versioning).toEqual({ supported: true, status: "Off" });
    expect(result.body.lifecycle).toEqual({ supported: true, rules: [] });
    expect(result.body.policy).toEqual({ supported: true, text: "" });
    expect(result.body.encryption.supported).toBe(false);
    expect(result.body.publicAccess.supported).toBe(false);
  });

  it("saves lifecycle, tags and versioning", async () => {
    const id = await addAccount();
    s3.seed("docs", "a", "1");
    await request("PUT", `${B(id)}/settings/lifecycle`, {
      rules: [
        {
          id: "old",
          prefix: "logs/",
          enabled: true,
          expireDays: 30,
          noncurrentDays: null,
          abortUploadDays: 7,
        },
      ],
    });
    await request("PUT", `${B(id)}/settings/tags`, {
      tags: [{ key: "team", value: "a&b" }],
    });
    await request("PUT", `${B(id)}/settings/versioning`, { status: "Enabled" });
    const read = (await request("GET", `${B(id)}/settings`)).body;
    expect(read.lifecycle.rules[0]).toMatchObject({
      id: "old",
      prefix: "logs/",
      expireDays: 30,
      abortUploadDays: 7,
    });
    expect(read.tags.tags).toEqual([{ key: "team", value: "a&b" }]);
    expect(read.versioning.status).toBe("Enabled");
  });

  it("refuses an invalid policy and an unknown setting", async () => {
    const id = await addAccount();
    s3.seed("docs", "a", "1");
    expect(
      (await request("PUT", `${B(id)}/settings/policy`, { text: "{nope" }))
        .status,
    ).toBe(400);
    expect((await request("PUT", `${B(id)}/settings/other`, {})).status).toBe(
      400,
    );
  });
});

describe("usage and limits", () => {
  it("counts a bucket across pages and keeps the reading", async () => {
    s3 = fakeS3({ pageSize: 2 });
    await afterEachReset();
    const id = await addAccount();
    for (let i = 0; i < 5; i++) s3.seed("docs", `f${i}`, "xxxx");
    const scan = await request("POST", `${B(id)}/scan`);
    expect(scan.body).toEqual({ bytes: 20, objects: 5, partial: false });
    const list = await request("GET", `/accounts/${id}/buckets`);
    expect(list.body.buckets[0]).toMatchObject({ bytes: 20, objects: 5 });
    const history = await request("GET", `${B(id)}/usage`);
    expect(history.body.points).toHaveLength(1);
  });

  it("alerts once when a bucket passes its limit", async () => {
    const id = await addAccount();
    for (let i = 0; i < 3; i++) s3.seed("docs", `f${i}`, "xxxx");
    await request("PUT", `${B(id)}/limit`, { maxBytes: 10 });
    await request("POST", `${B(id)}/scan`);
    await request("POST", `${B(id)}/scan`);
    const sent = mock.notifications.filter(
      (item) => item.notification.category === "object-storage.alert",
    );
    expect(sent).toHaveLength(1);
    const summary = await request("GET", "/summary");
    expect(summary.body.overQuota[0]).toMatchObject({
      bucket: "docs",
      percent: 120,
    });
  });

  it("removes readings with the login", async () => {
    const id = await addAccount();
    s3.seed("docs", "a", "1");
    await request("POST", `${B(id)}/scan`);
    await request("DELETE", `/accounts/${id}`);
    expect((await request("GET", "/accounts")).body.accounts).toEqual([]);
  });
});

describe("permissions", () => {
  it("lets a viewer read but not change anything", async () => {
    const id = await addAccount();
    s3.seed("docs", "a", "1");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    s3 = fakeS3();
    s3.seed("docs", "a", "1");
    await setup(["object-storage.view"]);
    expect((await request("GET", "/accounts")).status).toBe(200);
    expect(
      (await request("POST", `${B(id)}/delete`, { keys: ["a"] })).status,
    ).toBe(403);
    expect((await request("POST", "/accounts", { name: "x" })).status).toBe(
      403,
    );
  });
});

async function afterEachReset() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  await setup(ALL);
}
