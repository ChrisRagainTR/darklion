'use strict';

/**
 * sign-pdf.js
 * Appends a signature page to an existing PDF using pdf-lib.
 * The signature page includes:
 *  - The signer's drawn or typed signature image
 *  - Their full name, date/time of signing
 *  - IP address (audit trail)
 *  - A legal attestation statement
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

/**
 * Embed signature into a PDF buffer and return a new PDF buffer.
 *
 * @param {Buffer} originalPdfBuffer - The original PDF bytes
 * @param {Object} signerInfo
 * @param {string} signerInfo.name - Full name of signer
 * @param {string} signerInfo.email - Email of signer
 * @param {string} signerInfo.signedAt - ISO timestamp
 * @param {string} signerInfo.signedIp - IP address
 * @param {string} signerInfo.signatureData - Base64 PNG data URL from canvas (or typed name)
 * @param {string} signerInfo.signatureType - 'drawn' or 'typed'
 * @param {string} signerInfo.taxYear - e.g. '2025'
 * @param {string} signerInfo.firmName - Firm name
 * @returns {Promise<Buffer>} - New PDF bytes with signature page appended
 */
async function embedSignature(originalPdfBuffer, signerInfo) {
  const { name, email, signedAt, signedIp, signatureData, signatureType, taxYear, firmName } = signerInfo;

  // Load original PDF
  const pdfDoc = await PDFDocument.load(originalPdfBuffer);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Add a new signature page at the end
  const page = pdfDoc.addPage([612, 792]); // US Letter
  const { width, height } = page.getSize();
  const margin = 60;
  let y = height - margin;

  // Header
  page.drawRectangle({
    x: 0, y: height - 80,
    width, height: 80,
    color: rgb(0.047, 0.098, 0.145), // --navy
  });
  page.drawText('E-Signature Certificate', {
    x: margin, y: height - 50,
    size: 18, font: helveticaBold,
    color: rgb(0.784, 0.659, 0.298), // --gold
  });
  page.drawText(firmName || 'DarkLion', {
    x: margin, y: height - 68,
    size: 10, font: helvetica,
    color: rgb(0.56, 0.639, 0.72),
  });

  y = height - 110;

  // Document info
  const signedDate = new Date(signedAt).toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });

  const drawLabel = (label, value, yPos) => {
    page.drawText(label + ':', { x: margin, y: yPos, size: 9, font: helveticaBold, color: rgb(0.4, 0.4, 0.4) });
    page.drawText(value || '', { x: 160, y: yPos, size: 9, font: helvetica, color: rgb(0.1, 0.1, 0.1) });
    return yPos - 18;
  };

  y = drawLabel('Document', `${taxYear || ''} Tax Return`, y);
  y = drawLabel('Signer', name || '', y);
  y = drawLabel('Email', email || '', y);
  y = drawLabel('Signed On', signedDate, y);
  y = drawLabel('IP Address', signedIp || 'N/A', y);
  y = drawLabel('Method', signatureType === 'typed' ? 'Typed Name' : 'Drawn Signature', y);

  y -= 20;

  // Divider
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 1, color: rgb(0.8, 0.8, 0.8),
  });
  y -= 30;

  // Signature image or typed name
  page.drawText('Signature:', {
    x: margin, y,
    size: 11, font: helveticaBold, color: rgb(0.2, 0.2, 0.2),
  });
  y -= 20;

  if (signatureType === 'drawn' && signatureData && signatureData.startsWith('data:image/png;base64,')) {
    try {
      const base64Data = signatureData.replace('data:image/png;base64,', '');
      const pngBuffer = Buffer.from(base64Data, 'base64');
      const pngImage = await pdfDoc.embedPng(pngBuffer);
      const imgDims = pngImage.scaleToFit(400, 120);
      page.drawImage(pngImage, {
        x: margin, y: y - imgDims.height,
        width: imgDims.width, height: imgDims.height,
        opacity: 1,
      });
      y -= imgDims.height + 15;
    } catch(e) {
      // Fall back to typed display
      page.drawText(name || '', {
        x: margin, y,
        size: 32, font: helvetica, color: rgb(0.1, 0.1, 0.6),
      });
      y -= 50;
    }
  } else {
    // Typed signature — render in large cursive-like style
    page.drawText(name || '', {
      x: margin, y,
      size: 32, font: helvetica, color: rgb(0.1, 0.1, 0.6),
    });
    y -= 50;
  }

  // Signature line
  page.drawLine({
    start: { x: margin, y }, end: { x: margin + 300, y },
    thickness: 1.5, color: rgb(0.2, 0.2, 0.2),
  });
  y -= 14;
  page.drawText(name || '', {
    x: margin, y,
    size: 9, font: helvetica, color: rgb(0.3, 0.3, 0.3),
  });

  y -= 40;

  // Legal attestation
  page.drawLine({
    start: { x: margin, y }, end: { x: width - margin, y },
    thickness: 1, color: rgb(0.8, 0.8, 0.8),
  });
  y -= 20;

  const attestation = [
    'By signing above, the signer acknowledges that they have reviewed the attached tax return in its',
    'entirety, that the information is accurate and complete to the best of their knowledge, and that',
    'this electronic signature has the same legal force and effect as a handwritten signature pursuant',
    'to the Electronic Signatures in Global and National Commerce Act (E-SIGN) and applicable',
    'state electronic signature laws.',
  ];
  for (const line of attestation) {
    page.drawText(line, {
      x: margin, y,
      size: 8, font: helvetica, color: rgb(0.4, 0.4, 0.4),
    });
    y -= 13;
  }

  y -= 15;
  page.drawText(`This document was signed electronically on ${signedDate}`, {
    x: margin, y,
    size: 8, font: helveticaBold, color: rgb(0.3, 0.3, 0.3),
  });

  // Save and return
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { embedSignature };
