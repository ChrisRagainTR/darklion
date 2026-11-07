'use strict';

/**
 * TCP print server — listens on port 9100 for raw PostScript from the printer.
 * When a complete job arrives, pipes it through Ghostscript → PDF → spool dir.
 * No Redmon, no external DLLs. Uses Windows built-in TCP/IP printer port.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

const PORT = 9100;
const SPOOL_DIR = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'DarkLion', 'Spool'
);

// Find Ghostscript executable
function findGhostscript() {
  const candidates = [
    'C:\\Program Files\\gs\\gs10.03.1\\bin\\gswin64c.exe',
    'C:\\Program Files\\gs\\gs10.02.1\\bin\\gswin64c.exe',
    'C:\\Program Files\\gs\\gs10.01.2\\bin\\gswin64c.exe',
    'C:\\Program Files\\gs\\gs10.00.0\\bin\\gswin64c.exe',
    'C:\\Program Files\\gs\\gs9.56.1\\bin\\gswin64c.exe',
  ];
  // Also try glob-style search
  try {
    const gsBase = 'C:\\Program Files\\gs';
    if (fs.existsSync(gsBase)) {
      const versions = fs.readdirSync(gsBase);
      for (const v of versions.reverse()) { // newest first
        const exe = path.join(gsBase, v, 'bin', 'gswin64c.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch (_) {}
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

let server = null;
let onNewPDF = null; // callback(filePath) set by main.js

function startPrintServer(onPDF) {
  onNewPDF = onPDF;

  if (!fs.existsSync(SPOOL_DIR)) {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
  }

  server = net.createServer((socket) => {
    const chunks = [];
    console.log('[print-server] Print job received from', socket.remoteAddress);

    socket.on('data', (chunk) => {
      chunks.push(chunk);
    });

    socket.on('end', () => {
      const psData = Buffer.concat(chunks);
      if (psData.length < 10) {
        console.log('[print-server] Empty job, ignoring.');
        return;
      }
      console.log(`[print-server] Job complete: ${psData.length} bytes`);
      // Extract job title from PostScript %%Title: header
      const jobTitle = extractPSTitle(psData);
      convertToPDF(psData, jobTitle);
    });

    socket.on('error', (err) => {
      console.error('[print-server] Socket error:', err.message);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[print-server] Port 9100 already in use. Is another print agent running?');
    } else {
      console.error('[print-server] Server error:', err.message);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[print-server] Listening on 127.0.0.1:${PORT}`);
  });
}

function stopPrintServer() {
  if (server) {
    server.close();
    server = null;
  }
}

/**
 * Extract the %%Title: line from a PostScript job header.
 * Drake typically sends: %%Title: 2024 Drake Tax Return - Smith, John
 */
function extractPSTitle(psData) {
  try {
    // Only scan the first 4KB — the title is always in the header
    const header = psData.slice(0, 4096).toString('utf8', 0, 4096);
    const match = header.match(/%%Title:\s*(.+)/);
    if (match) {
      return match[1].trim().replace(/\r?\n.*/, ''); // first line only
    }
  } catch (_) {}
  return null;
}

function convertToPDF(psData, jobTitle) {
  const gs = findGhostscript();
  if (!gs) {
    console.error('[print-server] Ghostscript not found! Cannot convert print job.');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(SPOOL_DIR, `print_${timestamp}.pdf`);
  const inPath = path.join(os.tmpdir(), `darklion_job_${Date.now()}.ps`);

  // Write PostScript to temp file
  fs.writeFileSync(inPath, psData);

  console.log(`[print-server] Converting PS → PDF: ${outPath}`);

  const args = [
    '-dBATCH',
    '-dNOPAUSE',
    '-dNOSAFER',
    '-dQUIET',
    '-sDEVICE=pdfwrite',
    '-dPDFSETTINGS=/prepress',  // high quality, searchable text preserved
    '-dEmbedAllFonts=true',
    `-sOutputFile=${outPath}`,
    inPath,
  ];

  execFile(gs, args, (err, stdout, stderr) => {
    // Clean up temp PS file
    try { fs.unlinkSync(inPath); } catch (_) {}

    if (err) {
      console.error('[print-server] Ghostscript error:', err.message);
      return;
    }

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 100) {
      console.error('[print-server] PDF output missing or empty.');
      return;
    }

    console.log(`[print-server] PDF ready: ${outPath} (title: ${jobTitle || 'unknown'})`);
    if (onNewPDF) onNewPDF(outPath, jobTitle || path.basename(outPath, '.pdf'));
  });
}

module.exports = { startPrintServer, stopPrintServer };
