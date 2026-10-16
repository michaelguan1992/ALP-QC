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

const { assertUploadRequestSize, readAttachmentFile } = await import("../qc-attachments.js");
const { DOCUMENT_MAX_BYTES, UPLOAD_REQUEST_MAX_BYTES } = await import("../../core/qc-domain.js");

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
    }, { maxBytes: DOCUMENT_MAX_BYTES });

    assert.equal(payload.mimeType, mimeType);
    assert.equal(payload.dataUrl, `data:${mimeType};base64,SGVsbG8=`);
  }
});

test("rejects one upload request whose selected files exceed the request budget before reading them", () => {
  const maximalFile = { name: "maximum.mp4", size: DOCUMENT_MAX_BYTES };
  assert.equal(assertUploadRequestSize([maximalFile, maximalFile, maximalFile]), 3 * DOCUMENT_MAX_BYTES);
  assert.equal(assertUploadRequestSize([{ size: UPLOAD_REQUEST_MAX_BYTES }]), UPLOAD_REQUEST_MAX_BYTES);
  assert.throws(() => assertUploadRequestSize([maximalFile, maximalFile, maximalFile, { name: "extra.pdf", size: 5 * 1024 * 1024 }]),
    /64 MiB.*Add fewer files at a time/);
});
