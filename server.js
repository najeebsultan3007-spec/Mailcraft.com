const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.set('trust proxy', 1);

// Config
const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.MODEL || 'claude-sonnet-4-20250514',
  maxTokens: parseInt(process.env.MAX_TOKENS || '1000'),
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  jwtSecret: process.env.JWT_SECRET || 'mailcraft_secret_2024',
};

// Supabase client
const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);

// Middleware
app.use(express.json({ limit: '50kb' }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Plan limits
const PLAN_LIMITS = { free: 5, regular: 50, pro: 150, business: 500 };

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token.' });
  }
}

// ── ROUTES ──

app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', apiConfigured: !!config.anthropicApiKey });
});

// SIGNUP
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short.' });

  try {
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
    if (existing) return res.status(400).json({ error: 'Email already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase.from('users').insert([{
      name, email, password: hashedPassword, plan: 'free', emails_used: 0
    }]).select().single();

    if (error) throw error;

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, config.jwtSecret, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan, emails_used: user.emails_used } });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Signup failed. Try again.' });
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  try {
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
    if (error || !user) return res.status(401).json({ error: 'Invalid email or password.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, config.jwtSecret, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan, emails_used: user.emails_used } });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
});

// GET USER
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const { data: user, error } = await supabase.from('users').select('id, name, email, plan, emails_used, created_at').eq('id', req.user.id).single();
    if (error || !user) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get user.' });
  }
});

// GENERATE EMAIL
app.post('/api/generate', authMiddleware, async (req, res) => {
  const { prompt, tone, lang, emailType } = req.body;

  if (!config.anthropicApiKey) return res.status(503).json({ error: 'API key not configured.' });
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing prompt.' });

  try {
    // Check limit
    const { data: user } = await supabase.from('users').select('plan, emails_used').eq('id', req.user.id).single();
    const limit = PLAN_LIMITS[user.plan] || 5;
    if (user.emails_used >= limit) {
      return res.status(403).json({ error: 'Email limit reached. Please upgrade your plan.' });
    }

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: `You are an expert professional email writer. Write emails strictly in the requested tone. The tone requested is: ${tone || 'Professional'}. Always include a Subject line at the top: "Subject: [subject here]". Output ONLY the email — no explanations, no commentary, no markdown, no asterisks.`,
      messages: [{ role: 'user', content: prompt }],
    });

    const email = response.content.map(b => b.text || '').join('');

    // Increment usage
    await supabase.from('users').update({ emails_used: user.emails_used + 1 }).eq('id', req.user.id);

    return res.json({ success: true, email, emails_used: user.emails_used + 1, limit });

  } catch (err) {
    console.error('Generate error:', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'Invalid API key.' });
    if (err.status === 429) return res.status(429).json({ error: 'AI busy. Try again.' });
    return res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MailCraft server running on port ${PORT}`);
});

module.exports = app;
