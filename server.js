// ══════════════════════════════════════════════════
// MailCraft AI — Backend Server v2
// ══════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ── IN-MEMORY CONFIG (persists until server restart) ──
// In production, store this in a database or env variable
let config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.MODEL || 'claude-sonnet-4-20250514',
  maxTokens: parseInt(process.env.MAX_TOKENS || '1000'),
  rateLimit: parseInt(process.env.RATE_LIMIT || '20'),
  adminPassword: process.env.ADMIN_PASSWORD || 'mailcraft2024', // change this!
};

// ── MIDDLEWARE ──
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public'))); // serves admin panel

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-password'],
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit,
  message: { error: 'Too many requests. Please wait and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin auth middleware
function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.body?.adminPassword;
  if (pwd !== config.adminPassword) {
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  next();
}

// ══════════════════════════════════════════════════
// PUBLIC ROUTES
// ══════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    service: 'MailCraft AI Backend',
    version: '2.0.0',
    status: 'running',
    apiConfigured: !!config.anthropicApiKey,
    endpoints: {
      health: 'GET /health',
      generate: 'POST /api/generate',
      admin: 'GET /admin',
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    apiConfigured: !!config.anthropicApiKey,
    model: config.model,
    timestamp: new Date().toISOString(),
  });
});

// ── GENERATE EMAIL ──
app.post('/api/generate', apiLimiter, async (req, res) => {
  const { prompt, tone, lang, emailType } = req.body;

  if (!config.anthropicApiKey) {
    return res.status(503).json({ error: 'API key not configured. Please set it in the admin panel.' });
  }
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt.' });
  }
  if (prompt.length > 8000) {
    return res.status(400).json({ error: 'Prompt too long.' });
  }

  try {
    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: 'You are an expert professional email writer. Write emails that sound natural, human, and compelling. Always include a Subject line at the top in this exact format: "Subject: [your subject here]". Output ONLY the email content — no explanations, no commentary, no markdown formatting, no asterisks.',
      messages: [{ role: 'user', content: prompt }],
    });

    const email = response.content.map(b => b.text || '').join('');
    console.log(`[${new Date().toISOString()}] ✅ Generated | type=${emailType} tone=${tone} lang=${lang} chars=${email.length}`);

    return res.json({
      success: true,
      email,
      usage: {
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
      }
    });

  } catch (err) {
    console.error('❌ Anthropic error:', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'Invalid API key. Update it in the admin panel.' });
    if (err.status === 429) return res.status(429).json({ error: 'AI service busy. Try again in a moment.' });
    return res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

// ══════════════════════════════════════════════════
// ADMIN ROUTES (password protected)
// ══════════════════════════════════════════════════

// Get current config (masks API key)
app.get('/admin/config', requireAdmin, (req, res) => {
  res.json({
    anthropicApiKey: config.anthropicApiKey ? '***' + config.anthropicApiKey.slice(-6) : '',
    apiKeySet: !!config.anthropicApiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    rateLimit: config.rateLimit,
  });
});

// Update config
app.post('/admin/config', requireAdmin, (req, res) => {
  const { anthropicApiKey, model, maxTokens, rateLimit } = req.body;

  if (anthropicApiKey && typeof anthropicApiKey === 'string' && anthropicApiKey.startsWith('sk-ant-')) {
    config.anthropicApiKey = anthropicApiKey.trim();
  } else if (anthropicApiKey) {
    return res.status(400).json({ error: 'Invalid API key format. Should start with sk-ant-' });
  }

  if (model) config.model = model;
  if (maxTokens && Number.isInteger(maxTokens)) config.maxTokens = Math.min(maxTokens, 4096);
  if (rateLimit && Number.isInteger(rateLimit)) config.rateLimit = Math.min(rateLimit, 100);

  console.log(`[${new Date().toISOString()}] 🔧 Config updated by admin`);
  res.json({ success: true, message: 'Config updated successfully.', apiKeySet: !!config.anthropicApiKey });
});

// Test API key
app.post('/admin/test', requireAdmin, async (req, res) => {
  if (!config.anthropicApiKey) {
    return res.status(400).json({ error: 'No API key configured.' });
  }
  try {
    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: 30,
      messages: [{ role: 'user', content: 'Say "API working" in 3 words.' }],
    });
    const text = response.content[0]?.text || '';
    res.json({ success: true, message: 'API key is valid and working!', response: text });
  } catch (err) {
    res.status(400).json({ success: false, error: 'API key test failed: ' + err.message });
  }
});

// ── Serve Admin Panel ──
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Error handlers ──
app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── START ──
app.listen(PORT, () => {
  console.log(`\n🚀 MailCraft AI Backend v2 running on port ${PORT}`);
  console.log(`   API:          http://localhost:${PORT}/api/generate`);
  console.log(`   Admin Panel:  http://localhost:${PORT}/admin`);
  console.log(`   Health:       http://localhost:${PORT}/health`);
  if (!config.anthropicApiKey) {
    console.warn('\n⚠️  No API key set. Open Admin Panel to add it.\n');
  } else {
    console.log('\n✅  API key loaded from .env\n');
  }
});
