// ══════════════════════════════════════════════════
// MailCraft AI — Backend Server v2 (Vercel Ready)
// ══════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

let config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.MODEL || 'claude-sonnet-4-20250514',
  maxTokens: parseInt(process.env.MAX_TOKENS || '1000'),
  rateLimit: parseInt(process.env.RATE_LIMIT || '20'),
  adminPassword: process.env.ADMIN_PASSWORD || 'mailcraft2024',
};

// ── MIDDLEWARE ──
app.use(express.json({ limit: '50kb' }));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-password'],
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit,
  message: { error: 'Too many requests. Please wait and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.body?.adminPassword;
  if (pwd !== config.adminPassword) {
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  next();
}

// ── ROUTES ──
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    apiConfigured: !!config.anthropicApiKey,
    model: config.model,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/generate', apiLimiter, async (req, res) => {
  const { prompt, tone, lang, emailType } = req.body;

  if (!config.anthropicApiKey) {
    return res.status(503).json({ error: 'API key not configured.' });
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
      system: 'You are an expert professional email writer. Write emails strictly in the requested tone. TONE RULES: Professional = formal business language, no casual phrases, structured paragraphs. Formal = very traditional, respectful, no contractions. Friendly = warm and conversational. Persuasive = compelling arguments, action-oriented. Casual = relaxed and informal. Empathetic = understanding and caring. Always match the EXACT tone requested. Always include a Subject line at the top: "Subject: [subject here]". Output ONLY the email — no explanations, no commentary, no markdown, no asterisks.',: [{ role: 'user', content: prompt }],
    });

    const email = response.content.map(b => b.text || '').join('');

    return res.json({
      success: true,
      email,
      usage: {
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
      }
    });

  } catch (err) {
    console.error('Anthropic error:', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'Invalid API key.' });
    if (err.status === 429) return res.status(429).json({ error: 'AI service busy. Try again in a moment.' });
    return res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

app.get('/admin/config', requireAdmin, (req, res) => {
  res.json({
    apiKeySet: !!config.anthropicApiKey,
    model: config.model,
    maxTokens: config.maxTokens,
  });
});

app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));

module.exports = app;
