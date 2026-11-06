import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";
import {
  baseName,
  crumbs,
  formatBytes,
  isPreviewImage,
  limitTone,
} from "../../src/frontend/format";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const answers: Record<string, unknown> = {
  "/providers": { providers: [] },
  "/accounts": {
    accounts: [
      {
        id: 1,
        provider: "minio",
        name: "Main",
        endpoint: "http://minio.local:9000",
        region: "us-east-1",
        pathStyle: true,
        hasCa: false,
        status: "ok",
        lastError: null,
        lastCheckAt: null,
      },
    ],
  },
  "/accounts/1/buckets": {
    buckets: [
      {
        name: "docs",
        createdAt: null,
        bytes: 2048,
        objects: 3,
        partial: false,
        scannedAt: null,
        maxBytes: null,
        maxObjects: null,
      },
    ],
  },
};

const api = (overrides: Record<string, unknown> = {}) =>
  ({
    get: vi.fn(async (path: string) => ({
      data: { ...answers, ...overrides }[path],
    })),
  }) as never;

describe(`${manifest.id} activate`, () => {
  it("registers the rail item, tab and dashboard card", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["object-storage"]);
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({
        id: "object-storage",
        permission: "object-storage.view",
      }),
    ]);
  });

  it("lists buckets with their size", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales, api: api() });
    rendered.renderTab("object-storage", { isVisible: true });
    expect(await screen.findByText("docs")).toBeTruthy();
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy();
  });

  it("shows the empty state with no logins", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ "/accounts": { accounts: [] } }),
    });
    rendered.renderTab("object-storage", { isVisible: true });
    expect(await screen.findByText(locales.accounts.empty)).toBeTruthy();
  });
});

describe("format", () => {
  it("shortens sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(null)).toBe("");
  });

  it("splits paths", () => {
    expect(baseName("a/b/c.txt")).toBe("c.txt");
    expect(baseName("a/b/")).toBe("b");
    expect(crumbs("a/b/")).toEqual([
      { name: "a", prefix: "a/" },
      { name: "b", prefix: "a/b/" },
    ]);
    expect(isPreviewImage("x.PNG")).toBe(true);
    expect(limitTone(85)).toBe("warn");
    expect(limitTone(100)).toBe("bad");
  });
});
