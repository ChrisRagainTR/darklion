const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('tax delivery signature regression contracts', () => {
  test('schema stores the combined signed document on the delivery', () => {
    const dbSource = readRepoFile('server/db.js');

    expect(dbSource).toContain(
      'ALTER TABLE tax_deliveries ADD COLUMN IF NOT EXISTS signed_doc_id INTEGER REFERENCES documents(id);'
    );
  });

  test('completion notification can use clientName after PDF generation', () => {
    const portalSource = readRepoFile('server/routes/portal.js');
    const deliveryBlockStart = portalSource.indexOf('if (deliveryRows[0]) {');
    const clientNameDeclaration = portalSource.indexOf(
      "const clientName = `${d.first_name || ''} ${d.last_name || ''}`.trim();",
      deliveryBlockStart
    );
    const pdfTry = portalSource.indexOf('// Generate one combined signed PDF', deliveryBlockStart);
    const activitySummary = portalSource.indexOf(
      "summary: `${clientName || 'Client'} fully signed the ${d.tax_year} tax return.`,",
      deliveryBlockStart
    );

    expect(deliveryBlockStart).toBeGreaterThanOrEqual(0);
    expect(clientNameDeclaration).toBeGreaterThan(deliveryBlockStart);
    expect(clientNameDeclaration).toBeLessThan(pdfTry);
    expect(activitySummary).toBeGreaterThan(pdfTry);
  });

  test('repeat submissions return the existing result without rerunning completion work', () => {
    const portalSource = readRepoFile('server/routes/portal.js');
    const signRouteStart = portalSource.indexOf("router.post('/tax-deliveries/:id/sign'");
    const alreadySignedGuard = portalSource.indexOf('if (signer.signed_at) {', signRouteStart);
    const signatureUpdate = portalSource.indexOf('UPDATE tax_delivery_signers SET', signRouteStart);

    expect(signRouteStart).toBeGreaterThanOrEqual(0);
    expect(alreadySignedGuard).toBeGreaterThan(signRouteStart);
    expect(alreadySignedGuard).toBeLessThan(signatureUpdate);
    expect(portalSource.slice(alreadySignedGuard, signatureUpdate)).toContain('alreadySigned: true');
  });
});
