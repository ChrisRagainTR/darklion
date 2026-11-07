const { AI_MODEL } = require('./services/aiModel');
const express = require('express');
const path = require('path');
// express-ejs-layouts removed — using EJS native includes instead

// Load .env if present
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  }
} catch (e) {
  // .env loading is optional
}

// === Safety check: refuse to start without JWT_SECRET ===
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
  console.error('Add JWT_SECRET to your .env file or Railway environment variables.');
  process.exit(1);
}

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { isolatedStaging, backgroundJobsEnabled, assertRuntimeSafety, captureNotification, realtimeConfiguration, stagingAccess } = require('./services/runtimeSafety');
assertRuntimeSafety(process.env);
const { initDB, pool } = require('./db');
const { createReleaseHealth } = require('./services/releaseHealth');
const authRouter = require('./routes/auth');
const apiRouter = require('./routes/api');
const firmsRouter = require('./routes/firms');
const { requireFirm, authenticateStaffToken } = require('./middleware/requireFirm');

const app = express();
const { mcpCors } = require('./mcp/cors');
const PORT = process.env.PORT || 8080;
const IS_PROD = process.env.NODE_ENV === 'production';
// Changes on every deploy so versioned scripts bypass the 1-day static cache below.
const ASSET_VERSION = (process.env.RAILWAY_GIT_COMMIT_SHA || String(Date.now())).slice(0, 12);
app.locals.assetVersion = ASSET_VERSION;

// --- EJS template engine ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Using EJS native <%- include() %> for layout

// Trust proxy headers (Fly.io, Railway)
app.set('trust proxy', true);

// Behind Cloudflare, req.ip is a Cloudflare edge address, so rate limits and the audit
// log would lump unrelated clients together. Use CF-Connecting-IP, but only when the
// request really came from Cloudflare (published ranges), so it can't be spoofed by
// calling the origin directly. proxy-addr ships with Express.
const isCloudflareAddr = require('proxy-addr').compile([
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
]);
// Signed-in data must never be stored by browsers or shared caches. Routes that set
// their own Cache-Control later (firm logos, files) still override this.
app.use((req, res, next) => {
  if (/^\/(api|portal|portal-auth|firms|auth)\//.test(req.path)) res.set('Cache-Control', 'no-store');
  next();
});
app.use((req, res, next) => {
  const clientIp = req.headers['cf-connecting-ip'];
  if (typeof clientIp === 'string' && clientIp && req.ip && isCloudflareAddr(req.ip.replace(/^::ffff:/, ''), 0)) {
    Object.defineProperty(req, 'ip', { value: clientIp.trim(), configurable: true });
  }
  next();
});

// --- Security headers (Helmet) ---
// Content Security Policy. Client-facing pages enforce it; staff pages still run it in
// report-only mode (browsers report what it would block to /csp-report) until their
// reports are clean. 'unsafe-inline' stays until inline scripts/handlers move to files;
// the policy still limits which outside hosts can run code, receive data, or frame the app.
const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'", 'https://js.pusher.com', 'https://cdn.jsdelivr.net', 'https://static.cloudflareinsights.com'],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
  'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'media-src': ["'self'", 'blob:', 'https:'],
  'connect-src': ["'self'", 'https://*.pusher.com', 'wss://*.pusher.com', 'https://*.amazonaws.com', 'https://*.r2.cloudflarestorage.com', 'https://cloudflareinsights.com'],
  'frame-src': ["'self'", 'blob:', 'https:'],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'self'"],
  'report-uri': ['/csp-report'],
};
const CSP_HEADER_VALUE = Object.entries(CSP_DIRECTIVES).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
const CSP_ENFORCED_PATHS = /^\/(portal|client-login(\/.*)?|portal-login|organizer(\.html)?)$/;
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use((req, res, next) => {
  res.setHeader(CSP_ENFORCED_PATHS.test(req.path) ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', CSP_HEADER_VALUE);
  next();
});

// CSP violation reports: logged (trimmed, rate-limited) so we can see what an
// enforced policy would break before enforcing it.
let cspReportWindow = 0, cspReportsThisMinute = 0;
app.post('/csp-report', express.json({ type: ['application/csp-report', 'application/json', 'application/reports+json'], limit: '16kb' }), (req, res) => {
  const minute = Math.floor(Date.now() / 60000);
  if (minute !== cspReportWindow) { cspReportWindow = minute; cspReportsThisMinute = 0; }
  if (cspReportsThisMinute++ < 30) {
    const r = req.body?.['csp-report'] || req.body?.[0]?.body || req.body || {};
    const page = String(r['document-uri'] || r.documentURL || '').replace(/[?#].*$/, '');
    console.warn('[csp-report]', JSON.stringify({
      page,
      directive: r['violated-directive'] || r.effectiveDirective || '',
      blocked: String(r['blocked-uri'] || r.blockedURL || '').replace(/[?#].*$/, '').slice(0, 200),
    }));
  }
  res.status(204).end();
});

// Probes must precede custom-domain database lookup, redirects, and auth.
const releaseHealth = createReleaseHealth({
  checkDatabase: () => pool.query({ text: 'SELECT 1', query_timeout: 2000 }),
});
app.use(releaseHealth.router);
app.use(stagingAccess(process.env));

// Only public Pusher configuration is exposed; staging never joins live channels.
app.get('/realtime-config.js', (req, res) => {
  res.set('Cache-Control', 'no-store').type('application/javascript').send(
    'window.DL_REALTIME_CONFIG = ' + JSON.stringify(realtimeConfiguration(process.env)).replace(/</g, '\\u003c') + ';'
  );
});

// --- CORS ---
app.use(mcpCors);
app.use((req, res, next) => {
  const configuredOrigins = [process.env.APP_URL, process.env.PUBLIC_APP_URL, ...(process.env.CORS_ORIGINS || '').split(',')]
    .map((value) => String(value || '').trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const allowedOrigins = IS_PROD
    ? configuredOrigins
    : [...configuredOrigins, 'http://localhost:8080', 'http://127.0.0.1:8080'];

  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Inbound email replies can include base64 attachments. Mount this before the
// default JSON parser so the webhook gets an explicit, bounded payload limit.
const inboundEmailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many inbound email webhook requests.' },
});
const emailRepliesRouter = require('./routes/email-replies');
app.use('/api/email-replies', inboundEmailLimiter, express.json({ limit: '40mb' }), express.urlencoded({ limit: '40mb', extended: false }), emailRepliesRouter);

// Twilio signs the original form-encoded webhook body. This route must remain
// public (signature-authenticated) and mounted before the broad /api auth gate.
const inboundSmsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many inbound SMS webhook requests.' },
});
const twilioWebhooksRouter = require('./routes/twilio-webhooks');
app.use('/api/twilio', inboundSmsLimiter, express.urlencoded({ limit: '256kb', extended: false }), twilioWebhooksRouter);

// Drawn signatures are PNG images; a detailed one from a high-resolution phone can pass the default 100 KB limit.
app.use(/^\/portal\/tax-deliveries\/\d+\/sign$/, express.json({ limit: '2mb' }));
app.post('/subscription-webhook', express.raw({ type: 'application/json', limit: '1mb' }), require('./routes/subscriptions').webhook);
app.use('/api/onboarding/import', express.json({ limit: '600kb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // needed for Pusher auth endpoint

// Support tokens are purpose-bound and checked before any route or provider call.
app.use(require('./middleware/supportSession').supportSession);

// --- Custom domain firm resolution ---
const { domainFirmMiddleware } = require('./middleware/domainFirm');
app.use(domainFirmMiddleware);

// Make domain firm available to all EJS views
const { formatPersonDisplayName } = require('./utils/displayName');
app.use((req, res, next) => {
  res.locals.firmBranding = req.domainFirm || null;
  res.locals.formatPersonDisplayName = formatPersonDisplayName;
  next();
});

// --- Force HTTPS in production ---
if (IS_PROD) {
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
  });
}

// --- Global API rate limiter ---
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // portal polling + normal usage needs headroom
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false }, // suppress ERR_ERL_PERMISSIVE_TRUST_PROXY — we trust Railway's proxy
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => req.path === '/health',
});

const mcpOAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many OAuth requests. Please slow down.' },
});

