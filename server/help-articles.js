'use strict';

/**
 * DarkLion Help Center — Article Registry
 * Each article has: slug, title, section, keywords, body (plain text for search), and html content.
 */

const articles = [

  // ─── GETTING STARTED ───────────────────────────────────────────────────────

  {
    slug: 'what-is-darklion',
    title: 'What Is DarkLion?',
    section: 'Getting Started',
    keywords: ['overview', 'introduction', 'platform', 'taxdome', 'replace'],
    prev: null,
    next: { slug: 'key-concepts', title: 'Key Concepts' },
    body: 'DarkLion is a full practice management platform for CPA firms. It replaces TaxDome with a system built AI-native from the ground up.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Getting Started</span><span class="sep">›</span>
  <span>What Is DarkLion?</span>
</div>
<h1 class="article-title">What Is DarkLion?</h1>
<div class="article-meta">Section: Getting Started</div>
<div class="article-body">

<p>DarkLion is a full practice management platform built for accounting and wealth-management firms. It's designed to replace TaxDome as the central hub for managing clients, documents, workflows, messaging, and tax preparation — with AI built in from the ground up rather than bolted on top.</p>

<h2>What You Can Do in DarkLion</h2>

<ul>
  <li><strong>CRM</strong> — Manage every client household (Relationship), their individual members (People), and their business entities (Companies) in one place.</li>
  <li><strong>Documents</strong> — Upload, organize, and deliver documents to clients securely. Clients download them from their portal.</li>
  <li><strong>Client Portal</strong> — Every client gets a secure login where they can view documents, send messages, upload financials, and sign returns.</li>
  <li><strong>Pipelines</strong> — Track every client's progress through your tax return process with a visual kanban board. Move cards, set stages, automate actions.</li>
  <li><strong>Messaging</strong> — Send and receive secure messages with clients directly inside DarkLion. No more email for sensitive client communication.</li>
  <li><strong>Tax Organizer</strong> — Send clients a personalized document checklist. They upload directly. You get a compiled workpaper PDF.</li>
  <li><strong>Proposals</strong> — Create and send engagement proposals. Clients sign electronically.</li>
  <li><strong>Emma AI</strong> — An AI agent with full access to the firm's data. Ask Emma anything about your clients, pipelines, or workload.</li>
</ul>

<h2>Who Built It</h2>
<p>DarkLion was built by LedgerHQ and released as free, open-source software. It's API-first — meaning everything a human staff member can do, Emma (the AI agent) can do via the same endpoints. Nothing is a workaround; the AI capabilities are structural.</p>

<h2>The Core Philosophy</h2>
<div class="callout tip"><span class="callout-icon">💡</span><div>Every competitor bolts AI on top of an existing system. DarkLion is built AI-native from day one. The same API you use in the browser is what Emma uses. No separate "AI mode" — it's the same system.</div></div>

<p>DarkLion is designed around a single principle: a CPA firm should never have to leave the platform to serve a client. Documents, communication, workflow, signing, and AI assistance all live in one place.</p>

</div>
    `
  },

  {
    slug: 'key-concepts',
    title: 'Key Concepts',
    section: 'Getting Started',
    keywords: ['relationship', 'company', 'person', 'hierarchy', 'structure', 'data model'],
    prev: { slug: 'what-is-darklion', title: 'What Is DarkLion?' },
    next: { slug: 'first-client', title: 'Your First Client' },
    body: 'DarkLion organizes everything around three entities: Relationships, Companies, and People. Understanding this hierarchy is essential.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Getting Started</span><span class="sep">›</span>
  <span>Key Concepts</span>
</div>
<h1 class="article-title">Key Concepts</h1>

<div class="article-meta">Section: Getting Started</div>
<div class="article-body">

<p>DarkLion organizes all client data around three core entities. Understanding how they relate to each other is the foundation for using the platform effectively.</p>

<h2>The Three-Level Hierarchy</h2>

<pre><code>Relationship  →  the household or group (top-level)
├── Companies →  legal entities (S-Corp, LLC, Trust, 1040, etc.)
└── People    →  individuals with portal logins</code></pre>

<h3>Relationship</h3>
<p>A <strong>Relationship</strong> is the top-level container — it represents a household or group. For most clients, this is their family unit (e.g., "The Smith Family"). For business-only clients, it might be their company group (e.g., "Smith Group").</p>
<ul>
  <li>Billing happens at the Relationship level</li>
  <li>Every Company and every Person belongs to one Relationship</li>
  <li>Notes, service tier, and pipeline history are tracked here</li>
</ul>

<h3>People</h3>
<p><strong>People</strong> are the individuals inside a Relationship — the taxpayer, their spouse, adult children with their own accounts, etc. Each Person:</p>
<ul>
  <li>Can have their own client portal login</li>
  <li>Has their own personal tax records (filing status, SSN, DOB)</li>
  <li>Can be linked to a spouse (for MFJ filers)</li>
  <li>Can have access to one or more Companies</li>
</ul>

<h3>Companies</h3>
<p><strong>Companies</strong> are legal business entities — S-Corps, LLCs, partnerships, trusts, or even a joint 1040 filed as an entity. Each Company:</p>
<ul>
  <li>Belongs to one Relationship</li>
  <li>Can connect to QuickBooks Online for bookkeeping</li>
  <li>Has its own document folder, pipeline cards, and workflow</li>
  <li>Can have multiple People with access (e.g., both spouses see the S-Corp)</li>
</ul>

<div class="callout info"><span class="callout-icon">ℹ️</span><div><strong>Real example:</strong> The Smith Family is a Relationship. John Smith and Jane Smith are People. Smith Holdings LLC is a Company. Both Chris and Sara have access to the Company, but each has their own portal login.</div></div>

<h2>Why This Matters</h2>
<p>Almost everything in DarkLion — documents, messages, pipelines, portals — is attached to one of these three entity types. When you upload a document, you choose whether it belongs to a Person or a Company. When you create a pipeline, you decide if it tracks Companies or People. Understanding this structure makes every other feature click into place.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>When in doubt: <strong>Relationship</strong> = the family/group. <strong>People</strong> = individuals who log in. <strong>Companies</strong> = business entities that file separately or have their own books.</div></div>

</div>
    `
  },

  {
    slug: 'first-client',
    title: 'Your First Client',
    section: 'Getting Started',
    keywords: ['add client', 'new client', 'setup', 'onboard', 'invite', 'create relationship'],
    prev: { slug: 'key-concepts', title: 'Key Concepts' },
    next: { slug: 'crm-overview', title: 'CRM Overview' },
    body: 'Step by step guide to adding your first client in DarkLion: creating a relationship, adding people, adding companies, and inviting them to the portal.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Getting Started</span><span class="sep">›</span>
  <span>Your First Client</span>
</div>
<h1 class="article-title">Your First Client</h1>

<div class="article-meta">Section: Getting Started</div>
<div class="article-body">

<p>Here's how to get a new client fully set up in DarkLion — from creating their record to getting them into the portal.</p>

<h2>Step 1 — Create a Relationship</h2>
<ol class="step-list">
  <li>Go to <strong>CRM</strong> in the left sidebar.</li>
  <li>On the <strong>Relationships</strong> tab, click <strong>+ New Relationship</strong>.</li>
  <li>Enter the household name (e.g., "The Smith Family"), service tier, and billing status.</li>
  <li>Click <strong>Save</strong>.</li>
</ol>

<h2>Step 2 — Add People</h2>
<ol class="step-list">
  <li>Click into the Relationship you just created.</li>
  <li>On the <strong>People</strong> tab, click <strong>+ Add Person</strong>.</li>
  <li>Fill in: first name, last name, email, phone, filing status, date of birth.</li>
  <li>If married filing jointly, set filing status to <strong>MFJ</strong> — you'll be able to link a spouse after adding them.</li>
  <li>Click <strong>Save</strong>.</li>
  <li>Repeat for a spouse if applicable, then link them together on the person's edit modal.</li>
</ol>

<h2>Step 3 — Add Companies (if applicable)</h2>
<ol class="step-list">
  <li>On the <strong>Companies</strong> tab of the CRM, click <strong>+ New Company</strong>.</li>
  <li>Enter the company name, entity type (S-Corp, LLC, etc.), and assign to the correct Relationship.</li>
  <li>Set bookkeeping service type: <strong>Firm Manages</strong> (you do their books) or <strong>Client Prepared</strong> (they do their own books).</li>
  <li>Click <strong>Save</strong>. Portal access is auto-granted to People in the same Relationship.</li>
</ol>

<h2>Step 4 — Invite the Client to Their Portal</h2>
<ol class="step-list">
  <li>Open the Person record in the CRM.</li>
  <li>On the <strong>Overview</strong> tab, click <strong>Send Portal Invite</strong>.</li>
  <li>An email goes to the client with a link to set their password and access their portal.</li>
  <li>Once they accept, their portal is live — they'll see their documents, companies, and messaging.</li>
</ol>

<div class="callout tip"><span class="callout-icon">💡</span><div>You don't have to invite clients to the portal right away. You can use DarkLion for internal tracking first and invite them when you're ready to share documents.</div></div>

<h2>What's Next</h2>
<p>With your first client set up, you can:</p>
<ul>
  <li><a href="/help/article/uploading-documents">Upload documents</a> to their record</li>
  <li><a href="/help/article/creating-pipelines">Add them to a pipeline</a> to track their return</li>
  <li><a href="/help/article/sending-organizer">Send them a tax organizer</a> for document collection</li>
  <li><a href="/help/article/sending-messages">Send them a message</a> through the portal</li>
</ul>

</div>
    `
  },

  // ─── CRM ───────────────────────────────────────────────────────────────────

  {
    slug: 'crm-overview',
    title: 'CRM Overview',
    section: 'CRM',
    keywords: ['crm', 'clients', 'contacts', 'manage', 'search', 'filter'],
    prev: { slug: 'first-client', title: 'Your First Client' },
    next: { slug: 'relationships', title: 'Managing Relationships' },
    body: 'The CRM is the central hub for all client records. Three tabs: Relationships, People, Companies. Click any row to open the full detail page.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>CRM</span><span class="sep">›</span>
  <span>CRM Overview</span>
</div>
<h1 class="article-title">CRM Overview</h1>

<div class="article-meta">Section: CRM</div>
<div class="article-body">

<p>The CRM (Client Relationship Manager) is the central hub for all client data in DarkLion. Navigate to it using the <strong>🗂️ CRM</strong> link in the left sidebar.</p>

<h2>The Three Tabs</h2>
<ul>
  <li><strong>Relationships</strong> — All client households and groups. This is the primary view for most staff work.</li>
  <li><strong>People</strong> — All individuals across all relationships. Useful when you need to look someone up by name or email.</li>
  <li><strong>Companies</strong> — All business entities. Filter by entity type or bookkeeping service.</li>
</ul>

<h2>Searching and Filtering</h2>
<p>Each tab has a <strong>Filter…</strong> search box that filters the list in real time. You can also use the global search bar at the top of any DarkLion page (the magnifying glass) to search across all three entity types at once.</p>

<h2>Detail Pages</h2>
<p>Click any row in the CRM to open the full detail page for that entity. Each detail page has tabs specific to that entity type:</p>
<ul>
  <li><strong>Person detail:</strong> Overview · Docs · Tax · Communication · Organizers · Workflow · Notes</li>
  <li><strong>Company detail:</strong> Overview · Docs · Tax · Bookkeeping · Communication · Organizers · Workflow · Notes</li>
  <li><strong>Relationship detail:</strong> Overview · Notes · Billing</li>
</ul>

<h2>Adding New Records</h2>
<ul>
  <li><strong>+ New Relationship</strong> — on the Relationships tab</li>
  <li><strong>+ New Person</strong> — on the People tab</li>
  <li><strong>+ New Company</strong> — on the Companies tab</li>
</ul>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>When you add a Company, portal access is automatically granted to all People in the same Relationship. You don't need to manually link them.</div></div>

</div>
    `
  },

  {
    slug: 'relationships',
    title: 'Managing Relationships',
    section: 'CRM',
    keywords: ['relationship', 'household', 'service tier', 'billing status', 'legacy blueprint', 'full service', 'tax only'],
    prev: { slug: 'crm-overview', title: 'CRM Overview' },
    next: { slug: 'people', title: 'Managing People' },
    body: 'Relationships are the top-level container for a client household. They hold service tier, billing status, and link all People and Companies for a family or group.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>CRM</span><span class="sep">›</span>
  <span>Managing Relationships</span>
</div>
<h1 class="article-title">Managing Relationships</h1>

<div class="article-meta">Section: CRM</div>
<div class="article-body">

<p>A <strong>Relationship</strong> is the top-level container for a client household or group — for example, "The Smith Family." Everything in DarkLion ultimately ties back to a Relationship: the People who can log into the portal, the Companies they own, the billing subscription, and the pipeline history for the whole household.</p>

<h2>Creating a Relationship</h2>
<ol class="step-list">
  <li>Go to <strong>CRM</strong> in the sidebar → click the <strong>Relationships</strong> tab.</li>
  <li>Click <strong>+ New Relationship</strong>.</li>
  <li>Fill in:
    <ul>
      <li><strong>Name</strong> — The household name (e.g., "The Smith Family" or "Smith Group").</li>
      <li><strong>Service Tier</strong> — The level of service this client receives.</li>
      <li><strong>Billing Status</strong> — The current subscription status.</li>
    </ul>
  </li>
  <li>Click <strong>Save</strong>.</li>
</ol>

<h2>Service Tiers</h2>
<ul>
  <li><strong>Legacy BluePrint</strong> (<code>legacy_blueprint</code>) — Comprehensive, full-service client with estate and legacy planning. The highest-touch service tier.</li>
  <li><strong>Full Service</strong> (<code>full_service</code>) — Full-service advisory and tax client.</li>
  <li><strong>Tax Only</strong> (<code>tax_only</code>) — Tax preparation services only, no advisory component.</li>
</ul>

<h2>Billing Status</h2>
<ul>
  <li><strong>Active</strong> — Subscription current and in good standing.</li>
  <li><strong>Past Due</strong> — Payment overdue; subscription may be at risk.</li>
  <li><strong>Cancelled</strong> — Subscription has been cancelled. Client is no longer active.</li>
</ul>

<h2>Relationship Detail Page</h2>
<p>Click any Relationship in the list to open its detail page. The detail page has three tabs:</p>

<h3>Overview Tab</h3>
<ul>
  <li>Lists all <strong>People</strong> linked to this Relationship with their portal status.</li>
  <li>Lists all <strong>Companies</strong> linked to this Relationship with entity type and bookkeeping service.</li>
  <li><strong>Pipeline History</strong> — All completed and active pipeline runs for this household. You can see at a glance what tax returns have been filed, what engagements are in progress, and the full workflow history without digging through the pipeline board.</li>
</ul>

<h3>Notes Tab</h3>
<p>Free-text internal notes visible only to staff — not accessible from the client portal. Use this for household context, special instructions, billing notes, or anything you want your team to know about this client group.</p>

<h3>Billing Tab</h3>
<p>Stripe subscription information for this Relationship. Shows the linked subscription, billing cycle, and payment status. Full billing management is coming soon — currently shows subscription data read from Stripe.</p>

<h2>Editing a Relationship</h2>
<ol class="step-list">
  <li>Open the Relationship detail page.</li>
  <li>Click the <strong>Edit</strong> button in the entity header (top of the page).</li>
  <li>A modal opens with fields for name, service tier, and billing status.</li>
  <li>Make your changes and click <strong>Save</strong>.</li>
</ol>

<div class="callout tip"><span class="callout-icon">💡</span><div>The Pipeline History on the Overview tab is one of the most useful views in DarkLion — it gives you a complete record of every workflow run for a household without needing to open the pipeline boards one at a time.</div></div>

</div>
    `
  },

  {
    slug: 'people',
    title: 'Managing People',
    section: 'CRM',
    keywords: ['person', 'individual', 'client', 'filing status', 'spouse', 'SSN', 'date of birth', 'portal login', 'workflow tab'],
    prev: { slug: 'relationships', title: 'Managing Relationships' },
    next: { slug: 'companies', title: 'Managing Companies' },
    body: 'People are individual clients who can log into the client portal. Each person has personal tax info, a filing status, optional spouse linking, and a full workflow view.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>CRM</span><span class="sep">›</span>
  <span>Managing People</span>
</div>
<h1 class="article-title">Managing People</h1>

<div class="article-meta">Section: CRM</div>
<div class="article-body">

<p><strong>People</strong> are the individual clients in DarkLion — the taxpayer, their spouse, adult children, or any person who has their own portal login and tax records. Each Person belongs to one Relationship (household) but can have access to multiple Companies.</p>

<h2>Person Fields</h2>
<p>When creating or editing a Person, you'll fill in the following fields across a two-column modal:</p>

<h3>Left Column — Personal Information</h3>
<ul>
  <li><strong>First Name / Last Name</strong></li>
  <li><strong>Email</strong> — Used as the portal login. Must be unique across the firm.</li>
  <li><strong>Phone</strong> — Used for SMS notifications (if enabled).</li>
  <li><strong>Date of Birth</strong> — Stored encrypted. Used for age-related calculations and RMD tracking.</li>
  <li><strong>Filing Status</strong> — Single, MFJ (Married Filing Jointly), MFS (Married Filing Separately), HOH (Head of Household), or Qualifying Widow.</li>
  <li><strong>SSN</strong> — Stored encrypted. Only the last 4 digits are shown in the UI.</li>
  <li><strong>Billing Method</strong> — How this person is billed for services.</li>
  <li><strong>StanfordTax URL</strong> — Legacy field linking to their StanfordTax organizer. Being replaced by the DarkLion native organizer.</li>
</ul>

<h3>Right Column — Address & Notes</h3>
<ul>
  <li>Address Line 1 / Line 2</li>
  <li>City, State, Zip</li>
  <li>Internal notes for this individual</li>
</ul>

<h3>Spouse Section (MFJ/MFS Only)</h3>
<p>When filing status is MFJ or MFS, a full-width Spouse section appears below the two columns. You can link this person to their spouse's Person record. Linked spouses:</p>
<ul>
  <li>Share access to the same Companies</li>
  <li>Can each log into the portal independently with their own credentials</li>
  <li>See the same documents and messages (for shared entities)</li>
</ul>

<h2>Portal Status</h2>
<p>The <strong>Overview tab</strong> of each Person record shows their current portal status:</p>
<ul>
  <li><strong>Not Invited</strong> — No invite has been sent yet.</li>
  <li><strong>Invite Pending</strong> — Invite was sent but the client hasn't activated their account.</li>
  <li><strong>Active</strong> — Client has logged in and their account is active.</li>
</ul>

<h2>Person Detail Tabs</h2>
<ul>
  <li><strong>Overview</strong> — Portal status, linked relationship, spouse, quick stats.</li>
  <li><strong>Docs</strong> — All documents belonging to this person, organized by year and category.</li>
  <li><strong>Tax</strong> — Tax-related fields and prior year data.</li>
  <li><strong>Communication</strong> — All message threads with this person.</li>
  <li><strong>Organizers</strong> — All tax organizers sent to this person.</li>
  <li><strong>Workflow</strong> — Active pipeline cards across all pipelines for this person.</li>
  <li><strong>Notes</strong> — Internal staff notes.</li>
</ul>

<h2>The Workflow Tab</h2>
<p>The Workflow tab gives you a complete view of this person's active pipeline cards without leaving their record:</p>
<ul>
  <li>Shows all active cards across every pipeline this person is enrolled in.</li>
  <li><strong>+ Create Card</strong> — Add this person to a pipeline directly from their record (choose pipeline and starting stage).</li>
  <li><strong>← → Stage Buttons</strong> — Move the card one stage backward or forward without going to the kanban board.</li>
  <li><strong>⚡ Fire Trigger</strong> — Manually fire a pipeline trigger for this person (e.g., simulate an organizer submission for testing).</li>
</ul>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>SSN and Date of Birth are encrypted at rest using AES-256 encryption. Even if the database were compromised, these fields would be unreadable without the encryption key.</div></div>

</div>
    `
  },

  {
    slug: 'companies',
    title: 'Managing Companies',
    section: 'CRM',
    keywords: ['company', 'entity', 's-corp', 'llc', 'partnership', 'trust', 'bookkeeping', 'quickbooks', 'QBO', 'firm manages', 'client prepared'],
    prev: { slug: 'people', title: 'Managing People' },
    next: { slug: 'search', title: 'Search' },
    body: 'Companies are legal business entities like S-Corps, LLCs, and trusts. Each company can connect to QuickBooks Online and has its own bookkeeping, documents, and workflow.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>CRM</span><span class="sep">›</span>
  <span>Managing Companies</span>
</div>
<h1 class="article-title">Managing Companies</h1>

<div class="article-meta">Section: CRM</div>
<div class="article-body">

<p><strong>Companies</strong> in DarkLion represent legal business entities — an S-Corp, LLC, Partnership, Trust, or even a joint 1040 being tracked as a discrete entity. Each Company belongs to one Relationship and has its own documents, pipeline cards, bookkeeping connection, and portal presence.</p>

<h2>Entity Types</h2>
<ul>
  <li><strong>1040</strong> — Joint individual return treated as an entity for tracking purposes.</li>
  <li><strong>S-Corp</strong> — S Corporation (1120-S return).</li>
  <li><strong>LLC</strong> — Limited Liability Company (may file as partnership, S-Corp, or disregarded entity).</li>
  <li><strong>Partnership</strong> — Partnership return (1065).</li>
  <li><strong>Trust</strong> — Trust or estate (1041).</li>
  <li><strong>Sole Proprietorship</strong> — Schedule C filer with business activity.</li>
  <li><strong>Other</strong> — Any other entity type.</li>
</ul>

<h2>Company Fields</h2>
<ul>
  <li><strong>Company Name</strong></li>
  <li><strong>Entity Type</strong> — From the list above.</li>
  <li><strong>Relationship</strong> — Which household this entity belongs to.</li>
  <li><strong>Tax Year End</strong> — End of the fiscal year (e.g., 12/31 for calendar year filers).</li>
  <li><strong>Billing Method</strong> — How this company is billed for services.</li>
  <li><strong>Bookkeeping Service</strong> — Either Firm Manages or Client Prepared (see below).</li>
  <li><strong>Address</strong> — Business address (line 1, line 2, city, state, zip).</li>
</ul>

<h2>Bookkeeping Service Types</h2>

<h3>Firm Manages</h3>
<p>Your firm handles the bookkeeping for this entity in QuickBooks Online. When set to Firm Manages:</p>
<ul>
  <li>Staff connects QuickBooks from the <strong>Bookkeeping tab</strong> on the Company record.</li>
  <li>The Bookkeeping tab shows full sub-tabs: <strong>Close Package · Uncategorized · P&L Variance · Liability Health · Statements · Statement Calendar</strong>.</li>
  <li>Staff can generate a Tax Prep package from the Docs tab: click <strong>Send to Tax Prep</strong> → DarkLion pulls P&L + Balance Sheet + Trial Balance from QBO → generates a branded PDF → saves to documents and fires the <code>tax_financials_generated</code> trigger.</li>
</ul>

<h3>Client Prepared</h3>
<p>The client manages their own books. DarkLion gives the client an option in their portal to:</p>
<ul>
  <li><strong>Connect QuickBooks Online</strong> — OAuth flow directly from the client portal.</li>
  <li><strong>Upload P&L and Balance Sheet PDFs</strong> — If they don't use QBO.</li>
</ul>
<p>When the client submits their financials, they appear in the Company's Docs tab under "Uploaded by Client" and the <code>client_financials_submitted</code> trigger fires.</p>

<h2>Connecting QuickBooks Online</h2>
<ol class="step-list">
  <li>Open the Company record → click the <strong>Bookkeeping tab</strong>.</li>
  <li>If no QuickBooks account is connected, you'll see the full connect card.</li>
  <li>Click <strong>Connect QuickBooks</strong> — a QBO OAuth popup opens.</li>
  <li>Authorize DarkLion to access the QuickBooks company.</li>
  <li>The popup closes and the connection is live.</li>
</ol>

<p>If the QBO token expires (tokens expire every 100 days), a red <strong>Disconnected</strong> badge appears on the Bookkeeping tab. Click <strong>Reconnect</strong> to re-authorize.</p>

<h2>Company Detail Tabs</h2>
<ul>
  <li><strong>Overview</strong> — Summary, linked relationship, people with access.</li>
  <li><strong>Docs</strong> — Documents for this company, plus the Send to Tax Prep button.</li>
  <li><strong>Tax</strong> — Tax-specific fields and prior year data.</li>
  <li><strong>Bookkeeping</strong> — QuickBooks connection and bookkeeping tools.</li>
  <li><strong>Communication</strong> — Message threads related to this company.</li>
  <li><strong>Organizers</strong> — Any organizers sent for this entity.</li>
  <li><strong>Workflow</strong> — Active pipeline cards for this company.</li>
  <li><strong>Notes</strong> — Internal staff notes.</li>
</ul>

<h2>Portal Access</h2>
<p>When a Company is created, portal access is automatically granted to all People in the same Relationship. Each person will see a tab for this company in their portal. No manual linking required.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>The <strong>Send to Tax Prep</strong> button (on the Docs tab for Firm Manages companies) is one of the biggest time-savers in DarkLion — one click pulls the full QBO trial balance, P&L, and balance sheet and generates a presentation-ready PDF ready to attach to the tax file.</div></div>

</div>
    `
  },

  {
    slug: 'search',
    title: 'Search',
    section: 'CRM',
    keywords: ['search', 'find', 'global search', 'filter', 'lookup', 'magnifying glass'],
    prev: { slug: 'companies', title: 'Managing Companies' },
    next: null,
    body: 'DarkLion has two search tools: a global search across all entities, and per-tab filters on each CRM list. Use global search when you are not sure where something lives.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>CRM</span><span class="sep">›</span>
  <span>Search</span>
</div>
<h1 class="article-title">Search</h1>

<div class="article-meta">Section: CRM</div>
<div class="article-body">

<p>DarkLion gives you two ways to find clients and entities: a <strong>global search</strong> that spans the entire platform, and <strong>per-tab filters</strong> on each CRM list view.</p>

<h2>Global Search</h2>
<p>The <strong>magnifying glass icon</strong> in the top header is available on every page in DarkLion. Click it (or press the keyboard shortcut) to open the global search bar.</p>

<p>Global search looks across all three entity types simultaneously:</p>
<ul>
  <li><strong>Relationships</strong> — Searches by relationship name.</li>
  <li><strong>People</strong> — Searches by first name, last name, and email address.</li>
  <li><strong>Companies</strong> — Searches by company name.</li>
</ul>

<p>Results are returned grouped by entity type with icons so you can immediately tell what kind of record you're looking at. Click any result to navigate directly to that entity's full detail page.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>Use global search when you don't know if something is a person or a company — for example, if a client calls and you only have their last name. Search returns all matching entities at once so you don't have to check three tabs.</div></div>

<h2>Per-Tab Filters</h2>
<p>Each CRM tab (Relationships, People, Companies) has a <strong>Filter…</strong> search box directly above the list. As you type, the list filters in real time — no page reload, no submit button.</p>

<ul>
  <li><strong>Relationships tab filter</strong> — Filters by relationship name.</li>
  <li><strong>People tab filter</strong> — Filters by name and email.</li>
  <li><strong>Companies tab filter</strong> — Filters by company name and relationship name.</li>
</ul>

<p>The per-tab filter is faster for situations where you already know what type of record you're looking for and just need to narrow down a long list.</p>

<h2>When to Use Which</h2>
<ul>
  <li><strong>Global search</strong> — Don't know if it's a person or company; have a name or email; want to navigate directly to a record.</li>
  <li><strong>Tab filter</strong> — Already on the right tab; want to scroll through a filtered list rather than navigate to one specific record.</li>
</ul>

</div>
    `
  },

  // ─── DOCUMENTS ──────────────────────────────────────────────────────────────

  {
    slug: 'documents-overview',
    title: 'Documents Overview',
    section: 'Documents',
    keywords: ['documents', 'files', 'upload', 'download', 'S3', 'storage', 'folders', 'organize'],
    prev: null,
    next: { slug: 'uploading-documents', title: 'Uploading Documents' },
    body: 'DarkLion stores all client documents securely in AWS S3. Documents are organized by owner, year, and category. Clients see only what you choose to deliver to them.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Documents</span><span class="sep">›</span>
  <span>Documents Overview</span>
</div>
<h1 class="article-title">Documents Overview</h1>

<div class="article-meta">Section: Documents</div>
<div class="article-body">

<p>DarkLion stores all client documents securely in AWS S3. Every document is organized by who owns it, what year it belongs to, and what category it falls under. Clients only see documents that have been delivered to them — everything else is private to your firm.</p>

<h2>Document Ownership</h2>
<p>Every document in DarkLion belongs to either a <strong>Person</strong> or a <strong>Company</strong>. This determines which tab it appears on in the CRM and in the client portal.</p>
<ul>
  <li><strong>Person documents</strong> — Personal tax returns, W-2s, 1099s, individual documents</li>
  <li><strong>Company documents</strong> — Business tax returns, financial statements, bookkeeping docs</li>
</ul>

<h2>Folder Structure</h2>
<p>Within each owner, documents are organized by:</p>
<ul>
  <li><strong>Section:</strong> <code>Delivered by Advisor</code> (firm uploaded) or <code>Uploaded by Client</code> (client uploaded)</li>
  <li><strong>Year:</strong> Tax year the document belongs to (e.g., 2025, 2024)</li>
  <li><strong>Category:</strong> Tax, Bookkeeping, or Other</li>
</ul>

<h2>Security</h2>
<p>Documents are never served directly from S3. Every download generates a short-lived signed URL that expires after 15 minutes. This means:</p>
<ul>
  <li>You cannot share a document link with someone and have it work indefinitely</li>
  <li>Documents are fully protected even if someone guesses the URL</li>
  <li>All downloads are logged in the audit trail</li>
</ul>

<div class="callout tip"><span class="callout-icon">💡</span><div>Documents are managed from within individual client records. Open a Person or Company in the CRM and go to their <strong>Docs</strong> tab to upload, deliver, or manage their files.</div></div>

</div>
    `
  },

  {
    slug: 'uploading-documents',
    title: 'Uploading Documents',
    section: 'Documents',
    keywords: ['upload', 'document', 'file', 'S3', 'drag drop', 'tax year', 'category', 'move', 'delete'],
    prev: { slug: 'documents-overview', title: 'Documents Overview' },
    next: { slug: 'delivering-to-clients', title: 'Delivering to Clients' },
    body: 'How to upload documents to a client record in DarkLion, choose the right year and category, and manage documents after upload.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Documents</span><span class="sep">›</span>
  <span>Uploading Documents</span>
</div>
<h1 class="article-title">Uploading Documents</h1>

<div class="article-meta">Section: Documents</div>
<div class="article-body">

<p>Documents in DarkLion are always uploaded to a specific client — either a Person or a Company. Files go directly to AWS S3 and are never stored on your local machine or DarkLion's servers.</p>

<h2>How to Upload</h2>
<ol class="step-list">
  <li>Go to <strong>CRM</strong> → find the person or company → open their record.</li>
  <li>Click the <strong>Docs</strong> tab.</li>
  <li>Click the <strong>↑ Upload Document</strong> button.</li>
  <li>The upload modal opens. You can <strong>drag and drop</strong> a file into the drop zone, or click to open a file picker.</li>
  <li>Choose:
    <ul>
      <li><strong>Tax Year</strong> — Defaults to the firm's active tax year. Change if uploading a prior-year document.</li>
      <li><strong>Category</strong> — Tax, Bookkeeping, or Other.</li>
      <li><strong>Section</strong> — "Delivered by Advisor" is the default for staff uploads. This determines whether the client can see it (see <a href="/help/article/delivering-to-clients">Delivering to Clients</a>).</li>
    </ul>
  </li>
  <li>Click <strong>Upload</strong>. The file uploads to S3 and appears in the folder tree immediately.</li>
</ol>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>Maximum file size is <strong>50MB per file</strong>. For larger files (e.g., multi-year archived returns), split them before uploading. Common formats accepted: PDF, Excel, Word, images.</div></div>

<h2>After Upload</h2>
<p>Once uploaded, the document appears in the folder tree under the correct year and category. From the document row you can:</p>

<h3>Move a Document</h3>
<ol class="step-list">
  <li>Find the document row and click the <strong>↕ Move</strong> button.</li>
  <li>A modal lets you change the <strong>Tax Year</strong>, <strong>Section</strong>, or <strong>Category</strong>.</li>
  <li>Click <strong>Save</strong>. The document is re-filed immediately.</li>
</ol>
<p>Use Move when you uploaded to the wrong year, or when you want to change a document from a private section to a delivered section.</p>

<h3>Delete a Document</h3>
<ol class="step-list">
  <li>Find the document row and click the <strong>🗑 Delete</strong> button.</li>
  <li>A confirmation dialog appears.</li>
  <li>Confirm — the file is permanently deleted from both S3 and the database.</li>
</ol>
<div class="callout warning"><span class="callout-icon">⚠️</span><div>Document deletion is <strong>permanent</strong> and cannot be undone. Make sure you have the correct file before confirming.</div></div>



</div>
    `
  },

  {
    slug: 'delivering-to-clients',
    title: 'Delivering to Clients',
    section: 'Documents',
    keywords: ['deliver', 'visible', 'client view', 'new badge', 'viewed', 'portal documents', 'share document'],
    prev: { slug: 'uploading-documents', title: 'Uploading Documents' },
    next: { slug: 'document-folders', title: 'Folder Structure' },
    body: 'Documents are not visible to clients by default. Learn how to deliver documents to the client portal so they can view and download them.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Documents</span><span class="sep">›</span>
  <span>Delivering to Clients</span>
</div>
<h1 class="article-title">Delivering to Clients</h1>

<div class="article-meta">Section: Documents</div>
<div class="article-body">

<p>When you upload a document to DarkLion, it is <strong>private by default</strong> — clients cannot see it. You choose when to deliver it. This gives you full control: upload a return, review it internally, then deliver it to the client when it's ready.</p>

<h2>How to Deliver a Document</h2>

<h3>Option A: Deliver at Upload Time</h3>
<ol class="step-list">
  <li>When uploading, set the <strong>Section</strong> to "Delivered by Advisor".</li>
  <li>Make sure the <strong>Deliver to Client</strong> toggle is on (it defaults to on when this section is selected).</li>
  <li>Click Upload — the document is immediately visible in the client's portal.</li>
</ol>

<h3>Option B: Upload First, Deliver Later</h3>
<ol class="step-list">
  <li>Upload the document privately (keep the section as the internal/private section).</li>
  <li>When you're ready to deliver, find the document row in the Docs tab.</li>
  <li>Click <strong>↕ Move</strong> → change the Section to "Delivered by Advisor" → toggle delivery on → Save.</li>
  <li>The document is now visible to the client.</li>
</ol>

<h2>What the Client Sees</h2>
<p>Once delivered, the document appears in the client's portal under the <strong>"Delivered by Your Advisor"</strong> section, organized by year and category.</p>
<ul>
  <li><strong>✦ NEW badge</strong> — Shown on documents the client hasn't viewed yet, or that were delivered less than 30 days ago.</li>
  <li><strong>✓ Viewed badge</strong> — Shown after the client opens or downloads the document, or after 30 days have passed.</li>
</ul>

<h2>Delivery and View Timestamps</h2>
<ul>
  <li><strong>Delivery timestamp</strong> — Recorded the moment you deliver the document. Visible in the document details.</li>
  <li><strong>View timestamp</strong> — Recorded when the client first opens or downloads the file. This is how you know a client has actually seen their return.</li>
</ul>

<h2>Delivering Documents</h2>
<p>To deliver a document, open the client's record in the CRM (Person or Company), go to their <strong>Docs</strong> tab, find the file, and use the <strong>Deliver</strong> action. Delivered documents immediately appear in the client's portal with a "New" badge.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>A common workflow: upload the signed return PDF to the client's Docs tab → keep it private → review it → when you're ready to tell the client their return is done, deliver the document AND send them a portal message. Both arrive at the same time.</div></div>

</div>
    `
  },

  {
    slug: 'document-folders',
    title: 'Folder Structure',
    section: 'Documents',
    keywords: ['folders', 'structure', 'organize', 'year', 'category', 'tax', 'bookkeeping', 'sections', 'previous years'],
    prev: { slug: 'delivering-to-clients', title: 'Delivering to Clients' },
    next: null,
    body: 'How documents are organized in DarkLion: two top-level sections, then by year and category. Current and prior years are expanded by default; older years are collapsed.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Documents</span><span class="sep">›</span>
  <span>Folder Structure</span>
</div>
<h1 class="article-title">Folder Structure</h1>

<div class="article-meta">Section: Documents</div>
<div class="article-body">

<p>Documents in DarkLion are organized in a consistent folder structure that's the same whether you're looking at a Person, a Company, or the client's portal view. Here's how it works.</p>

<h2>Top-Level Sections</h2>
<p>Every owner (Person or Company) has two top-level sections:</p>
<ul>
  <li><strong>"Delivered by Your Advisor"</strong> (<code>firm_uploaded</code>) — Documents that your firm has uploaded and delivered to this client. This is the "advisor to client" direction.</li>
  <li><strong>"Uploaded by You"</strong> (<code>client_uploaded</code>) — Documents the client has uploaded themselves through the portal. This is the "client to advisor" direction.</li>
</ul>

<h2>Within Each Section: Years</h2>
<p>Inside each section, documents are grouped by tax year:</p>
<ul>
  <li>The <strong>current year</strong> and <strong>prior year</strong> are expanded by default so you can see them without clicking.</li>
  <li><strong>"Previous Years"</strong> is a collapsed group containing all older years. Click to expand and see documents from 2022, 2021, etc.</li>
</ul>

<h2>Within Each Year: Categories</h2>
<p>Within each year, documents are grouped by category:</p>
<ul>
  <li><strong>Person documents:</strong> Tax · Other</li>
  <li><strong>Company documents:</strong> Tax · Bookkeeping · Other</li>
</ul>
<p>Documents with unrecognized categories automatically fall into "Other" — nothing gets lost if a document is miscategorized.</p>

<h2>Staff View vs. Client View</h2>
<p>The folder structure is identical for staff (in the CRM) and clients (in the portal), with one difference:</p>
<ul>
  <li><strong>Staff view</strong> — Shows all three sections: "Delivered by Your Advisor," "Uploaded by Client," and any internal/private documents. Staff can see everything.</li>
  <li><strong>Client view</strong> — Shows only what has been delivered to them. Private/internal documents are completely invisible. Clients also see their own uploads under "Uploaded by You."</li>
</ul>

<h2>Visual Summary</h2>
<pre><code>📁 Delivered by Your Advisor
  📅 2025 (expanded)
    📂 Tax
      📄 2025 Tax Return.pdf
    📂 Other
  📅 2024 (expanded)
    📂 Tax
      📄 2024 Tax Return.pdf
  📁 Previous Years (collapsed)
    📅 2023
    📅 2022

📁 Uploaded by Client
  📅 2025
    📂 Tax
      📄 W-2 from Employer.pdf</code></pre>

<div class="callout tip"><span class="callout-icon">💡</span><div>The "Previous Years" collapse keeps the folder tree clean for active clients while preserving full history. Clients rarely need to dig into documents from 3+ years ago — but when they do, it's always there.</div></div>

</div>
    `
  },

  // ─── CLIENT PORTAL ──────────────────────────────────────────────────────────

  {
    slug: 'portal-overview',
    title: 'Client Portal Overview',
    section: 'Client Portal',
    keywords: ['portal', 'client login', 'client access', 'what clients see', 'secure'],
    prev: null,
    next: { slug: 'inviting-clients', title: 'Inviting Clients' },
    body: 'The client portal gives each client a secure login to view documents, communicate with your firm, upload financials, and sign returns.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Client Portal</span><span class="sep">›</span>
  <span>Portal Overview</span>
</div>
<h1 class="article-title">Client Portal Overview</h1>

<div class="article-meta">Section: Client Portal</div>
<div class="article-body">

<p>Every client in DarkLion gets their own secure portal — a private web app where they can interact with your firm without email. The portal is the client-facing side of DarkLion.</p>

<h2>What Clients Can Do</h2>
<ul>
  <li><strong>View & Download Documents</strong> — See all documents your firm has delivered to them, organized by year and category. New documents are highlighted with a ✦ NEW badge.</li>
  <li><strong>Send & Receive Messages</strong> — Secure messaging with your firm. No email required for sensitive communication.</li>
  <li><strong>Upload Documents</strong> — Clients can upload files directly to their own record (tax returns, W-2s, statements, etc.).</li>
  <li><strong>Submit Financials</strong> — For business clients, they can connect QuickBooks or upload P&L and Balance Sheet PDFs directly to their advisor.</li>
  <li><strong>Tax Organizer</strong> — Complete a personalized checklist of documents to upload for tax prep.</li>
  <li><strong>Sign Returns</strong> — E-sign tax returns and engagement letters from within the portal.</li>
</ul>

<h2>Portal Structure</h2>
<p>The portal is organized around tabs:</p>
<ul>
  <li><strong>Overview</strong> — Summary of their account, recent activity, any items requiring attention</li>
  <li><strong>Personal Documents</strong> — Documents attached to them as an individual</li>
  <li><strong>Organizers</strong> — Their tax organizer checklists</li>
  <li><strong>Messages</strong> — Secure chat with your firm</li>
  <li><strong>Business Tabs</strong> — One tab per Company they have access to (documents, bookkeeping, financials)</li>
</ul>

<h2>Portal URL</h2>
<p>The portal lives at <strong>your-darklion-address/client-login</strong> (or your custom domain if configured). Each client logs in with the email address you have on file for them.</p>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>Staff and client logins are completely separate. A client cannot access any staff screens, and staff tokens don't work on the client portal. There is no overlap.</div></div>

</div>
    `
  },

  {
    slug: 'inviting-clients',
    title: 'Inviting Clients to the Portal',
    section: 'Client Portal',
    keywords: ['invite', 'portal invite', 'send invite', 'client login', 'activate portal', 'email invite'],
    prev: { slug: 'portal-overview', title: 'Portal Overview' },
    next: { slug: 'what-clients-see', title: 'What Clients See' },
    body: 'How to send a portal invitation to a client so they can set their password and log in.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Client Portal</span><span class="sep">›</span>
  <span>Inviting Clients</span>
</div>
<h1 class="article-title">Inviting Clients to the Portal</h1>

<div class="article-meta">Section: Client Portal</div>
<div class="article-body">

<p>Before a client can log into their portal, you need to send them an invitation. The invite email contains a link for them to set their password and activate their account.</p>

<h2>How to Send an Invite</h2>
<ol class="step-list">
  <li>Go to <strong>CRM → People</strong> and click the client's name.</li>
  <li>On the <strong>Overview</strong> tab, find the <strong>Portal Access</strong> section.</li>
  <li>Click <strong>Send Portal Invite</strong>.</li>
  <li>The client receives an email with a link to set their password. The link expires after 7 days.</li>
</ol>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>Make sure the client's email address is correct before sending the invite. The invite goes to whatever email is on their Person record.</div></div>

<h2>What the Client Receives</h2>
<p>The invitation email contains:</p>
<ul>
  <li>Your firm's name and branding</li>
  <li>A link to set their password (valid for 7 days)</li>
  <li>The URL to log in going forward</li>
</ul>
<p>No sensitive data is included in the email — the content simply directs them to log in securely.</p>

<h2>Re-Sending an Invite</h2>
<p>If a client didn't receive the invite or the link expired, just click <strong>Send Portal Invite</strong> again. A new link is generated and the old one is invalidated.</p>

<h2>Resetting a Client's Password</h2>
<p>If a client is locked out, they can use the <strong>Forgot Password</strong> link on the portal login page to reset their own password. Or you can send them a fresh invite from their Person record.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>You don't have to invite every client right away. Many firms use DarkLion internally for a while before rolling out the portal to clients. Invite them when you're ready to start sharing documents.</div></div>

</div>
    `
  },

  {
    slug: 'what-clients-see',
    title: 'What Clients See',
    section: 'Client Portal',
    keywords: ['client view', 'portal tabs', 'overview', 'personal documents', 'organizers', 'messages', 'company tab', 'desktop', 'session'],
    prev: { slug: 'inviting-clients', title: 'Inviting Clients' },
    next: { slug: 'client-financials', title: 'Client Financials Upload' },
    body: 'A full walkthrough of the client portal experience — the tabs they see, how documents appear, messages, organizers, and company access.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Client Portal</span><span class="sep">›</span>
  <span>What Clients See</span>
</div>
<h1 class="article-title">What Clients See</h1>

<div class="article-meta">Section: Client Portal</div>
<div class="article-body">

<p>When a client logs into the DarkLion portal from a desktop or laptop, they see a clean large-screen workspace built specifically for documents, organizers, messages, and company work. Here's a complete walkthrough of what the experience looks like from their side.</p>

<h2>Portal Login</h2>
<p>Clients log in at <strong>your-darklion-address/client-login</strong> (or your custom domain, if configured). They enter their email address and password. Sessions last <strong>7 days</strong> — after that, they need to log in again.</p>

<h2>Tab Bar</h2>
<p>After logging in, the client sees a tab bar across the top of their portal. Tabs include:</p>
<ul>
  <li><strong>Overview</strong> — A summary of their account.</li>
  <li><strong>Personal Documents</strong> — Their individual documents.</li>
  <li><strong>Organizers</strong> — Their tax organizer checklists.</li>
  <li><strong>Messages</strong> — Secure messaging with the firm.</li>
  <li><strong>One tab per Company</strong> — Each business entity they have access to gets its own tab (e.g., "Smith Consulting LLC").</li>
</ul>

<h2>Overview Tab</h2>
<p>The Overview tab shows:</p>
<ul>
  <li>A summary of their account and recent activity.</li>
  <li>Any items that need their attention (unread documents, open organizers, etc.).</li>
  <li>Recent portal activity summary.</li>
</ul>

<h2>Personal Documents Tab</h2>
<p>Documents are split into two sections:</p>
<ul>
  <li><strong>"Delivered by Your Advisor"</strong> — Documents your firm has uploaded and delivered to them. Organized by year and category (Tax, Other).</li>
  <li><strong>"Uploaded by You"</strong> — Documents the client has uploaded themselves.</li>
</ul>
<p>Each document row has a <strong>Download</strong> button. New documents show a <strong>✦ NEW</strong> badge until the client views them or 30 days pass.</p>

<h2>Organizers Tab</h2>
<p>Lists all tax organizers that have been sent to this client:</p>
<ul>
  <li>The current year organizer is shown prominently with its status (Open / In Progress / Submitted).</li>
  <li>Prior year organizers are listed below in a collapsed accordion.</li>
</ul>
<p>Clicking an organizer opens the full 4-step document collection flow.</p>

<h2>Messages Tab</h2>
<p>A chat-style interface for secure communication with the firm:</p>
<ul>
  <li>Client can start new conversations or reply to existing ones.</li>
  <li>Messages show as bubbles — their messages on the right, staff replies on the left.</li>
  <li>An <strong>unread count badge</strong> appears on the Messages tab when they have new replies from staff.</li>
  <li>Clients cannot see internal notes — those are invisible on their end.</li>
</ul>

<h2>Company Tabs</h2>
<p>Each business entity the client has access to gets its own tab. Inside each company tab:</p>
<ul>
  <li><strong>Docs subtab</strong> — Same folder structure as personal documents, but for that company (Tax, Bookkeeping, Other categories).</li>
  <li><strong>Bookkeeping subtab</strong> (visible only for <code>client_prepared</code> companies) — Option to connect QuickBooks Online or upload P&L/Balance Sheet PDFs to send to the advisor.</li>
</ul>

<h2>Phone and Tablet Experience</h2>
<p>The client portal is intentionally limited to desktop and laptop screens so document review, organizers, uploads, bookkeeping questions, and signatures display correctly. If clients open the portal on a phone or tablet, they see a clear message asking them to use a larger screen. Supported notification emails can still be answered directly by email, and those replies route back into the staff Messages inbox.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>The portal session expires after 7 days of inactivity. If a client says they can't log in, they may just need to log back in with their email and password. For password issues, they can use "Forgot Password" on the login page.</div></div>

</div>
    `
  },

  {
    slug: 'client-financials',
    title: 'Client Financials Upload',
    section: 'Client Portal',
    keywords: ['client financials', 'P&L', 'balance sheet', 'upload financials', 'client prepared', 'bookkeeping', 'QuickBooks', 'send financials'],
    prev: { slug: 'what-clients-see', title: 'What Clients See' },
    next: null,
    body: 'How clients upload their financial statements (P&L and balance sheet) from the portal, and how that appears to staff in the CRM.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Client Portal</span><span class="sep">›</span>
  <span>Client Financials Upload</span>
</div>
<h1 class="article-title">Client Financials Upload</h1>

<div class="article-meta">Section: Client Portal</div>
<div class="article-body">

<p>For business clients who manage their own books (<strong>Client Prepared</strong> bookkeeping service), DarkLion gives them a way to send their financial statements directly to you from the portal — either by connecting QuickBooks Online or uploading PDF/Excel files.</p>

<h2>Where It Appears</h2>
<p>This feature is only visible for companies where the bookkeeping service is set to <strong>Client Prepared</strong>. The client navigates to their company's tab in the portal → clicks the <strong>Bookkeeping</strong> subtab.</p>

<h2>What the Client Sees</h2>
<p>Depending on whether QuickBooks is connected:</p>
<ul>
  <li><strong>If QBO is not connected:</strong> They see a "Connect QuickBooks" link alongside an "or upload PDFs" option.</li>
  <li><strong>If QBO is connected:</strong> They see a "Send Financials to Advisor" button with a QBO connected indicator.</li>
</ul>

<h2>The Send Financials Flow</h2>
<ol class="step-list">
  <li>Client clicks <strong>"Send Financials to Advisor"</strong>.</li>
  <li>A modal opens with:
    <ul>
      <li><strong>Tax Year picker</strong> — defaults to the current active year.</li>
      <li><strong>P&L dropzone</strong> — drag a PDF or Excel file, or click to browse.</li>
      <li><strong>Balance Sheet dropzone</strong> — drag a PDF or Excel file, or click to browse.</li>
      <li><strong>QBO option</strong> — if connected, shown as an alternative to file upload.</li>
    </ul>
  </li>
  <li>The <strong>"Send to Advisor"</strong> button activates when: QuickBooks is connected, OR both P&L and Balance Sheet files are staged.</li>
  <li>Client clicks Send.</li>
</ol>

<h2>After Submission</h2>
<p>Immediately after the client submits:</p>
<ul>
  <li>The modal closes.</li>
  <li>The portal automatically switches to the <strong>Docs subtab</strong>.</li>
  <li>A green success banner appears: <em>"✓ Your 2025 financials were sent to your advisor successfully."</em> (fades after 8 seconds).</li>
  <li>The uploaded files appear in the Docs tab immediately under "Uploaded by You."</li>
</ul>

<h2>What You See in the CRM</h2>
<p>On the Company's Docs tab in the CRM, the submitted files appear under <strong>"Uploaded by Client"</strong> section.</p>

<p>The submission fires the <code>client_financials_submitted</code> pipeline trigger — if you have a pipeline configured with that trigger, the client's card will automatically move to the target stage.</p>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>The <code>client_financials_submitted</code> trigger fires regardless of whether the client used QBO or file upload. Both paths go through the same trigger so your pipeline automation is consistent.</div></div>

</div>
    `
  },

  // ─── PIPELINES ──────────────────────────────────────────────────────────────

  {
    slug: 'pipelines-overview',
    title: 'Pipelines Overview',
    section: 'Pipelines',
    keywords: ['pipeline', 'kanban', 'workflow', 'stages', 'cards', 'track', 'progress', 'tax return'],
    prev: null,
    next: { slug: 'creating-pipelines', title: 'Creating a Pipeline' },
    body: 'Pipelines let you track every client through a repeatable process using a visual kanban board. Each pipeline has stages; each client gets a card that moves through those stages.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Pipelines</span><span class="sep">›</span>
  <span>Pipelines Overview</span>
</div>
<h1 class="article-title">Pipelines Overview</h1>

<div class="article-meta">Section: Pipelines</div>
<div class="article-body">

<p>Pipelines are the workflow engine of DarkLion. They let you track every client through a repeatable process — like a tax return preparation workflow — using a visual kanban board.</p>

<h2>Core Concepts</h2>

<h3>Pipeline Template</h3>
<p>A <strong>Pipeline Template</strong> defines the process — its name, what type of entity it tracks (Companies, People, or Relationships), and its stages. You create a template once and reuse it every year.</p>

<h3>Pipeline Instance</h3>
<p>An <strong>Instance</strong> is a specific run of a template — e.g., "2025 Business Tax Returns." Instances are year-specific. When a new tax year starts, you create a new instance from the same template rather than rebuilding from scratch.</p>

<h3>Stages</h3>
<p><strong>Stages</strong> are the columns in the kanban board — e.g., "Awaiting Documents", "In Preparation", "Client Review", "E-Sign Requested", "Delivered." You can create as many stages as you need and reorder them anytime.</p>

<h3>Cards (Jobs)</h3>
<p>Each <strong>Card</strong> represents one client entity moving through the pipeline. Cards are created manually (or automatically via Smart Triggers). A card shows the client's name, current stage, priority, and any notes.</p>

<h2>The Kanban Board</h2>
<p>Go to <strong>Pipelines</strong> in the left sidebar to see all your pipeline templates. Click a pipeline name to open the kanban board for its current year. You can:</p>
<ul>
  <li><strong>Drag cards</strong> between stages to move clients forward</li>
  <li><strong>Click a card</strong> to open the detail panel (notes, assignee, due date, history)</li>
  <li>Use the <strong>← →</strong> buttons on a card to move it one stage at a time</li>
  <li>Switch between years using the year selector in the board header</li>
</ul>

<h2>Automation</h2>
<p>Pipelines connect to two automation systems:</p>
<ul>
  <li><strong>Smart Triggers</strong> — Events in DarkLion (like a client submitting financials) automatically move cards to the right stage.</li>
  <li><strong>Stage Actions</strong> — When a card enters a stage, DarkLion can automatically send a portal message or create a staff task.</li>
</ul>

<div class="callout tip"><span class="callout-icon">💡</span><div>You only need one pipeline per process type. Use the year selector to manage multiple years from the same template — no need to rebuild stages every year.</div></div>

</div>
    `
  },

  {
    slug: 'creating-pipelines',
    title: 'Creating a Pipeline',
    section: 'Pipelines',
    keywords: ['create pipeline', 'new pipeline', 'stages', 'entity type', 'terminal stage', 'archive pipeline', 'year instance'],
    prev: { slug: 'pipelines-overview', title: 'Pipelines Overview' },
    next: { slug: 'pipeline-cards', title: 'Stages & Cards' },
    body: 'How to create a pipeline template, add stages, set a terminal stage, and create year-specific instances.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Pipelines</span><span class="sep">›</span>
  <span>Creating a Pipeline</span>
</div>
<h1 class="article-title">Creating a Pipeline</h1>

<div class="article-meta">Section: Pipelines</div>
<div class="article-body">

<p>A pipeline in DarkLion is a reusable template — you create it once, configure its stages, and run new instances each year. Here's how to build one from scratch.</p>

<h2>Step 1 — Create the Pipeline Template</h2>
<ol class="step-list">
  <li>Go to <strong>Pipelines</strong> in the sidebar.</li>
  <li>Click <strong>+ New Pipeline</strong>.</li>
  <li>Fill in:
    <ul>
      <li><strong>Name</strong> — e.g., "Business Tax Returns", "Individual Returns", "Bookkeeping Close."</li>
      <li><strong>Entity Type</strong> — <strong>Company</strong>, <strong>Person</strong>, or <strong>Relationship</strong>. This determines what kind of records go in this pipeline. You cannot mix types.</li>
      <li><strong>Description</strong> — Optional. Shows up in the pipeline list as a reminder of what this pipeline is for.</li>
    </ul>
  </li>
  <li>Click <strong>Create</strong>. The pipeline template is created with no stages yet.</li>
</ol>

<h2>Step 2 — Add Stages</h2>
<ol class="step-list">
  <li>After creation, the pipeline opens to its first instance. Click <strong>⚙️ Settings</strong> in the board header.</li>
  <li>In Settings, click <strong>+ Add Stage</strong>.</li>
  <li>Name the stage (e.g., "Awaiting Organizer"), pick a color, and save.</li>
  <li>Repeat for each stage in your workflow.</li>
  <li>Drag stages to reorder them — the board columns will update to match.</li>
</ol>

<h3>Marking the Terminal Stage</h3>
<p>The <strong>terminal stage</strong> is the final "done" column. Cards in the terminal stage are archived nightly at 10 PM.</p>
<ol class="step-list">
  <li>In Settings, find your final stage (e.g., "Filed &amp; Delivered").</li>
  <li>Click the <strong>🏁 button</strong> on that stage to mark it as terminal.</li>
  <li>Only one stage can be terminal per pipeline.</li>
</ol>

<h2>Step 3 — Create Year Instances</h2>
<p>Each pipeline runs year-specific instances. When you first create a pipeline, an instance for the current year is created automatically. To add a new year:</p>
<ol class="step-list">
  <li>On the kanban board, find the <strong>year selector</strong> in the board header.</li>
  <li>Click it and select or type a different year.</li>
  <li>A new instance is created automatically with the same stages as the template.</li>
</ol>

<h2>Copying Stages from Another Pipeline</h2>
<p>Rather than rebuilding stages from scratch, you can copy them:</p>
<ul>
  <li>In Settings → use the <strong>Copy Stages</strong> option to import stages from another pipeline template.</li>
  <li>Or clone an entire pipeline from the pipeline list: click the <strong>⋯ menu</strong> next to any pipeline → <strong>Clone</strong>.</li>
</ul>

<h2>Managing Pipelines</h2>
<p>From the pipeline list (⋯ menu on each pipeline):</p>
<ul>
  <li><strong>Archive</strong> — Hides the pipeline from the list. Data is preserved and can be restored. Use when a pipeline is no longer active but you want to keep the history.</li>
  <li><strong>Delete</strong> — Permanently removes the pipeline template and all jobs in it. Cannot be undone.</li>
</ul>

<div class="callout warning"><span class="callout-icon">⚠️</span><div>Deleting a pipeline removes all historical card data for that pipeline. Archive instead of delete if you might need the history later.</div></div>

</div>
    `
  },

  {
    slug: 'pipeline-cards',
    title: 'Stages & Cards',
    section: 'Pipelines',
    keywords: ['cards', 'jobs', 'kanban', 'drag', 'move card', 'assignee', 'priority', 'due date', 'notes', 'archived', 'terminal'],
    prev: { slug: 'creating-pipelines', title: 'Creating a Pipeline' },
    next: { slug: 'smart-triggers', title: 'Smart Triggers' },
    body: 'How to add cards to a pipeline, move them between stages, open card details, and understand what happens when a card reaches the terminal stage.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Pipelines</span><span class="sep">›</span>
  <span>Stages & Cards</span>
</div>
<h1 class="article-title">Stages & Cards</h1>

<div class="article-meta">Section: Pipelines</div>
<div class="article-body">

<p>Cards (also called "jobs") are the individual client records moving through your pipeline. Each card represents one client entity in one workflow run. Here's everything you need to know about working with them.</p>

<h2>Adding a Card to a Pipeline</h2>
<p>There are two ways to add a client to a pipeline:</p>

<h3>Option A: From the Kanban Board</h3>
<ol class="step-list">
  <li>Open the pipeline you want to add to.</li>
  <li>Find the column (stage) where you want the client to start.</li>
  <li>Click <strong>+ Add Job</strong> at the bottom of that column.</li>
  <li>Search for the client by name — results filter to the pipeline's entity type (People, Companies, or Relationships).</li>
  <li>Select the client. A card is created immediately.</li>
</ol>

<h3>Option B: From the Client's CRM Record</h3>
<ol class="step-list">
  <li>Open the Person or Company in the CRM.</li>
  <li>Click the <strong>Workflow tab</strong>.</li>
  <li>Click <strong>+ Create Card</strong>.</li>
  <li>Choose the pipeline and the starting stage.</li>
  <li>The card appears on the kanban board and on the Workflow tab.</li>
</ol>

<h2>What a Card Shows</h2>
<p>Each card on the board displays:</p>
<ul>
  <li>Client name and entity type icon</li>
  <li>Priority badge (if set to High or Urgent)</li>
  <li>NB notes (the first line of the notes field, shown on the card face)</li>
  <li>Due date (if set)</li>
  <li>🏁 indicator if the card is in the terminal stage</li>
</ul>

<h2>Moving a Card</h2>
<ul>
  <li><strong>Drag and drop</strong> — Click and hold a card, drag it to another column, release to drop.</li>
  <li><strong>← → arrows</strong> — Buttons on the card face move it one stage backward or forward without dragging. Useful on smaller screens.</li>
</ul>

<h2>Card Detail Panel</h2>
<p>Click the card body (not the arrow buttons) to open the detail panel on the right side of the screen. The panel shows:</p>
<ul>
  <li><strong>Current Stage</strong> and status</li>
  <li><strong>Priority</strong> — Normal / High / Urgent (sets the badge on the card face)</li>
  <li><strong>Assignee</strong> — Which staff member owns this card. Assigned cards appear in that person's "My Inbox" filter.</li>
  <li><strong>Due Date</strong> — Date picker. Due dates approaching or overdue are highlighted.</li>
  <li><strong>NB Notes</strong> — Freeform note field. The first line shows on the card face in the board view.</li>
  <li><strong>Movement History</strong> — A complete log of every stage change: who moved it, from where, to where, and when. Full audit trail.</li>
</ul>

<h2>Terminal Stage & Archiving</h2>
<p>Cards in the terminal stage show a <strong>"🏁 Archiving tonight at 10 PM"</strong> indicator. Every night at 10 PM, DarkLion automatically archives all cards in terminal stages:</p>
<ul>
  <li>The card is removed from the kanban board.</li>
  <li>The completion is logged in the client's pipeline history (visible on the Person/Company/Relationship Overview tab).</li>
</ul>

<h2>Pipeline History</h2>
<p>Completed pipeline runs don't disappear — they're recorded in the client's history. Open any Person, Company, or Relationship record → Overview tab → <strong>Pipeline History</strong> section to see a full log of every completed workflow run, with dates and final stages.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>The board only shows cards with <code>job_status = 'active'</code>. Archived cards are removed from view but preserved in history. This keeps the board clean — only active work is visible.</div></div>

</div>
    `
  },

  {
    slug: 'smart-triggers',
    title: 'Smart Triggers',
    section: 'Pipelines',
    keywords: ['triggers', 'automation', 'auto-move', 'pipeline', 'event', 'organizer submitted', 'financials'],
    prev: { slug: 'pipeline-cards', title: 'Stages & Cards' },
    next: { slug: 'stage-actions', title: 'Stage Actions' },
    body: 'Smart Triggers automatically move pipeline cards when specific events happen in DarkLion — like a client submitting their organizer or signing a return.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Pipelines</span><span class="sep">›</span>
  <span>Smart Triggers</span>
</div>
<h1 class="article-title">Smart Triggers</h1>

<div class="article-meta">Section: Pipelines</div>
<div class="article-body">

<p>Smart Triggers connect real events in DarkLion to your pipeline. When something happens — a client submits their organizer, signs a return, or uploads financials — DarkLion can automatically move their card to the right stage.</p>

<h2>Available Triggers</h2>

<h3>Tax</h3>
<ul>
  <li><strong>organizer_submitted</strong> — Client completes and submits their tax organizer</li>
  <li><strong>return_delivered</strong> — Staff delivers the completed tax return to the client</li>
  <li><strong>return_signed</strong> — Client signs their return (8879 or similar)</li>
  <li><strong>tax_financials_generated</strong> — Advisor generates a tax financials PDF from QuickBooks</li>
  <li><strong>client_financials_submitted</strong> — Client uploads or submits their financials from the portal</li>
</ul>

<h3>Engagement</h3>
<ul>
  <li><strong>engagement_letter_uploaded</strong> — Staff uploads a signed engagement letter</li>
  <li><strong>engagement_letter_signed</strong> — Client signs the engagement letter</li>
</ul>

<h3>Portal</h3>
<ul>
  <li><strong>portal_activated</strong> — Client accepts their portal invite and logs in for the first time</li>
  <li><strong>portal_message_received</strong> — Client sends a message through the portal</li>
</ul>

<h3>Proposals</h3>
<ul>
  <li><strong>proposal_sent</strong> — Staff sends a proposal to a client</li>
  <li><strong>proposal_signed</strong> — Client signs the proposal</li>
</ul>

<h2>Setting Up a Trigger</h2>
<ol class="step-list">
  <li>Go to <strong>Pipelines</strong> and open a pipeline.</li>
  <li>Click <strong>⚙️ Settings</strong> in the board header.</li>
  <li>Find the stage you want the trigger to move cards <em>to</em>.</li>
  <li>Click <strong>+ Add Trigger</strong> on that stage's card.</li>
  <li>Select the trigger type from the dropdown.</li>
  <li>Save. The trigger is now active for this pipeline.</li>
</ol>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>Triggers are entity-type aware. A trigger on a Company pipeline will only fire for company events, not person events. This prevents cross-contamination between pipelines.</div></div>

<h2>Manual Trigger (Fire Trigger Button)</h2>
<p>You can also fire a trigger manually from the client's CRM page. On the Person or Company detail page → <strong>Workflow tab</strong> → click <strong>⚡ Fire Trigger</strong> → select the trigger type. Useful for testing or handling edge cases.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>Each stage can have up to 2 triggers. If a card doesn't exist yet when a trigger fires, DarkLion will automatically create one in the target stage — you don't have to add clients to a pipeline before triggering.</div></div>

</div>
    `
  },

  {
    slug: 'stage-actions',
    title: 'Stage Actions',
    section: 'Pipelines',
    keywords: ['stage actions', 'portal message', 'staff task', 'automation', 'merge tags', 'auto message', 'auto task'],
    prev: { slug: 'smart-triggers', title: 'Smart Triggers' },
    next: null,
    body: 'Stage Actions automatically send portal messages or create staff tasks whenever a card enters a specific pipeline stage. Configure them in pipeline settings.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Pipelines</span><span class="sep">›</span>
  <span>Stage Actions</span>
</div>
<h1 class="article-title">Stage Actions</h1>

<div class="article-meta">Section: Pipelines</div>
<div class="article-body">

<p>Stage Actions are automatic actions that fire every time a card enters a specific pipeline stage. You configure them once on the stage; they run automatically for every client card that moves into that stage — no manual work required.</p>

<h2>Setting Up a Stage Action</h2>
<ol class="step-list">
  <li>Go to <strong>Pipelines</strong> → open a pipeline → click <strong>⚙️ Settings</strong>.</li>
  <li>Find the stage you want to add an action to.</li>
  <li>Click <strong>+ Add Action</strong> on that stage.</li>
  <li>Choose the action type (see below).</li>
  <li>Fill in the content and save.</li>
</ol>

<h2>Action Types</h2>

<h3>1. Portal Message</h3>
<p>Automatically sends a message to the client's portal when a card enters this stage. The client receives an email notification and a new message thread in their portal.</p>
<ul>
  <li>Write a <strong>subject</strong> and <strong>message body</strong>.</li>
  <li>Use <strong>merge tags</strong> to personalize: <code>{First Name}</code>, <code>{Entity Name}</code>, <code>{Tax Year}</code>, <code>{Pipeline Name}</code>, <code>{Stage Name}</code>.</li>
  <li>Example: "Hi {First Name}, your {Tax Year} tax return is ready for review. Please open DarkLion from a desktop or laptop to view and sign. You can reply directly to this email with questions."</li>
</ul>

<h3>2. Staff Task</h3>
<p>Creates a task item in the staff inbox when a card enters this stage. Helps staff know what needs to happen next without having to track it manually.</p>
<ul>
  <li>Write the <strong>task description</strong> (merge tags work here too).</li>
  <li>The task appears in the Messages inbox with a <strong>📋 badge</strong> and an amber tint — visually distinct from actual client messages so staff can tell it's a task at a glance.</li>
  <li>Assigned to whoever is assigned to the pipeline card. If the card has no assignee, the task is unassigned.</li>
</ul>

<h2>Merge Tags Reference</h2>
<table class="help-table">
  <thead><tr><th>Tag</th><th>Resolves To</th></tr></thead>
  <tbody>
    <tr><td><code>{First Name}</code></td><td>Client's first name (for People) or entity name (for Companies)</td></tr>
    <tr><td><code>{Entity Name}</code></td><td>Full name of the person or company</td></tr>
    <tr><td><code>{Tax Year}</code></td><td>The pipeline instance year (e.g., 2025)</td></tr>
    <tr><td><code>{Pipeline Name}</code></td><td>Name of the pipeline template</td></tr>
    <tr><td><code>{Stage Name}</code></td><td>Name of the stage the card just entered</td></tr>
  </tbody>
</table>

<h2>How Actions Fire</h2>
<ul>
  <li>Actions fire <strong>every time</strong> any card enters that stage — not just the first time. If a card moves out and back in, the action fires again.</li>
  <li>Actions are <strong>non-blocking</strong> — if an action fails (e.g., the client doesn't have a portal account yet), the card still moves successfully. The failure is logged but doesn't stop the workflow.</li>
</ul>

<h2>Good Use Cases</h2>
<ul>
  <li><em>"Send welcome message when onboarding starts"</em> — Portal message on the first stage: "Welcome to the portal, {First Name}! Here's what to expect…"</li>
  <li><em>"Notify client their return is ready for review"</em> — Portal message on your "Client Review" stage with next steps.</li>
  <li><em>"Remind staff to call client when return is delivered"</em> — Staff task on your "Delivered" stage: "Call {First Name} to confirm they received their {Tax Year} return."</li>
</ul>

</div>
    `
  },

  // ─── MESSAGING ──────────────────────────────────────────────────────────────

  {
    slug: 'messaging-overview',
    title: 'Messaging Overview',
    section: 'Messaging',
    keywords: ['messages', 'inbox', 'threads', 'communication', 'portal chat', 'secure messaging'],
    prev: null,
    next: { slug: 'staff-inbox', title: 'Staff Inbox' },
    body: 'DarkLion messaging centralizes client communication. Clients can message from the desktop portal or reply to supported notification emails; staff reply from the shared team inbox. All conversations are tracked per client.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Messaging</span><span class="sep">›</span>
  <span>Messaging Overview</span>
</div>
<h1 class="article-title">Messaging Overview</h1>

<div class="article-meta">Section: Messaging</div>
<div class="article-body">

<p>DarkLion has a built-in secure messaging system for day-to-day client communication. Clients can message from the desktop portal, and supported notification emails can route replies back into the same DarkLion thread.</p>

<h2>How It Works</h2>
<ul>
  <li><strong>Clients</strong> send messages from their desktop portal, or reply to supported notification emails. They see a chat-style interface when using the portal.</li>
  <li><strong>Staff</strong> see all client messages in the shared <strong>Messages</strong> inbox. Threads from all clients come in here.</li>
  <li>When a client sends a message, the thread flips to <strong>Open</strong> status and appears at the top of the staff inbox.</li>
  <li>When staff reply, the thread flips to <strong>Waiting</strong> (waiting for client response).</li>
  <li>When the conversation is done, staff mark it <strong>Resolved</strong> and it moves off the active inbox.</li>
</ul>

<h2>Thread Statuses</h2>
<ul>
  <li><strong>Open</strong> — Client sent a message; needs staff attention</li>
  <li><strong>Waiting</strong> — Staff replied; waiting for client</li>
  <li><strong>Resolved</strong> — Conversation complete; archived from inbox</li>
</ul>

<h2>Internal Notes</h2>
<p>Staff can add <strong>internal notes</strong> to any thread — visible only to staff, never to the client. Useful for leaving context for teammates.</p>

<h2>Client Notifications</h2>
<p>When staff send a message, the client gets an email notification with the message preview and clear next steps. They can reply directly to supported emails, or use a desktop or laptop if the action requires the client portal.</p>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>Every message thread is also visible on the Person's or Company's <strong>Communication tab</strong> in the CRM. Staff don't have to go to the Messages inbox to reply — they can reply directly from the client's record.</div></div>

</div>
    `
  },

  {
    slug: 'staff-inbox',
    title: 'Staff Inbox',
    section: 'Messaging',
    keywords: ['inbox', 'threads', 'assign', 'resolve', 'open', 'waiting', 'filter', 'search', 'company tag', 'thread sharing'],
    prev: { slug: 'messaging-overview', title: 'Messaging Overview' },
    next: { slug: 'sending-messages', title: 'Sending Messages' },
    body: 'How the staff messaging inbox works: thread list, status filters, assigning threads, resolving conversations, and sharing with colleagues.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Messaging</span><span class="sep">›</span>
  <span>Staff Inbox</span>
</div>
<h1 class="article-title">Staff Inbox</h1>

<div class="article-meta">Section: Messaging</div>
<div class="article-body">

<p>The staff inbox is where your firm manages all client communication. Go to <strong>Messages (💬)</strong> in the left sidebar to open it. When you arrive, the most recent active thread opens automatically.</p>

<h2>Inbox Layout</h2>
<p>The inbox is split into three panels left-to-right:</p>
<ul>
  <li><strong>Thread list</strong> — All your conversations on the left.</li>
  <li><strong>Message bubbles</strong> — The selected thread in the center. Client messages appear on the left; staff replies on the right.</li>
  <li><strong>AI summary panel</strong> — Emma's summary of the thread on the right (context, key points, suggested reply).</li>
</ul>

<h2>Thread List Filters</h2>
<p>At the top of the thread list are filter tabs:</p>
<ul>
  <li><strong>Active</strong> — All threads that are Open or Waiting. This is your working inbox.</li>
  <li><strong>Open</strong> — Threads waiting for your reply (client sent the last message).</li>
  <li><strong>Waiting</strong> — Threads waiting for the client (you sent the last message).</li>
  <li><strong>Resolved</strong> — Completed conversations.</li>
  <li><strong>All</strong> — Everything, regardless of status.</li>
</ul>
<p>There's also a <strong>My Inbox / All Inbox</strong> toggle to switch between threads assigned to you and all firm threads.</p>

<h2>Searching Threads</h2>
<p>The search box at the top of the thread list filters by client name or subject in real time. Use it to find a specific client's thread without scrolling.</p>

<h2>Thread Actions</h2>

<h3>Assign a Thread</h3>
<p>In the thread detail header, use the <strong>Assignee dropdown</strong> to assign the thread to a specific staff member. Assigned threads appear in that person's "My Inbox" filter. Use this to delegate client communication responsibilities.</p>

<h3>Mark Resolved</h3>
<p>When a conversation is complete, click <strong>Mark Resolved</strong> in the thread header. The thread moves to the Resolved tab and off the active inbox. You can reopen it anytime with <strong>Mark Open</strong>.</p>

<h3>Tag a Company</h3>
<p>Click the tag button in the thread detail to link a Company to the thread. This provides context for staff — they can see which business this conversation is related to without leaving the inbox.</p>

<h3>Share with a Colleague (@mention)</h3>
<p>In the reply box, type <strong>@Name</strong> to mention a colleague. They are added as a participant on the thread and it appears in their inbox with a "Shared by [You]" badge. Use this to loop in teammates on complex client situations.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>Use the <strong>Active</strong> filter tab as your daily working view — it combines Open and Waiting so you can see everything that's in flight without switching tabs. When a thread goes quiet (both sides are done), resolve it to keep the inbox clean.</div></div>

</div>
    `
  },

  {
    slug: 'sending-messages',
    title: 'Sending Messages',
    section: 'Messaging',
    keywords: ['send message', 'new thread', 'reply', 'attachment', 'SMS', 'Twilio', 'communication tab'],
    prev: { slug: 'staff-inbox', title: 'Staff Inbox' },
    next: { slug: 'internal-notes', title: 'Internal Notes' },
    body: 'How to start a new message thread, reply to existing threads, attach documents, and send SMS notifications to clients.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Messaging</span><span class="sep">›</span>
  <span>Sending Messages</span>
</div>
<h1 class="article-title">Sending Messages</h1>

<div class="article-meta">Section: Messaging</div>
<div class="article-body">

<p>There are several ways to send messages to clients in DarkLion. Here's a complete guide to each method.</p>

<h2>Starting a New Thread</h2>
<ol class="step-list">
  <li>Go to <strong>Messages (💬)</strong> in the sidebar.</li>
  <li>Click <strong>+ New Thread</strong>.</li>
  <li>Search for the client by name to select them.</li>
  <li>Enter a <strong>subject</strong> for the thread.</li>
  <li>Type your message in the compose box.</li>
  <li>Click <strong>Send</strong>.</li>
</ol>
<p>After sending, the thread status flips to <strong>Waiting</strong> (waiting for the client's response).</p>

<h2>Replying to an Existing Thread</h2>
<ol class="step-list">
  <li>Click the thread in the inbox.</li>
  <li>Type your reply in the box at the bottom of the thread.</li>
  <li>Click <strong>Send</strong> (or press <kbd>Ctrl+Enter</kbd> / <kbd>Cmd+Enter</kbd>).</li>
</ol>

<h2>Messaging from the CRM</h2>
<p>You don't have to go to the Messages inbox to communicate with a client. From any Person or Company record:</p>
<ol class="step-list">
  <li>Open the client in the CRM.</li>
  <li>Click the <strong>Communication tab</strong>.</li>
  <li>Start a new thread or reply to existing threads directly from here.</li>
</ol>
<p>This is the fastest way to message a client when you're already on their record.</p>

<h2>Attaching Documents</h2>
<p>To attach a file to a message:</p>
<ol class="step-list">
  <li>In the reply box, click the <strong>📎 attachment icon</strong>.</li>
  <li>A picker shows documents already in the client's file library.</li>
  <li>Select the document to attach — it's included in the message as a link.</li>
  <li>The client sees a download link directly in the portal message.</li>
</ol>

<h2>SMS Notifications</h2>
<p>If the client has a phone number on file, a <strong>📱 Send as Text</strong> button appears in the reply toolbar.</p>
<ul>
  <li>Clicking it sends an SMS via Twilio to the client's phone number.</li>
  <li>SMS is <strong>one-way notification only</strong> — client replies come back to the portal, not to your phone.</li>
  <li>The SMS message should be brief ("You have a new message from your firm — log in to view it") since portal messages can't be read directly from SMS.</li>
</ul>

<h2>What the Client Receives</h2>
<p>When you send a message, the client gets an email notification:</p>
<blockquote><em>"You have a new message from Smith & Co. CPAs — log in to view it."</em></blockquote>
<p>The actual message content is never included in the email. This is intentional — it keeps sensitive financial communication inside the secure portal and encourages clients to log in.</p>

<p>When the client replies, the thread immediately flips back to <strong>Open</strong> status and rises to the top of the staff inbox.</p>

</div>
    `
  },

  {
    slug: 'internal-notes',
    title: 'Internal Notes',
    section: 'Messaging',
    keywords: ['internal note', 'staff only', 'private note', 'amber', 'thread note', 'phone call', 'context'],
    prev: { slug: 'sending-messages', title: 'Sending Messages' },
    next: null,
    body: 'Internal notes are staff-only comments on a message thread. They are never shown to clients and help teammates share context about a conversation.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Messaging</span><span class="sep">›</span>
  <span>Internal Notes</span>
</div>
<h1 class="article-title">Internal Notes</h1>

<div class="article-meta">Section: Messaging</div>
<div class="article-body">

<p>Internal notes are comments you add to a message thread that are <strong>only visible to staff</strong>. They never appear in the client's portal and don't trigger any client notification. Use them to share context, log phone calls, or leave reminders for teammates on the same thread.</p>

<h2>How to Add an Internal Note</h2>
<ol class="step-list">
  <li>Open a message thread in the inbox.</li>
  <li>In the reply box at the bottom, check the <strong>"Internal Note"</strong> checkbox before typing.</li>
  <li>Type your note.</li>
  <li>Click <strong>Save Note</strong> (instead of Send — the button label changes when the checkbox is checked).</li>
</ol>

<h2>How Notes Look</h2>
<p>In the staff thread view, internal notes appear with an <strong>amber/gold tint</strong> — clearly different from client-visible messages so staff can instantly tell what the client can and can't see. A staff-only badge is also shown on the note.</p>
<p>The client's view of the same thread shows none of these notes — they're completely invisible from the portal.</p>

<h2>When to Use Internal Notes</h2>
<p>Internal notes are most valuable for preserving context that your team needs but shouldn't be shared with the client:</p>
<ul>
  <li><em>"Client called this morning — prefers contact after 10 AM."</em></li>
  <li><em>"Waiting on K-1 from their accountant's office. Expected next week."</em></li>
  <li><em>"Nick spoke to client — the issue was resolved verbally. No action needed."</em></li>
  <li><em>"Client is going through a divorce — handle with care. Don't mention spouse."</em></li>
</ul>

<h2>Notes and Thread Status</h2>
<p>Adding an internal note does <strong>not</strong> change the thread's status. A note doesn't flip the thread to "Waiting" the way a client-visible reply would. The thread status only changes based on messages the client can see.</p>

<h2>Who Can See Notes</h2>
<p>All staff with access to the thread can see internal notes — including staff who are shared into the thread via @mention. Notes are firm-internal only; they are never visible to the client under any circumstances.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>Best practice: whenever you handle something offline (phone call, in-person meeting, email outside DarkLion), leave an internal note on the relevant thread so your team has the full picture. A colleague picking up the thread later should never be missing context.</div></div>

</div>
    `
  },

  // ─── TAX ORGANIZER ──────────────────────────────────────────────────────────

  {
    slug: 'organizer-overview',
    title: 'Tax Organizer Overview',
    section: 'Tax Organizer',
    keywords: ['organizer', 'tax organizer', 'document collection', 'checklist', 'workpaper', 'StanfordTax', 'replace'],
    prev: null,
    next: { slug: 'sending-organizer', title: 'Sending an Organizer' },
    body: 'The DarkLion Tax Organizer replaces StanfordTax with a guided 4-step client checklist. Clients confirm info, answer questions, upload documents, and submit — you get a compiled workpaper PDF.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Tax Organizer</span><span class="sep">›</span>
  <span>Tax Organizer Overview</span>
</div>
<h1 class="article-title">Tax Organizer Overview</h1>

<div class="article-meta">Section: Tax Organizer</div>
<div class="article-body">

<p>The DarkLion Tax Organizer is the firm's document collection system for tax prep season. It replaces the StanfordTax organizer and eliminates manual document request emails. Clients get a personalized, guided experience — and you get a compiled workpaper PDF when they're done.</p>

<h2>The Client's 4-Step Experience</h2>

<h3>Step 1 — Confirm Info</h3>
<p>The client reviews their personal information: name, address, dependents. This data is pre-populated directly from their DarkLion record so they don't have to re-enter anything they've already provided. They confirm or flag corrections.</p>

<h3>Step 2 — Questions</h3>
<p>A set of yes/no questions about their tax situation for the current year:</p>
<ul>
  <li>Did you have rental income?</li>
  <li>Did you receive retirement distributions?</li>
  <li>Did you have business income?</li>
  <li>Did you pay for dependent care?</li>
  <li>Did you sell any investments?</li>
  <li>Did you receive Social Security?</li>
  <li>Did you make charitable contributions?</li>
  <li>Any other changes from last year?</li>
</ul>
<p>Conditional follow-up questions appear based on their answers (e.g., if they said yes to rental income, a follow-up asks about expenses).</p>

<h3>Step 3 — Checklist</h3>
<p>A personalized list of documents to upload — built from their questionnaire answers, their prior year return, and their DarkLion profile. Each checklist item has two actions:</p>
<ul>
  <li><strong>Upload</strong> — They drag or select the file. It goes directly to their DarkLion document record.</li>
  <li><strong>Not This Year</strong> — They mark it as not applicable. No need to explain — just mark it and move on.</li>
</ul>

<h3>Step 4 — Submit</h3>
<p>The Submit button is <strong>locked</strong> until every checklist item is either uploaded or marked "Not This Year." This prevents partial submissions. When the client submits:</p>
<ul>
  <li>DarkLion compiles a <strong>workpaper PDF</strong>: cover page + questionnaire answers + NTY list + all uploaded documents stitched together into one file.</li>
  <li>The <code>organizer_submitted</code> pipeline trigger fires.</li>
  <li>The firm receives an email notification.</li>
</ul>

<h2>What You See as Staff</h2>
<ul>
  <li>All submitted items and the full questionnaire answers</li>
  <li>Ability to download the compiled workpaper PDF</li>
  <li>Option to reopen the organizer and request more documents</li>
  <li>Option to add advisor documents to the compilation</li>
</ul>

<h2>Firm Provides Badge</h2>
<p>Certain checklist items are marked with a <strong>"Firm provides"</strong> badge — items that your firm will provide on the client's behalf (custodian investment statements, K-1s from entities you manage, etc.). Clients see these items on the checklist but know not to upload them — you'll add them yourself.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>The Tax Organizer is the fastest path to a complete, organized document package. Instead of chasing clients for W-2s and statements over email, they go through the checklist once and you get everything in one compiled PDF, ready for the return.</div></div>

</div>
    `
  },

  {
    slug: 'sending-organizer',
    title: 'Sending an Organizer',
    section: 'Tax Organizer',
    keywords: ['send organizer', 'create organizer', 'drake import', 'custom questions', 'tax year', 'organizer status'],
    prev: { slug: 'organizer-overview', title: 'Tax Organizer Overview' },
    next: { slug: 'reviewing-submissions', title: 'Reviewing Submissions' },
    body: 'How to send a tax organizer to a client, customize questions, import Drake data, and track organizer status from Open to Submitted.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Tax Organizer</span><span class="sep">›</span>
  <span>Sending an Organizer</span>
</div>
<h1 class="article-title">Sending an Organizer</h1>

<div class="article-meta">Section: Tax Organizer</div>
<div class="article-body">

<p>Sending a tax organizer to a client takes less than a minute. Here's how to do it and how to customize the experience for each client.</p>

<h2>How to Send an Organizer</h2>
<ol class="step-list">
  <li>Go to <strong>CRM → People</strong> → click the client's name.</li>
  <li>Click the <strong>Organizers tab</strong>.</li>
  <li>Click <strong>Send Organizer</strong>.</li>
  <li>Choose the <strong>tax year</strong> for this organizer.</li>
  <li>Click <strong>Send</strong> (or <strong>Create</strong> to set it up without sending immediately).</li>
</ol>
<p>If the client has portal access, they receive an email notification immediately: <em>"Your {Tax Year} tax organizer is ready — log in to complete it."</em></p>

<h2>Custom Questions</h2>
<p>Before or after creation, you can add custom yes/no questions for this specific client that appear in Step 2 of their organizer:</p>
<ol class="step-list">
  <li>Open the organizer from the Organizers tab.</li>
  <li>Find the <strong>Custom Questions</strong> section.</li>
  <li>Click <strong>+ Add Question</strong>.</li>
  <li>Write your yes/no question (e.g., "Did you receive any foreign income this year?").</li>
  <li>Save. The question will appear in the client's Step 2 questionnaire.</li>
</ol>

<h2>Drake Import</h2>
<p>If you have a prior-year Drake organizer PDF for this client, DarkLion can parse it to pre-populate the checklist with items from last year's return — payer names, income sources, prior year amounts, and document names.</p>
<ol class="step-list">
  <li>On the organizer detail, find the <strong>Drake Import</strong> section.</li>
  <li>Upload the prior-year Drake organizer PDF.</li>
  <li>DarkLion parses the PDF and maps items to checklist entries.</li>
  <li>The client sees a pre-populated checklist that matches their prior year — familiar and personalized.</li>
</ol>

<h2>Organizer Status</h2>
<p>Track where each organizer is in the process:</p>
<ul>
  <li><strong>Open</strong> — Sent to the client but not yet started.</li>
  <li><strong>In Progress</strong> — Client has started the organizer (completed Step 1 or beyond).</li>
  <li><strong>Submitted</strong> — Client has completed all steps and submitted.</li>
</ul>
<p>Status is shown on the Organizers tab of the Person record and in the client's portal under their Organizers tab.</p>

<h2>Multiple Years</h2>
<p>Each tax year gets its own organizer. In the client's portal, the current year organizer is shown prominently; prior year organizers appear in a collapsed accordion below — useful for reference but not in the way.</p>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>You can create an organizer without sending it immediately by clicking <strong>Create</strong> instead of <strong>Send</strong>. This lets you set up custom questions or Drake import before the client receives their notification.</div></div>

</div>
    `
  },

  {
    slug: 'reviewing-submissions',
    title: 'Reviewing Submissions',
    section: 'Tax Organizer',
    keywords: ['organizer submission', 'review', 'workpaper PDF', 'download', 'reopen organizer', 'questionnaire answers', 'not this year'],
    prev: { slug: 'sending-organizer', title: 'Sending an Organizer' },
    next: null,
    body: 'How to review a submitted tax organizer, download the compiled workpaper PDF, add advisor documents, and reopen an organizer if more information is needed.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Tax Organizer</span><span class="sep">›</span>
  <span>Reviewing Submissions</span>
</div>
<h1 class="article-title">Reviewing Submissions</h1>

<div class="article-meta">Section: Tax Organizer</div>
<div class="article-body">

<p>When a client submits their tax organizer, you'll receive a notification, the <code>organizer_submitted</code> pipeline trigger fires, and the organizer status changes to Submitted. Here's how to review what they sent.</p>

<h2>Opening a Submitted Organizer</h2>
<ol class="step-list">
  <li>Go to <strong>CRM → People</strong> → click the client.</li>
  <li>Click the <strong>Organizers tab</strong>.</li>
  <li>Click the submitted organizer — it'll show "Submitted" status.</li>
</ol>

<h2>What You Can Review</h2>

<h3>Questionnaire Answers</h3>
<p>All yes/no responses from Step 2, with the actual answers highlighted. You can see at a glance: did they have rental income this year? Did they make retirement distributions? This section gives you the full picture before you even open a document.</p>

<h3>Uploaded Documents</h3>
<p>A list of every document the client uploaded, with individual download links for each file. Click any document to download it directly.</p>

<h3>Not This Year Items</h3>
<p>Items the client marked as not applicable for this year. Useful for confirming that they consciously chose "Not This Year" rather than forgetting to upload something.</p>

<h3>Advisor Documents Section</h3>
<p>Staff can add additional documents to the organizer compilation — for example, the custodian investment statements or K-1s your firm provides. These are incorporated into the workpaper PDF alongside the client's uploads.</p>

<h2>Actions Available</h2>

<h3>Download Workpaper PDF</h3>
<p>Click <strong>Download Workpaper PDF</strong> to get the compiled file: cover page + full questionnaire answers + NTY list + all uploaded documents stitched into a single PDF. This is the document you hand off to the preparer — everything in one place, ready to attach to the tax file.</p>

<h3>Reopen the Organizer</h3>
<p>If you need additional documents from the client:</p>
<ol class="step-list">
  <li>Click <strong>Reopen Organizer</strong>.</li>
  <li>The client receives an email: "Your advisor has requested additional documents — please log in to complete your organizer."</li>
  <li>The organizer status goes back to "Open."</li>
  <li>The client can add more uploads or change their NTY selections.</li>
  <li>When they re-submit, a new workpaper is compiled.</li>
</ol>

<h3>Delete the Organizer</h3>
<p>If you need to remove the organizer entirely, click <strong>Delete Organizer</strong>. A confirmation dialog appears. Deletion is permanent — all uploaded documents and responses are removed.</p>

<h2>Organizer History</h2>
<p>Prior year organizers remain accessible in a collapsed accordion below the current year on the Organizers tab. Use this for year-over-year comparison — you can see what the client uploaded in prior years alongside what they submitted this year, without leaving the record.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>The workpaper PDF is the single most useful output of the organizer system. Keep it attached to the return in your tax software — it's a complete record of everything the client provided and every question they answered, with your firm's branding on the cover page.</div></div>

</div>
    `
  },

  // ─── PROPOSALS ──────────────────────────────────────────────────────────────

  {
    slug: 'proposals',
    title: 'Proposals',
    section: 'Other',
    keywords: ['proposals', 'engagement', 'MRR', 'sign', 'send proposal', 'revenue', 'service agreement'],
    prev: null,
    next: { slug: 'bulk-send', title: 'Bulk Send' },
    body: 'Create and send engagement proposals to clients. Clients sign electronically. Track proposal status and projected MRR from signed agreements.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Other</span><span class="sep">›</span>
  <span>Proposals</span>
</div>
<h1 class="article-title">Proposals</h1>

<div class="article-meta">Section: Other</div>
<div class="article-body">

<p>DarkLion's Proposals feature lets you create professional engagement proposals, send them to clients for review, and collect electronic signatures — without leaving the platform.</p>

<h2>The Proposals Dashboard</h2>
<p>Go to <strong>Proposals</strong> in the left sidebar. At the top, you'll see key stats:</p>
<ul>
  <li><strong>Total</strong> — All proposals across all statuses.</li>
  <li><strong>Sent</strong> — Proposals delivered to clients but not yet signed.</li>
  <li><strong>Accepted / Signed</strong> — Proposals the client has agreed to and signed.</li>
  <li><strong>Signed MRR</strong> — Monthly recurring revenue from all signed proposals. This is your projected monthly revenue from active engagements.</li>
</ul>

<p>Below the stats, filter tabs let you view: <strong>All | Draft | Sent | Viewed | Accepted | Signed</strong>.</p>

<h2>Creating a Proposal</h2>
<ol class="step-list">
  <li>Click <strong>+ New Proposal</strong>.</li>
  <li>Select the <strong>Relationship</strong> this proposal is for.</li>
  <li>Add <strong>service line items</strong>: each item has a name, description, and monthly price.</li>
  <li>Set the <strong>start date</strong> for the engagement.</li>
  <li>Click <strong>Preview</strong> to see exactly how it looks to the client before sending.</li>
  <li>When ready, click <strong>Send</strong>.</li>
</ol>

<h2>What the Client Experiences</h2>
<p>The client receives an email with a link to view the proposal. <strong>No login required</strong> — the link takes them directly to a clean, branded page showing:</p>
<ul>
  <li>Your firm logo and name</li>
  <li>The services offered with descriptions</li>
  <li>The monthly pricing</li>
  <li>Terms and conditions</li>
  <li>A signature area (drawn or typed)</li>
</ul>
<p>After signing, the client gets a confirmation email with a copy of the signed proposal.</p>

<h2>Proposal Status Flow</h2>
<ol>
  <li><strong>Draft</strong> — Created but not yet sent.</li>
  <li><strong>Sent</strong> — Email delivered to client.</li>
  <li><strong>Viewed</strong> — Client opened the proposal link.</li>
  <li><strong>Accepted</strong> — Client agreed to the terms.</li>
  <li><strong>Signed</strong> — Signature captured. Engagement is live.</li>
</ol>

<h2>Revenue Tracking</h2>
<p>Every signed proposal feeds into the revenue forecast. The monthly prices from all signed proposals are summed to calculate your projected MRR (Monthly Recurring Revenue). This gives you a real-time view of how much recurring revenue your signed engagements represent.</p>

<h2>Proposals and the CRM</h2>
<p>Every proposal is linked to a Relationship. Open any Relationship in the CRM → the Billing tab shows proposals linked to that household. You can see the full proposal history (sent, viewed, signed) without going to the Proposals page.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>The Signed MRR stat at the top of the Proposals page is one of the most useful numbers in DarkLion — it tells you exactly what your recurring revenue base is from signed clients, without any manual calculation.</div></div>

</div>
    `
  },

  {
    slug: 'bulk-send',
    title: 'Bulk Send',
    section: 'Other',
    keywords: ['bulk send', 'broadcast', 'mass message', 'announcement', 'filters', 'audience', 'merge tags', 'tax season'],
    prev: { slug: 'proposals', title: 'Proposals' },
    next: { slug: 'settings', title: 'Settings & Branding' },
    body: 'Send a portal message to many clients at once. Build an audience with filters, preview recipients, compose with merge tags, and send individual threads to each matched client.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Other</span><span class="sep">›</span>
  <span>Bulk Send</span>
</div>
<h1 class="article-title">Bulk Send</h1>

<div class="article-meta">Section: Other</div>
<div class="article-body">

<p>Bulk Send lets you send a portal message to many clients at once — tax season kickoffs, annual reminders, office announcements, or anything you need to communicate to a specific segment of your client base.</p>

<h2>The 4-Step Bulk Send Flow</h2>

<h3>Step 1 — Build Your Audience</h3>
<p>Add filters to define exactly who receives the message. Filters available:</p>
<ul>
  <li><strong>Relationship</strong> — Target specific named relationships.</li>
  <li><strong>Service Tier</strong> — Legacy BluePrint, Full Service, or Tax Only.</li>
  <li><strong>Billing Status</strong> — Active, Past Due, or Cancelled.</li>
  <li><strong>Filing Status</strong> — Single, MFJ, MFS, HOH, Qualifying Widow.</li>
  <li><strong>Entity Type</strong> — Person or Company.</li>
  <li><strong>Portal Activity</strong> — Active (logged in recently) or Inactive.</li>
  <li><strong>Pipeline Stage</strong> — Clients currently in a specific stage of a pipeline.</li>
  <li><strong>Has Documents</strong> — Clients who do or don't have documents on file.</li>
  <li><strong>Company Status</strong> — Target by company-level attributes.</li>
</ul>
<p>Each filter has <strong>IS / IS NOT</strong> operators. Add multiple filters — they combine with AND logic (all must match).</p>

<h3>Step 2 — Preview Recipients</h3>
<p>Before writing a single word, click <strong>Preview Recipients</strong> to see the exact list of people who will receive this message based on your filters. You'll see names, email addresses, and relationship info.</p>
<p>This step is critical — confirm the audience is exactly who you intend before sending.</p>

<h3>Step 3 — Compose</h3>
<p>Write your <strong>subject</strong> and <strong>message body</strong>. Use merge tags to personalize each message:</p>
<table class="help-table">
  <thead><tr><th>Tag</th><th>Resolves To</th></tr></thead>
  <tbody>
    <tr><td><code>{First Name}</code></td><td>Client's first name</td></tr>
    <tr><td><code>{Last Name}</code></td><td>Client's last name</td></tr>
    <tr><td><code>{Full Name}</code></td><td>Client's full name</td></tr>
    <tr><td><code>{Relationship Name}</code></td><td>Their household name (e.g., "The Smith Family")</td></tr>
    <tr><td><code>{Firm Name}</code></td><td>Your firm's display name</td></tr>
    <tr><td><code>{Company Names}</code></td><td>The names of their companies (based on filter)</td></tr>
  </tbody>
</table>
<p><code>{Company Names}</code> is particularly powerful — if your filter includes entity type filtering, this tag resolves to the actual company names for each individual recipient.</p>

<h3>Step 4 — Send</h3>
<p>Click <strong>Send</strong>. DarkLion sends individual portal messages to each matched client. Each recipient gets their own separate thread — completely private from other recipients.</p>

<h2>After Sending</h2>
<ul>
  <li>Each client receives their message as an individual portal thread.</li>
  <li>If they reply, their reply comes back as a normal thread in your staff inbox — you handle them one-on-one, not as a group.</li>
  <li>Clients do not know they're part of a bulk send — it looks like a direct message from your firm.</li>
</ul>

<h2>Common Use Cases</h2>
<ul>
  <li><em>"Tax season is starting — here's what you need to do"</em> (send to all active clients)</li>
  <li><em>"Your 2024 tax return is ready for review"</em> (send to clients in a specific pipeline stage)</li>
  <li><em>"Our office will be closed November 27-29"</em> (send to all active clients)</li>
  <li><em>"Please connect your QuickBooks before January 15"</em> (send to all Client Prepared companies)</li>
</ul>

<div class="callout warning"><span class="callout-icon">⚠️</span><div>Always preview recipients before sending. There is no "undo" on a bulk send once it's gone — each message has already been delivered to each client's portal inbox.</div></div>

</div>
    `
  },

  {
    slug: 'settings',
    title: 'Settings & Branding',
    section: 'Other',
    keywords: ['settings', 'branding', 'logo', 'custom domain', 'brand color', 'tax year', 'firm name'],
    prev: { slug: 'bulk-send', title: 'Bulk Send' },
    next: null,
    body: 'Configure your firm branding (logo, colors, name) and set up a custom domain for the client portal.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Other</span><span class="sep">›</span>
  <span>Settings & Branding</span>
</div>
<h1 class="article-title">Settings & Branding</h1>

<div class="article-meta">Section: Other</div>
<div class="article-body">

<p>Go to <strong>Settings (⚙️)</strong> in the left sidebar to manage your firm's branding, custom domain, and tax season controls. Settings has five tabs.</p>

<h2>Firm Branding Tab</h2>
<p>Everything here controls how your firm appears to clients in the portal, in emails, and on PDF reports.</p>

<h3>Logo</h3>
<p>Upload your firm's logo (PNG or JPG, any size). The logo appears:</p>
<ul>
  <li>In the client portal header</li>
  <li>On all PDF report covers (tax financials, workpapers)</li>
  <li>In email notifications to clients</li>
  <li>On proposals sent to clients</li>
</ul>

<h3>Display Name</h3>
<p>Your firm's public-facing name — shown in the portal header and in email subject lines (e.g., "You have a new message from <strong>Smith & Co. CPAs</strong>"). This should match what clients know you as.</p>

<h3>Tagline</h3>
<p>An optional one-liner shown in the portal. Example: "Your trusted retirement advisory team."</p>

<h3>Contact Email</h3>
<p>The reply-to address for portal notification emails. When a client gets an email saying "you have a new message," this is the address that appears if they try to reply directly. Should be a monitored inbox.</p>

<h3>Phone, Website, Address</h3>
<p>Shown on client-facing materials — proposals, email footers, PDF reports.</p>

<h3>Brand Color</h3>
<p>A color picker that sets the accent color used throughout the client portal and on PDF report covers. Choose your firm's primary brand color.</p>
<p><strong>Auto-lightening:</strong> If you choose a very dark color (e.g., near-black navy), DarkLion automatically adjusts it to a lighter shade that works against dark backgrounds. This ensures your branding is always legible regardless of how dark your chosen color is.</p>

<h3>Save Branding</h3>
<p>Click <strong>Save Branding</strong> to apply all changes. Changes take effect immediately for all new client sessions.</p>

<h2>Tax Season Tab</h2>
<p>The Tax Season tab has two controls for managing your organizer rollout each year.</p>

<h3>Active Tax Year</h3>
<p>The default tax year used throughout the app — when uploading documents, creating organizers, and building pipelines. <strong>Update this at the start of each tax season</strong> (e.g., change from 2024 to 2025 in January when you start taking on 2025 prep work).</p>

<h3>Manage Client Organizer Visibility</h3>
<p>Click <strong>📋 Manage Client Organizer Visibility</strong> to open the Tax Season management page. This is where you control which clients see the Organizers tab in their portal.</p>
<ul>
  <li><strong>By default, the Organizers tab is hidden</strong> for all clients. Clients can't see or access their organizer until you enable visibility for them.</li>
  <li>Use <strong>Show All</strong> to flip all clients on at once — useful at the start of tax season when you want to open organizers firm-wide.</li>
  <li>Use <strong>Hide All</strong> to close access for everyone — useful at the end of season.</li>
  <li>Toggle individual clients on or off as needed — for example, if a client isn't ready yet or you're rolling out in batches.</li>
</ul>

<div class="callout tip"><span class="callout-icon">💡</span><div>The visibility toggle is independent of whether you've actually sent the client an organizer. Best practice: send organizers first, then flip visibility when you're ready for clients to start filling them in.</div></div>

<h2>Custom Domains Tab</h2>
<p>By default, clients access the portal at <strong>your-darklion-address/client-login</strong>. With a custom domain, they can access it at your own URL — for example, <strong>portal.yourfirm.com</strong>.</p>

<h3>Setting Up a Custom Domain</h3>
<ol class="step-list">
  <li>Go to Settings → Custom Domains tab.</li>
  <li>Enter your desired domain (e.g., <code>portal.yourfirm.com</code>).</li>
  <li>DarkLion shows you the exact DNS values to configure.</li>
  <li>In your DNS provider (Cloudflare, GoDaddy, etc.), add a CNAME record:
    <ul>
      <li><strong>Name:</strong> <code>portal</code> (or whatever subdomain you chose)</li>
      <li><strong>Value:</strong> DarkLion's provided CNAME target</li>
    </ul>
  </li>
  <li>DNS propagation typically takes a few minutes to a few hours.</li>
  <li>Once verified, DarkLion confirms the domain is active. Clients can now access the portal at your custom URL.</li>
</ol>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>The your-darklion-address/client-login URL continues to work even after you set up a custom domain — existing client bookmarks won't break.</div></div>


</div>
    `
  },

  // ─── VIKTOR AI ──────────────────────────────────────────────────────────────

  {
    slug: 'emma-ai',
    title: 'Emma AI',
    section: 'Emma AI',
    keywords: ['emma', 'AI', 'agent', 'assistant', 'ask', 'intelligence', 'briefing'],
    prev: null,
    next: null,
    body: 'Emma is DarkLion\'s built-in AI agent. Ask Emma about clients, pipelines, open tasks, revenue, or anything else about the firm. Emma has full read and write access to all firm data.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Emma AI</span>
</div>
<h1 class="article-title">Emma AI</h1>

<div class="article-meta">Section: Emma AI</div>
<div class="article-body">

<p>Emma is DarkLion's built-in AI agent — an intelligent assistant that has full access to your firm's data. Emma lives in the right panel of the Dashboard and can answer questions, take actions, and surface insights you might otherwise miss.</p>

<h2>What Emma Can Do</h2>
<ul>
  <li><strong>Answer questions about clients</strong> — "What's the status of the Smith family's return?" or "Which clients haven't signed their 8879 yet?"</li>
  <li><strong>Pipeline intelligence</strong> — "How many cards are stuck in the same stage for more than 2 weeks?" or "What's our completion rate this year vs. last?"</li>
  <li><strong>Firm overview</strong> — Emma generates a morning briefing every day at 4 AM with a summary of open items, pipeline health, and anything that needs attention.</li>
  <li><strong>CRM actions</strong> — Emma can create and update client records, move pipeline cards, and send portal messages — all through natural language.</li>
  <li><strong>Communication drafting</strong> — Ask Emma to draft a client message and you can review it before sending.</li>
</ul>

<h2>How Emma Fits In</h2>
<p>Emma uses the exact same API that you use when you click buttons in DarkLion. There's no separate "AI mode" — Emma is just another user of the system with an <code>agent</code> role. Every action Emma takes is logged in the audit trail with <code>role=agent</code> so you can always see what it did.</p>

<h2>Morning Briefings</h2>
<p>Every morning at 4 AM, Emma pre-generates a briefing for each staff member. When you open the Dashboard, you'll see Emma's summary waiting for you — covering open threads, pipeline stalls, upcoming deadlines, and anything unusual. This is generated fresh each day from live firm data.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>The best way to use Emma is to ask it questions you'd otherwise have to manually compile — like "give me a list of every client whose return has been in the same stage for more than 3 weeks." Emma can do that in seconds.</div></div>

<h2>What Emma Cannot Do</h2>
<ul>
  <li>Emma cannot make decisions on your behalf without you seeing them first — it always shows you what it's about to do and waits for confirmation on sensitive actions.</li>
  <li>Emma cannot access anything outside DarkLion — it only knows what's in your firm's data.</li>
</ul>

</div>
    `
  },

];

/**
 * Build the search index — lightweight version of each article for client-side search.
 */
const searchIndex = articles.map(a => ({
  slug: a.slug,
  title: a.title,
  section: a.section,
  keywords: a.keywords || [],
  body: a.body || '',
}));

/**
 * Home page module cards
 */
const homeModules = [
  { icon: '🚀', title: 'Getting Started', desc: 'New to DarkLion? Start here.', href: '/help/article/what-is-darklion' },
  { icon: '🗂️', title: 'CRM', desc: 'Manage relationships, people, and companies.', href: '/help/article/crm-overview' },
  { icon: '📁', title: 'Documents', desc: 'Upload, organize, and deliver files to clients.', href: '/help/article/documents-overview' },
  { icon: '🔐', title: 'Client Portal', desc: 'Invite clients and manage their experience.', href: '/help/article/portal-overview' },
  { icon: '📋', title: 'Pipelines', desc: 'Track client workflows with kanban boards.', href: '/help/article/pipelines-overview' },
  { icon: '💬', title: 'Messaging', desc: 'Secure client communication inside DarkLion.', href: '/help/article/messaging-overview' },
  { icon: '🧾', title: 'Tax Organizer', desc: 'Collect client documents with smart checklists.', href: '/help/article/organizer-overview' },
  { icon: '🤖', title: 'Emma AI', desc: 'Your AI agent with full firm intelligence.', href: '/help/article/emma-ai' },
];

module.exports = { articles, searchIndex, homeModules };
