import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  addEventListener() {},
};
globalThis.window = { setTimeout };
globalThis.FileReader = class FakeFileReader {
  handlers = new Map();
  addEventListener(type, handler) { this.handlers.set(type, handler); }
  readAsDataURL(file) {
    this.result = file.dataUrl;
    queueMicrotask(() => this.handlers.get("load")?.());
  }
};

const { readAttachmentFile } = await import("../qc-attachments.js");

test("uses the extension MIME type in the data URL when the browser reports octet-stream", async () => {
  for (const [name, mimeType] of [
    ["inspection.log", "text/plain"],
    ["workbook.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ]) {
    const payload = await readAttachmentFile({
      name,
      type: "application/octet-stream",
      size: 4,
      dataUrl: "data:application/octet-stream;base64,SGVsbG8=",
    }, { maxBytes: 10 * 1024 * 1024 });

    assert.equal(payload.mimeType, mimeType);
    assert.equal(payload.dataUrl, `data:${mimeType};base64,SGVsbG8=`);
  }
});
