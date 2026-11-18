import { describe, expect, it } from "vitest";
import { chunkedGet } from "../../../src/backend/s3/chunked.js";

const DATA = "0123456789abcdefghij";

/** A store that answers ranges like S3 and records each one. */
function store(options: { ranges?: boolean } = {}) {
  const asked: string[] = [];
  const get = async (range: string) => {
    asked.push(range);
    const match = range.match(/^bytes=(\d+)-(\d*)$/);
    if (options.ranges === false || !match) {
      return new Response(DATA, { status: 200 });
    }
    const from = Number(match[1]);
    const to = Math.min(
      match[2] ? Number(match[2]) : DATA.length - 1,
      DATA.length - 1,
    );
    if (from >= DATA.length) return new Response(null, { status: 416 });
    return new Response(DATA.slice(from, to + 1), {
      status: 206,
      headers: {
        "content-type": "text/plain",
        "content-range": `bytes ${from}-${to}/${DATA.length}`,
        "content-length": String(to - from + 1),
      },
    });
  };
  return { asked, get };
}

describe("chunked downloads", () => {
  it("streams a whole object in ranges and answers 200", async () => {
    const s = store();
    const response = await chunkedGet(s.get, undefined, 6);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("20");
    expect(response.headers.get("content-range")).toBeNull();
    expect(await response.text()).toBe(DATA);
    expect(s.asked).toEqual([
      "bytes=0-5",
      "bytes=6-11",
      "bytes=12-17",
      "bytes=18-19",
    ]);
  });

  it("streams an asked range and answers 206", async () => {
    const s = store();
    const response = await chunkedGet(s.get, "bytes=3-12", 4);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 3-12/20");
    expect(await response.text()).toBe(DATA.slice(3, 13));
    expect(s.asked).toEqual(["bytes=3-6", "bytes=7-10", "bytes=11-12"]);
  });

  it("handles an open ended range", async () => {
    const s = store();
    const response = await chunkedGet(s.get, "bytes=15-", 4);
    expect(response.headers.get("content-range")).toBe("bytes 15-19/20");
    expect(await response.text()).toBe("fghij");
  });

  it("passes through a store that ignores ranges, and odd ranges", async () => {
    const plain = store({ ranges: false });
    const whole = await chunkedGet(plain.get, undefined, 4);
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe(DATA);
    expect(plain.asked).toEqual(["bytes=0-3"]);

    const s = store();
    await chunkedGet(s.get, "bytes=-5", 4);
    expect(s.asked).toEqual(["bytes=-5"]);
    const past = await chunkedGet(s.get, "bytes=40-", 4);
    expect(past.status).toBe(416);
  });
});