// Team Chat is bursty by design: rapid sends, realtime fallback polling,
// unread badge checks, and attachment previews can legitimately cluster.
// Keep it isolated from the normal API limiter so chat bursts don't break sync.
const teamChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1800,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  keyGenerator: (req) => `${req.firm?.id || 'firm'}:${req.firm?.userId || rateLimit.ipKeyGenerator(req.ip)}`,
  message: { error: 'Team Chat is syncing a lot right now. Retrying automatically.' },
});

// --- Legacy Basic Auth (backward compat — dev mode only) ---
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS;

function requireBasicAuth(req, res, next) {
  if (!DASH_PASS) return next();
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Basic ')) {
    const encoded = authHeader.split(' ')[1];
    if (encoded) {
      const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
      if (user === DASH_USER && pass === DASH_PASS) return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="DarkLion Dashboard"');
  res.status(401).send('Authentication required');
}

// Dashboard auth: accept JWT Bearer OR legacy Basic Auth
function dashboardAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  // Try JWT first
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return requireFirm(req, res, next);
  }

  // Fall back to Basic Auth (dev mode)
  return requireBasicAuth(req, res, next);
}

// --- Public desktop app downloads ---
const publicDir = path.join(__dirname, '..', 'public');

// Installers are not shipped in the source repo. Build them from apps/desktop or
// darklion-drive and place them in public/downloads to enable these links.
function sendInstaller(res, fileName) {
  const file = path.join(publicDir, 'downloads', fileName);
  if (!require('fs').existsSync(file)) {
    return res.status(404).type('text/plain').send('Installer not available on this server. Build it from the DarkLion source (apps/desktop or darklion-drive) and place it in public/downloads.');
  }
  res.download(file, fileName);
}

app.get('/downloads/darklion-drive/windows', (req, res) => {
  sendInstaller(res, 'DarkLionDrive_Setup_1.0.2.exe');
});

app.get('/downloads/darklion-desktop/windows', (req, res) => {
  sendInstaller(res, 'DarkLionDesktop_Setup_1.0.3.exe');
});

// --- Static files ---

