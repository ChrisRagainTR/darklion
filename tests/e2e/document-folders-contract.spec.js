// Source-level regression coverage for the additive custom document folder layer.
// These checks stay non-mutating while protecting the existing section/year/category model.

'use strict';

const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test.describe('Custom document folder contracts', () => {
  test('schema keeps custom folders additive and firm scoped', () => {
    const source = read('server/db.js');

    expect(source).toContain('CREATE TABLE IF NOT EXISTS document_folders');
    expect(source).toContain('firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE');
    expect(source).toContain('folder_section TEXT NOT NULL');
    expect(source).toContain('folder_category TEXT NOT NULL');
    expect(source).toContain('ADD COLUMN IF NOT EXISTS document_folder_id');
    expect(source).toContain("ADD COLUMN IF NOT EXISTS folder_subcategory TEXT DEFAULT ''");
  });

  test('staff routes return effective firm/client folders and validate folder placement', () => {
    const source = read('server/routes/documents.js');

    expect(source).toContain("router.get('/folders'");
    expect(source).toContain("router.post('/folders'");
    expect(source).toContain("scope = 'firm' AND applies_to IN ('all', $2)");
    expect(source).toContain('resolveDocumentFolder');
    expect(source).toContain("selectedFolder?.name || ''");
  });

  test('portal exposes staff-defined choices but no folder creation endpoint', () => {
    const route = read('server/routes/portal.js');
    const portal = read('public/portal.html');

    expect(route).toContain("router.get('/document-folders'");
    expect(route).not.toContain("router.post('/document-folders'");
    expect(route).toContain("selectedFolder.folder_section !== 'client_uploaded'");
    expect(portal).toContain("api('/portal/document-folders')");
    expect(portal).toContain('id="uploadFolder"');
    expect(portal).not.toContain('id="addFolder"');
  });

  test('existing staff document screens add folder controls without replacing sections or categories', () => {
    for (const file of ['server/views/crm-company.ejs', 'server/views/crm-person.ejs']) {
      const source = read(file);
      expect(source).toContain('+ Add Folder');
      expect(source).toContain('No custom folder');
      expect(source).toContain('firm_uploaded');
      expect(source).toContain('client_uploaded');
      expect(source).toContain('folder_category');
    }
  });

  test('company CRM inline scripts remain valid after document UI changes', async () => {
    const html = await ejs.renderFile(path.join(repoRoot, 'server/views/crm-company.ejs'), {
      title: 'Company',
      activeNav: 'companies',
    });
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];

    expect(scripts.length).toBeGreaterThan(0);
    for (const [, source] of scripts) expect(() => new Function(source)).not.toThrow();
  });

  test('upload and move pickers show full folder destinations and synchronize placement', () => {
    const company = read('server/views/crm-company.ejs');
    const person = read('server/views/crm-person.ejs');
    const portal = read('public/portal.html');

    expect(company).toContain('syncCompanyFolderPlacement');
    expect(company).toContain('const path = `${sectionLabel} /');
    expect(person).toContain('syncPersonFolderPlacement');
    expect(person).toContain('const path = `${sectionLabel} /');
    expect(portal).toContain('portalFolderDestinations');
    expect(portal).toContain('syncPortalFolderCategory');
  });

  test('native document grouping prefers custom folder name but keeps category fallback', () => {
    const client = read('mobile/src/screens/DocumentsScreen.tsx');
    const staff = read('mobile/src/staff/StaffClientDocumentsScreen.tsx');
    for (const source of [client, staff]) {
      expect(source).toContain('DocumentBrowser');
      expect(source).toContain('toBrowserDoc');
    }
    const compiled = ts.transpileModule(read('mobile/src/components/DocumentBrowser.tsx'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports, require: name => {
      if (name === 'react-native') return { StyleSheet: { create: value => value } };
      if (name === '../theme/tokens') return { colors: {} };
      return {};
    } });
    const convert = module.exports.toBrowserDoc;
    expect(convert({ id: 1, folder_category: 'tax', folder_subcategory: 'Client folder' }).folderLabel).toBe('Client folder');
    expect(convert({ id: 1, folderCategory: 'tax', folderSubcategory: 'Client folder' }).folderLabel).toBe('Client folder');
    expect(convert({ id: 1, folder_category: 'tax', folder_subcategory: '' }).folderLabel).toBe('Tax');
  });
});
