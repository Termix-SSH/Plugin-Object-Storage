import { vi } from "vitest";
import { createHash } from "node:crypto";

interface Stored {
  body: Buffer;
  type: string;
  modified: Date;
}

const esc = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const xml = (body: string, status = 200) =>
  new Response(`<?xml version="1.0"?>${body}`, {
    status,
    headers: { "content-type": "application/xml" },
  });

const error = (status: number, code: string, message = code) =>
  xml(
    `<Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    status,
  );

/** A small in-memory S3 that checks every request is signed. */
export function fakeS3(
  options: { accessKey?: string; pageSize?: number } = {},
) {
  const accessKey = options.accessKey ?? "AKIDEXAMPLE";
  const pageSize = options.pageSize ?? 1000;
  const buckets = new Map<string, Map<string, Stored>>();
  const uploads = new Map<string, Map<number, Buffer>>();
  const subs = new Map<string, string>();
  const calls: Array<{ method: string; url: string; headers: any }> = [];

  const handler = vi.fn(async (rawUrl: string, init: any = {}) => {
    const url = new URL(rawUrl);
    const method = String(init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url: rawUrl, headers });
    const auth = headers.authorization ?? "";
    if (!auth.includes(`Credential=${accessKey}/`)) {
      return error(403, "InvalidAccessKeyId", "The key is wrong");
    }
    if (!headers["x-amz-content-sha256"] || !headers["x-amz-date"]) {
      return error(400, "InvalidRequest", "Not signed");
    }
    if (init.body && Buffer.isBuffer(init.body)) {
      const actual = createHash("sha256").update(init.body).digest("hex");
      if (actual !== headers["x-amz-content-sha256"]) {
        return error(400, "XAmzContentSHA256Mismatch");
      }
    }

    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const bucketName = parts[0];
    const key =
      parts.slice(1).join("/") ||
      (url.pathname.endsWith("/") && parts.length > 1 ? "" : "");
    const rawKey = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ""));
    const q = url.searchParams;

    if (!bucketName) {
      if (method !== "GET") return error(405, "MethodNotAllowed");
      return xml(
        `<ListAllMyBucketsResult><Buckets>${[...buckets.keys()]
          .map(
            (name) =>
              `<Bucket><Name>${esc(name)}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`,
          )
          .join("")}</Buckets></ListAllMyBucketsResult>`,
      );
    }

    if (parts.length === 1) {
      const bucket = buckets.get(bucketName);
      if (method === "PUT" && ![...q.keys()].length) {
        if (buckets.has(bucketName))
          return error(409, "BucketAlreadyOwnedByYou");
        buckets.set(bucketName, new Map());
        return new Response("", { status: 200 });
      }
      if (!bucket) return error(404, "NoSuchBucket");
      if (method === "DELETE" && ![...q.keys()].length) {
        if (bucket.size) return error(409, "BucketNotEmpty");
        buckets.delete(bucketName);
        return new Response(null, { status: 204 });
      }
      if (q.has("versioning")) {
        const stored = subs.get(`${bucketName}:versioning`);
        if (method === "PUT") {
          subs.set(`${bucketName}:versioning`, String(init.body));
          return new Response("", { status: 200 });
        }
        return xml(
          stored
            ? stored.replace(
                "VersioningConfiguration",
                "VersioningConfiguration",
              )
            : "<VersioningConfiguration/>",
        );
      }
      if (q.has("tagging")) {
        const stored = subs.get(`${bucketName}:tagging`);
        if (method === "PUT") {
          subs.set(`${bucketName}:tagging`, String(init.body));
          return new Response("", { status: 200 });
        }
        if (method === "DELETE") {
          subs.delete(`${bucketName}:tagging`);
          return new Response(null, { status: 204 });
        }
        return stored ? xml(stored) : error(404, "NoSuchTagSet");
      }
      if (q.has("policy")) return error(404, "NoSuchBucketPolicy");
      if (q.has("lifecycle") || q.has("cors")) {
        const name = q.has("lifecycle") ? "lifecycle" : "cors";
        const stored = subs.get(`${bucketName}:${name}`);
        if (method === "PUT") {
          if (!headers["content-md5"]) return error(400, "MissingContentMD5");
          subs.set(`${bucketName}:${name}`, String(init.body));
          return new Response("", { status: 200 });
        }
        return stored
          ? xml(stored)
          : error(
              404,
              name === "cors"
                ? "NoSuchCORSConfiguration"
                : "NoSuchLifecycleConfiguration",
            );
      }
      if (q.has("encryption") || q.has("publicAccessBlock")) {
        return error(501, "NotImplemented");
      }
      if (q.has("delete") && method === "POST") {
        if (!headers["content-md5"]) return error(400, "MissingContentMD5");
        const wanted = [
          ...String(init.body).matchAll(/<Key>(.*?)<\/Key>/g),
        ].map((m) => m[1].replace(/&amp;/g, "&"));
        for (const name of wanted) bucket.delete(name);
        return xml("<DeleteResult/>");
      }
      if (method === "GET") {
        const prefix = q.get("prefix") ?? "";
        const delimiter = q.get("delimiter") ?? "";
        const start = Number(q.get("continuation-token") ?? 0);
        const max = Math.min(Number(q.get("max-keys") ?? 1000), pageSize);
        const names = [...bucket.keys()]
          .filter((n) => n.startsWith(prefix))
          .sort();
        const folders = new Set<string>();
        const files: string[] = [];
        for (const name of names) {
          const rest = name.slice(prefix.length);
          const cut = delimiter ? rest.indexOf(delimiter) : -1;
          if (cut >= 0) folders.add(prefix + rest.slice(0, cut + 1));
          else files.push(name);
        }
        const page = files.slice(start, start + max);
        const more = start + max < files.length;
        return xml(
          `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : ""}${page
            .map((name) => {
              const item = bucket.get(name)!;
              return `<Contents><Key>${esc(name)}</Key><Size>${item.body.length}</Size><LastModified>${item.modified.toISOString()}</LastModified><ETag>&quot;abc&quot;</ETag><StorageClass>STANDARD</StorageClass></Contents>`;
            })
            .join(
              "",
            )}${start === 0 ? [...folders].map((f) => `<CommonPrefixes><Prefix>${esc(f)}</Prefix></CommonPrefixes>`).join("") : ""}</ListBucketResult>`,
        );
      }
      return error(405, "MethodNotAllowed");
    }

    const bucket = buckets.get(bucketName);
    if (!bucket) return error(404, "NoSuchBucket");
    void key;

    if (method === "POST" && q.has("uploads")) {
      const id = `up${uploads.size + 1}`;
      uploads.set(id, new Map());
      return xml(
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (method === "PUT" && q.has("partNumber")) {
      const parts2 = uploads.get(q.get("uploadId") ?? "");
      if (!parts2) return error(404, "NoSuchUpload");
      parts2.set(Number(q.get("partNumber")), Buffer.from(init.body));
      return new Response("", {
        status: 200,
        headers: { etag: `"p${q.get("partNumber")}"` },
      });
    }
    if (method === "POST" && q.has("uploadId")) {
      const parts2 = uploads.get(q.get("uploadId") ?? "");
      if (!parts2) return error(404, "NoSuchUpload");
      const ordered = [...parts2.entries()].sort((a, b) => a[0] - b[0]);
      bucket.set(rawKey, {
        body: Buffer.concat(ordered.map(([, b]) => b)),
        type: "application/octet-stream",
        modified: new Date(),
      });
      uploads.delete(q.get("uploadId") ?? "");
      return xml("<CompleteMultipartUploadResult/>");
    }
    if (method === "DELETE" && q.has("uploadId")) {
      uploads.delete(q.get("uploadId") ?? "");
      return new Response(null, { status: 204 });
    }
    if (method === "PUT" && headers["x-amz-copy-source"]) {
      const source = decodeURIComponent(headers["x-amz-copy-source"]).replace(
        /^\//,
        "",
      );
      const [sb, ...sk] = source.split("/");
      const found = buckets.get(sb)?.get(sk.join("/"));
      if (!found) return error(404, "NoSuchKey");
      bucket.set(rawKey, { ...found, modified: new Date() });
      return xml("<CopyObjectResult/>");
    }
    if (method === "PUT") {
      bucket.set(rawKey, {
        body: Buffer.from(init.body ?? ""),
        type: headers["content-type"] ?? "application/octet-stream",
        modified: new Date(),
      });
      return new Response("", { status: 200 });
    }
    if (method === "DELETE") {
      bucket.delete(rawKey);
      return new Response(null, { status: 204 });
    }
    const found = bucket.get(rawKey);
    if (!found)
      return method === "HEAD"
        ? new Response("", { status: 404 })
        : error(404, "NoSuchKey");
    const base = {
      "content-type": found.type,
      etag: '"abc"',
      "last-modified": found.modified.toUTCString(),
      "accept-ranges": "bytes",
    };
    if (method === "HEAD") {
      return new Response("", {
        status: 200,
        headers: {
          ...base,
          "content-length": String(found.body.length),
          "x-amz-meta-owner": "me",
        },
      });
    }
    const range = headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const from = Number(range[1]);
      const to = range[2] ? Number(range[2]) : found.body.length - 1;
      const slice = found.body.subarray(from, to + 1);
      return new Response(new Uint8Array(slice), {
        status: 206,
        headers: {
          ...base,
          "content-range": `bytes ${from}-${to}/${found.body.length}`,
          "content-length": String(slice.length),
        },
      });
    }
    return new Response(new Uint8Array(found.body), {
      status: 200,
      headers: { ...base, "content-length": String(found.body.length) },
    });
  });

  return Object.assign(handler, {
    buckets,
    uploads,
    calls,
    seed(
      bucket: string,
      key: string,
      body: string | Buffer,
      type = "text/plain",
    ) {
      if (!buckets.has(bucket)) buckets.set(bucket, new Map());
      buckets.get(bucket)!.set(key, {
        body: Buffer.from(body),
        type,
        modified: new Date("2026-02-02T00:00:00Z"),
      });
    },
  });
}
