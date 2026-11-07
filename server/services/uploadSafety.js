"use strict";
const net = require("node:net");
const { once } = require("node:events");

function scanBuffer(
  buffer,
  {
    host = process.env.CLAMAV_HOST,
    port = Number(process.env.CLAMAV_PORT || 3310),
    timeoutMs = 30000,
  } = {},
) {
  if (
    !host ||
    !(
      ["localhost", "127.0.0.1", "::1"].includes(host) ||
      host.endsWith(".railway.internal")
    )
  ) {
    return Promise.reject(
      new Error("Private document scanner is not configured"),
    );
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let result = "",
      settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(
      () => done(new Error("Document scan timed out. Try again.")),
      timeoutMs,
    );
    socket.on("error", () =>
      done(new Error("Document scanner unavailable. Try again.")),
    );
    socket.on("end", () => {
      if (!settled) done(new Error("Document scan was interrupted"));
    });
    socket.on("data", (chunk) => {
      result += chunk.toString("utf8");
      if (result.length > 4096)
        return done(new Error("Invalid document scan result"));
      if (!result.includes("\0") && !result.includes("\n")) return;
      const line = result.split(/[\0\n]/)[0].trim();
      if (line === "stream: OK") return done();
      done(
        new Error(
          line.endsWith(" FOUND")
            ? "Upload blocked by document safety checks"
            : "Document could not be scanned. Try a readable, unencrypted file.",
        ),
      );
    });
    socket.on("connect", async () => {
      try {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < buffer.length; offset += 65536) {
          if (settled) return;
          const chunk = buffer.subarray(offset, offset + 65536),
            length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length);
          socket.write(length);
          if (!socket.write(chunk)) await once(socket, "drain");
        }
        socket.write(Buffer.alloc(4));
      } catch (_) {
        done(new Error("Document scan interrupted"));
      }
    });
  });
}

function validateFile(buffer, mimeType) {
  if (
    !Buffer.isBuffer(buffer) ||
    !buffer.length ||
    buffer.length > 50 * 1024 * 1024
  )
    throw Error("File must be between 1 byte and 50 MB");
  const head = buffer.subarray(0, 1024).toString("latin1");
  if (
    head.startsWith("MZ") ||
    head.startsWith("\x7fELF") ||
    /^\s*(?:<\?xml[^>]*>\s*)?<(?:html|svg|script|!doctype html)\b/i.test(head)
  )
    throw Error("Executable and active web files are not allowed");
  if (mimeType === "application/pdf" && !head.includes("%PDF-"))
    throw Error("The uploaded file is not a PDF");
  if (
    mimeType === "image/png" &&
    !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    throw Error("The uploaded file is not a PNG");
  if (
    mimeType === "image/jpeg" &&
    !(buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
  )
    throw Error("The uploaded file is not a JPEG");
}

async function inspectUpload({ firmId, buffer, mimeType }) {
  if (!firmId) throw Error("Owning firm required for uploads");
  const prefs = await require("./firmPreferences").getFirmPreferences(firmId);
  if (prefs.edition !== "public" && !process.env.CLAMAV_HOST) return;
  validateFile(buffer, mimeType);
  // The object is written only after an explicit clean result. Scanner failures
  // never release an unscanned file to clients or create a document record.
  await scanBuffer(buffer);
}
module.exports = { inspectUpload, scanBuffer, validateFile };
