"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const {
  scanBuffer,
  validateFile,
} = require("../../server/services/uploadSafety");
test("uploads reject executable content disguised as documents", () => {
  assert.throws(
    () => validateFile(Buffer.from("MZbad"), "application/pdf"),
    /Executable/,
  );
  assert.throws(
    () => validateFile(Buffer.from('<svg onload="attack()">'), "image/png"),
    /active web/,
  );
  assert.throws(
    () => validateFile(Buffer.from("wrong"), "application/pdf"),
    /not a PDF/,
  );
  validateFile(Buffer.from("%PDF-1.7 synthetic"), "application/pdf");
});
test("scanner streams exact bytes and rejects infected, error, or missing results", async () => {
  for (const result of [
    "stream: OK\0",
    "stream: Synthetic FOUND\0",
    "stream: size exceeded ERROR\0",
    "",
  ]) {
    let received = Buffer.alloc(0);
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0),
        header = false;
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!header) {
          if (buffer.length < 10) return;
          assert.equal(buffer.subarray(0, 10).toString(), "zINSTREAM\0");
          buffer = buffer.subarray(10);
          header = true;
        }
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE();
          if (buffer.length < 4 + size) return;
          received = Buffer.concat([received, buffer.subarray(4, 4 + size)]);
          buffer = buffer.subarray(4 + size);
          if (size === 0) {
            socket.end(result);
            return;
          }
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const data = Buffer.alloc(70000, 65);
      const pending = scanBuffer(data, {
        host: "127.0.0.1",
        port: server.address().port,
        timeoutMs: 1000,
      });
      if (result === "stream: OK\0") await pending;
      else await assert.rejects(pending);
      assert.deepEqual(received, data);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  await assert.rejects(
    scanBuffer(Buffer.from("test"), { host: "untrusted.example" }),
    /Private/,
  );
});