// HTML files: no-cache (always fetch fresh from server)
// Other static assets (images, fonts, etc.): cache 1 day in prod
app.use(express.static(publicDir, {
  index: false,
  setHeaders(res, filePath) {
    if (IS_PROD && !filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// --- Public page routes ---

// Custom domain root — clients land on the client sign-in; staff use /login directly
app.get('/', (req, res, next) => {
  if (process.env.ADMIN_HOSTNAME && req.hostname === process.env.ADMIN_HOSTNAME) return res.redirect('/admin');
  if (req.domainFirm) return res.redirect('/client-login');
  // Self-hosted installs have no marketing homepage; send visitors to sign in.
  if (process.env.DARKLION_SELF_HOSTED !== 'false') return res.redirect('/login');
  next();
});

app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/connect', (req, res) => res.sendFile(path.join(publicDir, 'connect.html')));
app.get('/callback', (req, res) => res.sendFile(path.join(publicDir, 'callback.html')));
app.get('/disconnect', (req, res) => res.sendFile(path.join(publicDir, 'disconnect.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(publicDir, 'terms.html')));

// --- Auth pages (public) ---

// Branded login for custom domains — must come BEFORE the default /login route
app.get('/login', (req, res, next) => {
  if (req.domainFirm) {
    return res.render('login-branded', {
      title: `${req.domainFirm.name} — Sign In`,
      firmName: req.domainFirm.name,
      firmDomain: req.domainFirm.domain,
      firmId: req.domainFirm.id,
    });
  }
  next();
});

app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/register', (req, res) => req.domainFirm ? res.redirect('/client-login') : res.sendFile(path.join(publicDir, 'register.html')));

// --- Invite page (public) ---
app.get('/invite/:token', (req, res) => res.sendFile(path.join(publicDir, 'invite.html')));

let adminHtml;
app.get(['/admin', '/admin/firms/:id', '/admin/access-log'], (req, res) => {
  adminHtml ||= require('fs').readFileSync(path.join(publicDir, 'admin.html'), 'utf8').replaceAll('__ASSET_VERSION__', ASSET_VERSION);
  res.set('Cache-Control', 'no-store').type('html').send(adminHtml);
});
app.use('/api/platform-admin', require('./routes/platform-admin'));

// --- Staff pages (EJS templates with unified layout) ---
// Note: auth is handled client-side (JWT in localStorage); server just serves the pages
app.get('/dashboard', (req, res) => res.render('dashboard', { title: 'Firm overview', activeNav: 'dashboard' }));
app.get('/today', (req, res) => res.render('today', { title: 'Today', activeNav: 'today' }));

// ─── HELP CENTER (public, no auth required) ───────────────────────────────
const { articles: helpArticles, searchIndex: helpSearchIndex, homeModules: helpHomeModules } = require('./help-articles');

function renderHelp(res, body, title, currentSlug) {
  res.render('help-layout', { body, title, currentSlug, searchIndex: helpSearchIndex });
}

app.get('/help', (req, res) => {
  const homeHtml = `
    <div class="help-home-hero">
      <h1>DarkLion Help Center</h1>
      <p>Everything you need to get the most out of DarkLion — for staff, accountants, and bookkeepers.</p>
    </div>
    <div class="help-module-grid">
      ${helpHomeModules.map(m => `
        <a href="${m.href}" class="help-module-card">
          <div class="card-icon">${m.icon}</div>
          <div class="card-title">${m.title}</div>
          <div class="card-desc">${m.desc}</div>
        </a>
      `).join('')}
    </div>
  `;
  renderHelp(res, homeHtml, 'Help Center', 'home');
});

app.get('/help/article/:slug', (req, res) => {
  const article = helpArticles.find(a => a.slug === req.params.slug);
  if (!article) return res.status(404).render('help-layout', {
    body: `<h1 class="article-title">Article Not Found</h1><p style="color:var(--muted)">That article doesn't exist. <a href="/help">Return to Help Center →</a></p>`,
    title: 'Not Found',
    currentSlug: '',
    searchIndex: helpSearchIndex,
  });

  const nav = `<div class="article-nav">
    ${article.prev ? `<a href="/help/article/${article.prev.slug}"><span class="nav-label">← Previous</span><span class="nav-title">${article.prev.title}</span></a>` : '<span></span>'}
    ${article.next ? `<a href="/help/article/${article.next.slug}" class="next"><span class="nav-label">Next →</span><span class="nav-title">${article.next.title}</span></a>` : ''}
  </div>`;

  renderHelp(res, article.html + nav, article.title, article.slug);
});
// ─────────────────────────────────────────────────────────────────────────────
app.get('/statements-calendar', (req, res) => res.render('statements-calendar', { title: 'Statement Calendar', activeNav: 'statements-calendar' }));
app.get('/documents', (req, res) => res.render('documents', { title: 'Documents', activeNav: 'documents' }));
app.get('/dashboard.html', (req, res) => res.redirect('/dashboard'));
app.get('/theme-preview', (req, res) => res.sendFile(path.join(publicDir, 'theme-preview.html')));
// Team page — redirect to dashboard team section for now
app.get('/team', (req, res) => res.render('team', { title: 'Team', activeNav: '' }));
// CRM pages — EJS shell
app.get('/crm', (req, res) => res.render('crm', { title: 'CRM', activeNav: 'relationships' }));
app.get('/crm.html', (req, res) => res.redirect('/crm'));
app.get('/crm/relationships', (req, res) => res.redirect('/crm?tab=relationships'));
app.get('/crm/people', (req, res) => res.redirect('/crm?tab=people'));
app.get('/crm/companies', (req, res) => res.redirect('/crm?tab=companies'));
app.get('/crm/person/:id', (req, res) => res.render('crm-person', { title: 'Person', activeNav: 'people' }));
app.get('/crm/company/:id', (req, res) => res.render('crm-company', { title: 'Company', activeNav: 'companies' }));
app.get('/crm/relationship/:id', (req, res) => res.render('crm-relationship', { title: 'Relationship', activeNav: 'relationships' }));

// --- Public config endpoint ---
app.get('/api/config', (req, res) => {
  res.json({
    qb_client_id: process.env.QB_CLIENT_ID || '',
    qb_redirect_uri: process.env.QB_REDIRECT_URI || `${req.protocol}://${req.hostname}/callback.html`,
  });
});

// --- Remote MCP OAuth discovery, authorization, and stateless transport ---
const mcpOAuthRoutes = require('./routes/mcp-oauth');
const { createDarkLionMcpRouter } = require('./mcp');
app.use('/oauth', mcpOAuthLimiter);
app.use('/.well-known/oauth-protected-resource', mcpOAuthLimiter);
app.use('/.well-known/oauth-authorization-server', mcpOAuthLimiter);
app.use('/', mcpOAuthRoutes.router);
app.use('/mcp', apiLimiter, createDarkLionMcpRouter());

// --- Firms routes (register/login/invite-lookup are public; protected routes use requireFirm internally) ---
app.use('/firms', firmsRouter);
app.use('/enrollment', require('./routes/enrollment'));
app.get('/join', (req, res) => req.domainFirm ? res.redirect('/client-login') : res.sendFile(path.join(publicDir, 'join.html')));
app.get('/account', (req, res) => res.sendFile(path.join(publicDir, 'account.html')));
app.get('/workspace-setup', (req, res) => res.sendFile(path.join(publicDir, 'workspace-setup.html')));
// Staff list route registered AFTER requireToken (see below)

// --- Auth (QBO OAuth callback — public) ---
app.use('/auth', authRouter);

// --- LedgerHQ firm-level OAuth callback (public) ---
const ledgerHqRoutes = require('./routes/ledgerhq');
app.use('/ledgerhq', ledgerHqRoutes.publicRouter);

// --- Public API routes (no auth) — MUST be before requireFirm mounts ---
const proposalsPublicRouter = require('./routes/proposals-public');
app.use('/api/proposals/public', apiLimiter, proposalsPublicRouter);

// --- Token auth middleware — runs before requireFirm, sets req.firm for API token holders ---
const { requireToken } = require('./middleware/requireToken');
app.use('/api', requireToken);
app.use('/api/account-security', requireFirm, require('./routes/account-security'));
app.use('/api/firm-settings', requireFirm, require('./routes/firm-settings'));
app.use('/api/subscription', requireFirm, require('./routes/subscriptions').router);
app.use('/api/onboarding', express.json({ limit: '600kb' }), requireFirm, require('./routes/onboarding'));

// Agent callbacks/work API — after requireToken but before requireFirm mounts; authenticated by per-connection callback token
const agentCallbacksRouter = require('./routes/agent-callbacks');
app.use('/api/agent-callbacks', apiLimiter, agentCallbacksRouter);
const agentWorkRouter = require('./routes/agent-work');
app.use('/api/agent-work', apiLimiter, agentWorkRouter);

// Native DarkLion Team Chat APIs — mounted before the broad /api router.
// Telegram is no longer a Team Chat backend or /api/team-chat sub-route.
// Personal assistant Telegram connectors live under Settings → Agents via /api/agent-connections.
const teamChatRouter = require('./routes/team-chat');
app.use('/api/team-chat', requireFirm, teamChatLimiter, teamChatRouter);

const mobileNotificationsRouter = require('./routes/mobile-notifications');
app.use('/api/mobile', requireFirm, apiLimiter, mobileNotificationsRouter);

// Staff list — after requireToken so API key auth works
const { pool: _pool } = require('./db');
app.get('/api/staff', requireFirm, apiLimiter, async (req, res) => {
  try {
    const { rows } = await _pool.query(
      `SELECT id, name, display_name, email, role, last_login_at, created_at
       FROM firm_users
       WHERE firm_id = $1
         AND accepted_at IS NOT NULL
         AND archived_at IS NULL
       ORDER BY name ASC`,
      [req.firm.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch staff' }); }
});

// --- API routes (JWT required) ---
app.use('/api', requireFirm, apiLimiter, apiRouter);

const relationshipsRouter = require('./routes/relationships');
const peopleRouter = require('./routes/people');
app.use('/api/relationships', requireFirm, apiLimiter, relationshipsRouter);
app.use('/api/people', requireFirm, apiLimiter, peopleRouter);

const documentsRouter = require('./routes/documents');
app.use('/api/documents', requireFirm, apiLimiter, documentsRouter);

const messagesRouter = require('./routes/messages');
app.use('/api/messages', requireFirm, apiLimiter, messagesRouter);

const documentNotificationsRouter = require('./routes/document-notifications');
app.use('/api/document-notifications', requireFirm, apiLimiter, documentNotificationsRouter);

const communicationExportsRouter = require('./routes/communication-exports');
app.use('/api/communication-exports', requireFirm, apiLimiter, communicationExportsRouter);
const communicationArchiveHealthRouter = require('./routes/communication-archive-health');
app.use('/api/communication-archive/health', requireFirm, apiLimiter, communicationArchiveHealthRouter);
app.get('/messages', (req, res) => res.render('messages', { title: 'Messages', activeNav: 'messages' }));

const inboxRouter = require('./routes/inbox');
app.use('/api/inbox', requireFirm, apiLimiter, inboxRouter);

const agentConnectionsRouter = require('./routes/agent-connections');
app.use('/api/agent-connections', requireFirm, apiLimiter, agentConnectionsRouter);

app.use('/api/ledgerhq', requireFirm, apiLimiter, ledgerHqRoutes.router);

const bulkSendRouter = require('./routes/bulk-send');
app.use('/api/bulk-send', requireFirm, apiLimiter, bulkSendRouter);
app.get('/bulk-send', (req, res) => res.render('bulk-send', { title: 'Bulk Send', activeNav: 'bulk-send' }));

const summariesRouter = require('./routes/summaries');
app.use('/api/summaries', requireFirm, apiLimiter, summariesRouter);
app.get('/conversation-summaries', (req, res) => res.render('conversation-summaries', { title: 'Conversation Summaries', activeNav: 'conversation-summaries' }));

const templatesRouter = require('./routes/templates');
app.use('/api/templates', requireFirm, apiLimiter, templatesRouter);

const dashboardRouter = require('./routes/dashboard');
app.use('/api/dashboard', requireFirm, apiLimiter, dashboardRouter);
app.use('/api/today', requireFirm, apiLimiter, require('./routes/today'));
app.use('/api/mobile/staff', requireFirm, apiLimiter, require('./routes/mobile-staff'));
app.get('/templates', (req, res) => res.render('templates', { title: 'Message Templates', activeNav: 'templates' }));
app.get('/settings', (req, res) => res.render('settings', { title: 'Settings', activeNav: 'settings' }));
app.get('/api-docs', (req, res) => res.render('api-docs', { title: 'DarkLion API Documentation' }));
app.get('/api-docs.md', (req, res) => {
  res.type('text/markdown; charset=utf-8');
  res.sendFile(path.join(__dirname, '..', 'docs', 'api-docs.md'));
});
app.get('/openapi.json', (req, res) => {
  res.type('application/json; charset=utf-8');
  res.sendFile(path.join(__dirname, '..', 'docs', 'openapi.json'));
});
app.get('/llms.txt', (req, res) => {
  res.type('text/plain; charset=utf-8');
  res.sendFile(path.join(__dirname, '..', 'docs', 'llms.txt'));
});

const pipelinesRouter = require('./routes/pipelines');
app.use('/api/pipelines', requireFirm, apiLimiter, pipelinesRouter);

const pipelineTriggersRouter = require('./routes/pipeline-triggers');
app.use('/api/pipeline-triggers', requireFirm, apiLimiter, pipelineTriggersRouter);

const pipelineActionsRouter = require('./routes/pipeline-actions');
app.use('/api/pipeline-actions', requireFirm, apiLimiter, pipelineActionsRouter);
app.get('/pipelines', (req, res) => res.render('pipelines', { title: 'Pipelines', activeNav: 'pipelines' }));
app.get('/pipelines/:instanceId/settings', (req, res) => res.render('pipeline-settings', { title: 'Pipeline Settings', activeNav: 'pipelines' }));

const myWorkRouter = require('./routes/my-work');
app.use('/api/my-work', requireFirm, apiLimiter, myWorkRouter);
app.get('/my-work', (req, res) => res.render('my-work', { title: 'My Work', activeNav: 'my-work' }));
app.get('/team-chat', (req, res) => res.render('team-chat', { title: 'Team Chat', activeNav: 'team-chat' }));

const engagementRouter = require('./routes/engagement');
app.use('/api/engagement', requireFirm, apiLimiter, engagementRouter);

const billingRouter = require('./routes/billing');
app.use('/api/billing', requireFirm, apiLimiter, billingRouter);

const forecastRouter = require('./routes/forecast');
app.use('/api/forecast', requireFirm, apiLimiter, forecastRouter);
app.get('/forecast', (req, res) => res.render('forecast', { title: 'Revenue Forecast', activeNav: 'forecast' }));

const taxDeliveryRouter = require('./routes/tax-delivery');
app.use('/api/tax-deliveries', requireFirm, apiLimiter, taxDeliveryRouter);

const organizerRouter = require('./routes/organizer');
app.use('/api/organizers', requireFirm, apiLimiter, organizerRouter);

const taxSeasonRouter = require('./routes/tax-season');
app.use('/api/tax-season', apiLimiter, taxSeasonRouter);
app.get('/tax-season', (req, res) => res.render('tax-season', { title: 'Tax Season', activeNav: 'tax-season' }));

const bookkeeperRouter = require('./routes/bookkeeper');
app.use('/api/bookkeeper', apiLimiter, bookkeeperRouter);
app.get('/bookkeeper', (req, res) => res.render('bookkeeper', { title: 'Bookkeeper', activeNav: 'bookkeeper' }));

// Proposals — staff (auth required)
const proposalsRouter = require('./routes/proposals');
app.use('/api/proposals', requireFirm, apiLimiter, proposalsRouter);

// Emma context endpoint
const emmaRouter = require('./routes/emma');
app.use('/api/emma', requireFirm, apiLimiter, emmaRouter);

const emmaChatRouter = require('./routes/emma-chat');
app.use('/api/emma-chat', requireFirm, apiLimiter, emmaChatRouter);

const blueleafRouter = require('./routes/blueleaf');
app.use('/api', requireFirm, apiLimiter, blueleafRouter);

// Proposal pages (staff)
app.get('/proposals', (req, res) => res.render('proposals', { title: 'Proposals', activeNav: 'proposals' }));
app.get('/proposals/new', (req, res) => res.render('proposal-create', { title: 'New Proposal', activeNav: 'proposals' }));
app.get('/proposals/:id([0-9]+)', (req, res) => res.render('proposal-detail', { title: 'Proposal', activeNav: 'proposals' }));
app.get('/proposals/:id([0-9]+)/edit', (req, res) => res.render('proposal-create', { title: 'Edit Proposal', activeNav: 'proposals' }));

// Public client-facing proposal pages (no auth)
app.get('/p/:token', (req, res) => res.sendFile(path.join(publicDir, 'proposal-view.html')));
app.get('/p/:token/sign', (req, res) => res.sendFile(path.join(publicDir, 'proposal-sign.html')));

const portalAuthRouter = require('./routes/portal-auth');
const portalRouter = require('./routes/portal');
const portalMobileRouter = require('./routes/portal-mobile');
const { requirePortal } = require('./middleware/requirePortal');
app.use('/portal/account-security', requirePortal, require('./routes/account-security'));
app.get('/portal/preferences', requirePortal, async (req, res) => {
  try {
    // Clients get branding only, never staff, security or AI settings.
    const { name, primaryColor, portalIconUrl, appName, appStoreUrl } = await require('./services/firmPreferences').getFirmPreferences(req.portal.firmId);
    res.set('Cache-Control', 'no-store').json({ name, primaryColor, portalIconUrl, appName, appStoreUrl });
  }
  catch (_) { res.status(503).json({error:'Firm settings unavailable'}); }
});

// Public portal auth (no middleware)
app.use('/portal-auth', portalAuthRouter);

// Portal HTML pages (public — must come BEFORE the requirePortal middleware)
app.get('/app', (req, res) => res.sendFile(path.join(publicDir, 'app.html')));
app.get('/portal', (req, res) => res.sendFile(path.join(publicDir, 'portal.html')));
// /client-login is canonical; /portal-login kept as alias for backwards compatibility
function serveClientLogin(req, res) {
  const html = require('fs').readFileSync(require('path').join(__dirname, '../public/portal-login.html'), 'utf8');
  if (req.params.firmSlug) {
    const slugScript = `<script>window.__FIRM_SLUG__ = ${JSON.stringify(req.params.firmSlug).replace(/</g, "\\u003c")};</script>`;
    return res.send(html.replace('<head>', '<head>' + slugScript));
  }
  if (req.domainFirm) {
    const firmScript = `<script>window.__FIRM__ = ${JSON.stringify({ name: req.domainFirm.name }).replace(/</g, "\\u003c")};</script>`;
    return res.send(html.replace('<head>', '<head>' + firmScript));
  }
  res.send(html);
}
app.get('/client-login', serveClientLogin);
app.get('/client-login/:firmSlug', serveClientLogin);
app.get('/portal-login', serveClientLogin); // alias — don't break existing links

// Portal organizer routes (organizerRouter already required above)
app.use('/portal/organizer', requirePortal, apiLimiter, organizerRouter);

const marketRouter = require('./routes/market');
app.use('/api/market', requireFirm, apiLimiter, marketRouter);
app.use('/portal/market', requirePortal, apiLimiter, marketRouter);

// Mobile-specific portal API must mount before the generic /portal router.
app.use('/portal/mobile', requirePortal, apiLimiter, portalMobileRouter);

// Protected portal API routes (sub-paths like /portal/me, /portal/documents, etc.)
app.use('/portal', requirePortal, apiLimiter, portalRouter);

// --- Nightly scan cron (runs at 2 AM UTC) ---
function startNightlyCron() {
  const { pool } = require('./db');
  const { scanUncategorized } = require('./services/scanner');
  const { generateDefaultClosePackage, defaultClosePackagePeriod } = require('./services/reports');
  const { scanVariance } = require('./services/variance');
  const { scanLiabilities } = require('./services/liability');

  function msUntil2AM() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(2, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  async function runNightlyScans() {
    console.log('Starting nightly scans...');
    // ── Proactive QBO token refresh — keeps all connections alive (runs before scans) ──
    try {
      const { refreshAllTokens } = require('./services/qboTokens');
      const result = await refreshAllTokens();
      console.log(`[qbo-refresh] Done — refreshed: ${result.refreshed}, failed: ${result.failed}`);
      if (result.errors.length) result.errors.forEach(e => console.error(`[qbo-refresh] ${e.company}: ${e.error}`));
    } catch (e) {
      console.error('[qbo-refresh] Fatal error:', e.message);
      const { sendErrorAlert } = require('./services/alerts');
      sendErrorAlert({ source: 'cron/qbo-token-refresh', error: e }).catch(() => {});
    }
    try {
      const { rows: companies } = await pool.query('SELECT realm_id, company_name FROM companies');
      const period = defaultClosePackagePeriod();

      for (const c of companies) {
        try {
          await scanUncategorized(c.realm_id);
          console.log(`Nightly uncategorized scan complete: ${c.company_name || c.realm_id}`);
        } catch (e) {
          console.error(`Nightly scan failed for ${c.company_name || c.realm_id}:`, e.message);
        }
        try {
          await generateDefaultClosePackage(c.realm_id);
          console.log(`Nightly close package complete: ${c.company_name || c.realm_id} (${period})`);
        } catch (e) {
          console.error(`Nightly close package failed for ${c.company_name || c.realm_id}:`, e.message);
        }
        try {
          await scanVariance(c.realm_id);
          console.log(`Nightly variance scan complete: ${c.company_name || c.realm_id}`);
        } catch (e) {
          console.error(`Nightly variance scan failed for ${c.company_name || c.realm_id}:`, e.message);
        }
        try {
          await scanLiabilities(c.realm_id);
          console.log(`Nightly liability check complete: ${c.company_name || c.realm_id}`);
        } catch (e) {
          console.error(`Nightly liability check failed for ${c.company_name || c.realm_id}:`, e.message);
        }
      }
      console.log('Nightly scans finished.');
    } catch (e) {
      console.error('Nightly scan error:', e.message);
      const { sendErrorAlert } = require('./services/alerts');
      sendErrorAlert({ source: 'cron/nightly-scans', error: e }).catch(() => {});
    }
    setTimeout(runNightlyScans, msUntil2AM());
  }

  const ms = msUntil2AM();
  console.log(`Nightly scans scheduled in ${Math.round(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m (2:00 AM UTC)`);
  setTimeout(runNightlyScans, ms);
}

// ── Emma briefing pre-generation (runs at 4 AM UTC = midnight EDT) ─────────
// Pre-generates morning briefings for all active firm users so they're
// instant when staff open the app at 8am.
function startEmmaBriefingCron() {
  const { pool } = require('./db');
  const Anthropic = require('@anthropic-ai/sdk');
  const { getFirmContext } = require('./services/emmaContext');

  function msUntil4AM() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(4, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  async function runBriefings() {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[briefing-cron] Starting Emma briefing pre-generation for ${today}...`);

    try {
      // Get all active firm users (accepted, not archived)
      const { rows: users } = await pool.query(`
        SELECT fu.id as user_id, fu.firm_id, fu.name, fu.email
        FROM firm_users fu
        WHERE fu.accepted_at IS NOT NULL
          AND fu.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM firm_feature_flags flags
            WHERE flags.firm_id = fu.firm_id
              AND flags.feature_key = 'embedded_chat' AND flags.enabled = FALSE
          )
        ORDER BY fu.firm_id, fu.id
      `);

      console.log(`[briefing-cron] Generating briefings for ${users.length} users...`);

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error('[briefing-cron] ANTHROPIC_API_KEY not set — skipping.');
        setTimeout(runBriefings, msUntil4AM());
        return;
      }

      const client = new Anthropic({ apiKey });

      for (const user of users) {
        try {
          // Re-read at execution time: an operator can disable a firm while a
          // previous user's briefing is still running.
          const { getFirmFeatures } = require('./services/firmFeatures');
          if (!(await getFirmFeatures(user.firm_id)).embedded_chat) continue;
          // Skip if already generated today
          const { rows: existing } = await pool.query(
            'SELECT briefing_generated FROM emma_sessions WHERE firm_id = $1 AND user_id = $2 AND session_date = $3',
            [user.firm_id, user.user_id, today]
          );
          if (existing[0]?.briefing_generated) {
            console.log(`[briefing-cron] Already done: user ${user.user_id} (${user.email})`);
            continue;
          }

          // Fetch firm context
          const context = await getFirmContext(user.firm_id).catch(() => ({}));

          // Build context summary
          const contextParts = [];
          if (context.pipelineJobs?.length) contextParts.push(`Pipeline jobs: ${context.pipelineJobs.length} active`);
          if (context.unsignedReturns?.length) contextParts.push(`Unsigned returns: ${context.unsignedReturns.length} waiting`);
          if (context.stalledMessages?.length) contextParts.push(`Stalled messages: ${context.stalledMessages.length} threads >48h`);
          if (context.openProposals?.length) contextParts.push(`Open proposals: ${context.openProposals.length}`);
          if (context.expiringEngagements?.length) contextParts.push(`Expiring engagements: ${context.expiringEngagements.length}`);
          const contextSummary = contextParts.join('\n') || 'No urgent items at this time.';

          const greeting = 'Good morning';
          const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

          const { buildSystemPrompt } = require('./services/emmaPrompt');
          const systemPrompt = await buildSystemPrompt(user.firm_id).catch(() => 'You are Emma, an AI advisor assistant for a CPA/wealth management firm.');

          const response = await client.messages.create({
            model: AI_MODEL, // use Haiku for cron — faster + cheaper
            max_tokens: 1000,
            system: systemPrompt,
            messages: [{
              role: 'user',
              content: `${greeting}. Generate my daily briefing for today (${dateStr}).\n\nCurrent firm data:\n${contextSummary}\n\nProvide a concise, actionable morning briefing with prioritized tasks.`
            }]
          });

          const briefingText = response.content[0]?.text || 'Good morning! Ready when you are.';
          const messages = [
            { role: 'assistant', content: briefingText, timestamp: new Date().toISOString() }
          ];

          await pool.query(
            `INSERT INTO emma_sessions (firm_id, user_id, session_date, messages, briefing_generated)
             VALUES ($1, $2, $3, $4, TRUE)
             ON CONFLICT (firm_id, user_id, session_date)
             DO UPDATE SET messages = $4, briefing_generated = TRUE, updated_at = NOW()`,
            [user.firm_id, user.user_id, today, JSON.stringify(messages)]
          );

          console.log(`[briefing-cron] Done: ${user.email}`);

          // Small delay between users to avoid hammering the API
          await new Promise(r => setTimeout(r, 500));

        } catch (e) {
          console.error(`[briefing-cron] Failed for user ${user.user_id} (${user.email}):`, e.message);
        }
      }

      console.log('[briefing-cron] All briefings generated.');
    } catch (e) {
      console.error('[briefing-cron] Fatal error:', e.message);
    }

    setTimeout(runBriefings, msUntil4AM());
  }

  const ms = msUntil4AM();
  console.log(`[briefing-cron] Scheduled in ${Math.round(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m (4:00 AM UTC / midnight EDT)`);
  setTimeout(runBriefings, ms);
}

// ── Pusher setup ─────────────────────────────────────────────────────────────
const Pusher = require('pusher');
const pusherConfigured = Boolean(process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET && process.env.PUSHER_CLUSTER);
const pusher = isolatedStaging(process.env) ? {
  trigger: (channels, event, data) => captureNotification('realtime', { channels, event, data }),
  authorizeChannel: () => { throw new Error('REALTIME_DISABLED_IN_STAGING'); },
} : !pusherConfigured ? {
  // Realtime is optional. Without Pusher keys, pages fall back to polling.
  trigger: async () => ({ skipped: true }),
  authorizeChannel: () => { throw new Error('REALTIME_NOT_CONFIGURED'); },
} : new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});
app.set('pusher', pusher);

// Pusher auth endpoints — token sent in the Authorization header. The ?token= fallback
// only serves pages opened before the header switch; drop it once they have reloaded.
function pusherAuthToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
}
// Staff: authorizes firm, portal, and staff-scoped Team Chat channels
app.post('/pusher/auth/staff', async (req, res) => {
  const token = pusherAuthToken(req);
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const firm = await authenticateStaffToken(token);
    const preferences = await require('./services/firmPreferences').getFirmPreferences(firm.id);
    if (preferences.staffMfaRequired && !(await require('./services/accountSecurity').ensureAccount({firmId:firm.id,kind:'staff',accountId:firm.userId})).mfa_enabled) return res.status(403).json({error:'Set up MFA first'});
    const firmId = firm.id;
    const channelName = req.body.channel_name;
    const userId = firm.userId;
    const allowed = channelName === `private-firm-${firmId}` ||
                    channelName.startsWith(`private-portal-${firmId}-`) ||
                    (userId && channelName === `private-team-chat-${firmId}-${userId}`);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    res.json(pusher.authorizeChannel(req.body.socket_id, channelName));
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Portal: authorizes private-portal-{firmId}-{personId} channel. A Bearer token (native and
// phone web app) or ?token= (old pages) is used when present; otherwise requirePortal reads the
// web portal's HttpOnly session cookie (with its same-site Origin check, since this is a POST).
app.post('/pusher/auth/portal', (req, res, next) => {
  const portalSession = require('./services/portalSession');
  if (!portalSession.bearerToken(req)) {
    const legacy = typeof req.query.token === 'string' ? req.query.token : '';
    if (legacy) req.headers.authorization = 'Bearer ' + legacy;
    else if (!portalSession.cookieToken(req)) return res.status(401).json({ error: 'No token' });
  }
  return requirePortal(req,res,next);
}, (req,res) => {
  try {
    const channelName = req.body.channel_name;
    const expected = `private-portal-${req.portal.firmId}-${req.portal.personId}`;
    if (channelName !== expected) return res.status(403).json({ error: 'Forbidden' });
    res.json(pusher.authorizeChannel(req.body.socket_id, channelName));
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── 404 handler ──────────────────────────────────────────────────────────────
app.get('/404', (req, res) => res.status(404).render('404'));

// Catch-all: unknown routes → 404 page (only for non-API, non-asset requests)

// Communications archive exports (staff UI)
app.get('/communication-exports', (req, res) => {
  res.render('communication-exports', {
    title: 'Communications Archive Exports',
    activeNav: 'settings',
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/portal/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Let static files 404 normally
  if (req.path.match(/\.(js|css|png|jpg|ico|svg|woff|woff2|ttf|map)$/)) return next();
  res.status(404).render('404');
});

// --- Global error handler ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  try {
    const { sendErrorAlert } = require('./services/alerts');
    sendErrorAlert({
      source: `http/${req.method} ${req.path}`,
      error: err,
      context: {
        method: req.method,
        path: req.path,
        firmId: req.firm?.firmId || req.firm?.userId || null,
        portalUserId: req.portalUser?.id || null,
      },
    }).catch(() => {});
  } catch (_) { /* alerts is best-effort */ }
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  // Liveness is available during startup; readiness waits for initialization.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DarkLion server running on port ${PORT}`);
  });

  await initDB();
  console.log('Database initialized');

  if (backgroundJobsEnabled(process.env)) {
    require('./services/subscriptions').startSeatWorker();
    require('./services/summaryJobs').startSummaryWorker();
    // HIDDEN 2026-04-28 — Deprecated auto-book/nightly QBO scan cron disabled.
    // It scanned every company, including blank placeholder realm_id values, creating stale scan_results.
    // startNightlyCron();
    startEmmaBriefingCron();

    const { startEmmaDraftWorker } = require('./services/emmaDraftJobs');
    startEmmaDraftWorker(app);

    const { startDocumentUploadNotificationWorker } = require('./services/documentUploadNotifications');
    startDocumentUploadNotificationWorker(app);

    const { scheduleAt10PM, startBlueleafSync, startStatementReminders, startWeeklyMRRSync, startFirmMetricsRefresh, startBookkeeperScheduler, startBookkeepingQuestionsReminder } = require('./scheduler');
    scheduleAt10PM();
    startBlueleafSync();
    startStatementReminders();
    startWeeklyMRRSync();
    startFirmMetricsRefresh();
    startBookkeeperScheduler();
    // HIDDEN 2026-04-27 — Auto-Bookkeeper BKQ client reminder email cron disabled. Uncomment to re-enable.
    // startBookkeepingQuestionsReminder();
  } else {
    console.log('Background jobs disabled by environment configuration');
  }

  releaseHealth.markReady();
}

start().catch(err => {
  releaseHealth.markFailed();
  console.error('Failed to start:', err);
  try {
    const { sendErrorAlert } = require('./services/alerts');
    sendErrorAlert({ source: 'process/startup', error: err }).catch(() => {});
  } catch (_) { /* alerts is best-effort */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason);
  try {
    const { sendErrorAlert } = require('./services/alerts');
    const err = reason instanceof Error ? reason : new Error(String(reason));
    sendErrorAlert({ source: 'process/unhandledRejection', error: err }).catch(() => {});
  } catch (_) { /* alerts is best-effort */ }
});

process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err);
  try {
    const { sendErrorAlert } = require('./services/alerts');
    sendErrorAlert({ source: 'process/uncaughtException', error: err }).catch(() => {});
  } catch (_) { /* alerts is best-effort */ }
});
