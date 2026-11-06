import { describe, expect, it } from "vitest";
import {
  EMPTY_HASH,
  encodePath,
  presignS3,
  signS3,
} from "../../src/backend/s3/sigv4.js";
import { parseXml, child, childText, all } from "../../src/backend/s3/xml.js";

// The examples from the AWS Signature Version 4 guide for S3
const creds = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const now = new Date("2013-05-24T00:00:00Z");

describe("signing", () => {
  it("matches the AWS header example", () => {
    const headers = signS3({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      headers: { range: "bytes=0-9" },
      payloadHash: EMPTY_HASH,
      now,
      ...creds,
    });
    expect(headers.authorization).toContain(
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers.authorization).toContain(
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date",
    );
  });

  it("matches the AWS presigned URL example", () => {
    const url = presignS3({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      expiresSeconds: 86400,
      now,
      ...creds,
    });
    expect(url).toContain(
      "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(url).toContain("X-Amz-Expires=86400");
  });

  it("encodes each key segment once", () => {
    expect(encodePath("a b/c+d/é!")).toBe("a%20b/c%2Bd/%C3%A9%21");
  });
});

describe("xml", () => {
  it("reads entities, empty tags and repeated nodes", () => {
    const root = parseXml(
      '<?xml version="1.0"?><R xmlns="x"><A>1 &amp; 2</A><E/><I><K>a</K></I><I><K>b&#x2F;c</K></I></R>',
    );
    expect(childText(root, "A")).toBe("1 & 2");
    expect(child(root, "E")?.text).toBe("");
    expect(all(root, "I").map((n) => childText(n, "K"))).toEqual(["a", "b/c"]);
  });
});
