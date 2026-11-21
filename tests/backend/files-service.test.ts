import { describe, expect, it, vi } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import {
  registerFilesService,
  type ObjectStorageFilesV1,
} from "../../src/backend/files-service.js";
import type { ObjectStorageService } from "../../src/backend/service.js";

const manifest = manifestJson as unknown as PluginManifest;

function setup(permissions: string[]) {
  const fake = {
    accounts: vi.fn(async () => [
      { id: 1, name: "MinIO", endpoint: "http://minio", provider: "minio" },
    ]),
    buckets: vi.fn(async () => [{ name: "backups" }]),
    putBuffer: vi.fn(async () => {}),
    listAll: vi.fn(async () => [{ key: "a.json", size: 3, modifiedAt: null }]),
    getText: vi.fn(async () => "hello"),
    removeObject: vi.fn(async () => {}),
  };
  const mock = createMockCtx({
    sandbox: true,
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    actor: "user-1",
    permissions,
  });
  registerFilesService(mock.ctx, fake as unknown as ObjectStorageService);
  const files = mock.services.get(
    "object-storage.files",
  ) as ObjectStorageFilesV1;
  return { fake, files };
}

describe("object-storage.files", () => {
  it("lists logins without keys and reads with view", async () => {
    const { files } = setup(["object-storage.view"]);
    expect(await files.accounts()).toEqual([{ id: 1, name: "MinIO" }]);
    expect(await files.buckets(1)).toEqual(["backups"]);
    expect(await files.getText(1, "backups", "a.json")).toBe("hello");
    await expect(files.putText(1, "backups", "b.json", "x")).rejects.toThrow(
      /edit/,
    );
    await expect(files.remove(1, "backups", "a.json")).rejects.toThrow(/edit/);
  });

  it("writes and removes with edit", async () => {
    const { fake, files } = setup([
      "object-storage.view",
      "object-storage.edit",
    ]);
    await files.putText(1, "backups", "b.json", "{}", "application/json");
    expect(fake.putBuffer).toHaveBeenCalledWith(
      1,
      "backups",
      "b.json",
      Buffer.from("{}"),
      "application/json",
    );
    await files.remove(1, "backups", "a.json");
    expect(fake.removeObject).toHaveBeenCalledWith(1, "backups", "a.json");
  });

  it("refuses without permission and with a bad account", async () => {
    const { files } = setup([]);
    await expect(files.accounts()).rejects.toThrow(/view/);
    const ok = setup(["object-storage.view"]).files;
    await expect(ok.buckets(0)).rejects.toThrow(/account/);
  });
});
