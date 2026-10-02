import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  addEventListener() {},
};
globalThis.window = { setTimeout };

const { loadAssetContent } = await import("../qc-attachments.js");

test("lazy asset content is cached within one service and isolated across workspaces", async () => {
  let firstReads = 0;
  let secondReads = 0;
  const firstService = {
    async getAsset() {
      firstReads += 1;
      return { id: "asset-1", name: "photo.jpg", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,Zmlyc3Q=", contentRevision: "same" };
    },
  };
  const secondService = {
    async getAsset() {
      secondReads += 1;
      return { id: "asset-1", name: "photo.jpg", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,c2Vjb25k", contentRevision: "same" };
    },
  };
  const metadata = { id: "asset-1", name: "photo.jpg", mimeType: "image/jpeg", contentRevision: "same", decodedBytes: 5 };

  const first = await loadAssetContent(metadata, firstService);
  const cached = await loadAssetContent(metadata, firstService);
  const otherWorkspace = await loadAssetContent(metadata, secondService);

  assert.equal(first.dataUrl, "data:image/jpeg;base64,Zmlyc3Q=");
  assert.equal(cached.dataUrl, first.dataUrl);
  assert.equal(otherWorkspace.dataUrl, "data:image/jpeg;base64,c2Vjb25k");
  assert.equal(firstReads, 1);
  assert.equal(secondReads, 1);
});
