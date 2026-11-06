import { describe, expect, it } from "vitest";
import { S3Client } from "../../src/backend/s3/client.js";
import { readSettings, writeSetting } from "../../src/backend/s3/settings.js";

// Runs against a real S3 server when LIVE_S3_ENDPOINT, LIVE_S3_KEY and
// LIVE_S3_SECRET are set. Skipped otherwise.
const endpoint = process.env.LIVE_S3_ENDPOINT;
const live = describe.skipIf(!endpoint);

live("real S3 server", () => {
  const client = new S3Client(
    {
      endpoint: endpoint ?? "",
      region: "us-east-1",
      pathStyle: true,
      accessKeyId: process.env.LIVE_S3_KEY ?? "",
      secretAccessKey: process.env.LIVE_S3_SECRET ?? "",
    },
    fetch as never,
  );
  const bucket = `os-live-${Date.now()}`;

  it("signs, uploads, lists, copies, ranges and deletes", async () => {
    await client.createBucket(bucket);
    expect((await client.listBuckets()).map((b) => b.name)).toContain(bucket);

    await client.put(bucket, "dir/a b+é.txt", Buffer.from("hello world"));
    await client.createFolder(bucket, "empty");
    const list = await client.listObjects(bucket, { delimiter: "/" });
    expect(list.folders.sort()).toEqual(["dir/", "empty/"]);
    const inner = await client.listObjects(bucket, { prefix: "dir/" });
    expect(inner.objects[0]).toMatchObject({ key: "dir/a b+é.txt", size: 11 });

    const head = await client.head(bucket, "dir/a b+é.txt");
    expect(head.size).toBe(11);
    const part = await client.get(bucket, "dir/a b+é.txt", "bytes=6-10");
    expect(await part.text()).toBe("world");

    await client.copy(bucket, "copy.txt", bucket, "dir/a b+é.txt");
    expect(await (await client.get(bucket, "copy.txt")).text()).toBe(
      "hello world",
    );

    const link = client.share(bucket, "copy.txt", 300);
    expect(await (await fetch(link)).text()).toBe("hello world");

    // multipart with two parts
    const id = await client.startUpload(
      bucket,
      "big.bin",
      "application/octet-stream",
    );
    const five = 5 * 1024 * 1024;
    const e1 = await client.uploadPart(
      bucket,
      "big.bin",
      id,
      1,
      Buffer.alloc(five, 1),
    );
    const e2 = await client.uploadPart(
      bucket,
      "big.bin",
      id,
      2,
      Buffer.alloc(10, 2),
    );
    await client.finishUpload(bucket, "big.bin", id, [
      { number: 1, etag: e1 },
      { number: 2, etag: e2 },
    ]);
    expect((await client.head(bucket, "big.bin")).size).toBe(five + 10);

    const failed = await client.removeMany(bucket, [
      "dir/a b+é.txt",
      "empty/",
      "copy.txt",
      "big.bin",
    ]);
    expect(failed).toEqual([]);
    await client.deleteBucket(bucket);
  });

  it("refuses wrong keys", async () => {
    const bad = new S3Client(
      {
        endpoint: endpoint ?? "",
        region: "us-east-1",
        pathStyle: true,
        accessKeyId: "nope",
        secretAccessKey: "nope",
      },
      fetch as never,
    );
    await expect(bad.listBuckets()).rejects.toMatchObject({ status: 403 });
  });

  it("reads and writes bucket settings where supported", async () => {
    const name = `${bucket}-s`;
    await client.createBucket(name);
    const before = await readSettings(client, name);
    console.log("settings support", JSON.stringify(before, null, 1));
    await writeSetting(client, name, "tags", {
      tags: [{ key: "a", value: "b" }],
    }).catch((error) => console.log("tags write:", error.message));
    await client.deleteBucket(name);
  });
});
