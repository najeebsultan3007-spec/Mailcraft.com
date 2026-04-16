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
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  jwtSecret: process.env.JWT_SECRET || 'mailcraft_secret_2024',
};

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);

app.use(express.json({ limit: '50kb' }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const PLAN_LIMITS = { free: 5, regular: 50, pro: 150, business: 500 };

// Length → max_tokens + instruction
const LENGTH_TOKENS = {
  auto:     700,
  short:    250,
  medium:   500,
  detailed: 1000,
};

const LENGTH_INSTRUCTIONS = {
  auto:     'Keep it as short as possible while covering every key point. Do not pad.',
  short:    'STRICT LENGTH: 3–4 sentences only. Under 80 words. Every sentence must carry meaning.',
  medium:   'STRICT LENGTH: 150–220 words, 3 short paragraphs max. No repeating the same point twice in different words.',
  detailed: 'LENGTH: 300–450 words, 4 paragraphs. Still no filler — every sentence earns its place.',
};

// Tone guidance — short and concrete, not lecture-y
const TONE_GUIDE = {
  Professional: 'Polished and direct. Respectful but not stiff. Gets to the point in the first sentence.',
  Formal:       'Traditional business phrasing. Reserved. Full words, no contractions.',
  Friendly:     "Warm and conversational. Use contractions (I'm, you're, we'll). Write like you actually like the recipient.",
  Persuasive:   'Confident and benefit-focused. Open with value, close with a clear ask.',
  Casual:       'Relaxed. Short sentences. Contractions. "Hey" or "Hi" is fine. No corporate phrases.',
  Empathetic:   'Acknowledge the situation or feeling first. Soft, human, specific.',
};

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

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'healthy', apiConfigured: !!config.anthropicApiKey }));

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

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const { data: user, error } = await supabase.from('users').select('id, name, email, plan, emails_used, created_at').eq('id', req.user.id).single();
    if (error || !user) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get user.' });
  }
});

// GENERATE EMAIL — the important route
app.post('/api/generate', authMiddleware, async (req, res) => {
  const { prompt, tone, lang, emailType, length } = req.body;

  if (!config.anthropicApiKey) return res.status(503).json({ error: 'API key not configured.' });
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing prompt.' });

  try {
    const { data: user } = await supabase.from('users').select('plan, emails_used').eq('id', req.user.id).single();
    const limit = PLAN_LIMITS[user.plan] || 5;
    if (user.emails_used >= limit) {
      return res.status(403).json({ error: 'Email limit reached. Please upgrade your plan.' });
    }

    const lengthKey = (length || 'auto').toLowerCase();
    const maxTokens = LENGTH_TOKENS[lengthKey] ?? LENGTH_TOKENS.auto;
    const lengthInstruction = LENGTH_INSTRUCTIONS[lengthKey] ?? LENGTH_INSTRUCTIONS.auto;

    const selectedTone = tone || 'Professional';
    const selectedLang = lang || 'English';
    const toneGuide = TONE_GUIDE[selectedTone] || TONE_GUIDE.Professional;

    // Core system prompt — encodes: concise + complete meaning + human not AI
    const systemPrompt = `You are a sharp, experienced professional writing a real business email. You are NOT an AI. You write the way actual people write — direct, human, with personality.

═══════════════════════════════════════════════
CORE RULE (this is everything)
═══════════════════════════════════════════════
Every email you write must be:
1. CONCISE — no wasted words, no padding, no repeating the same point twice.
2. COMPLETE — every key point from the user's brief must be covered. Short does NOT mean skipping information.
3. HUMAN — sounds like a real person wrote it on their phone between meetings, not like ChatGPT wrote it.

If you can remove a sentence without losing meaning, remove it. If you can say something in 8 words instead of 20, use 8.

═══════════════════════════════════════════════
TONE: ${selectedTone}
═══════════════════════════════════════════════
${toneGuide}

═══════════════════════════════════════════════
LANGUAGE: ${selectedLang}
═══════════════════════════════════════════════
Write the ENTIRE email (subject + body) in ${selectedLang}. Do not mix languages.

═══════════════════════════════════════════════
LENGTH
═══════════════════════════════════════════════
${lengthInstruction}

═══════════════════════════════════════════════
BANNED AI-SOUNDING PHRASES (never use these)
═══════════════════════════════════════════════
- "I hope this email finds you well"
- "I hope you're doing well" / "I hope all is well"
- "I am writing to you today to…"
- "I wanted to reach out…"
- "I'm reaching out regarding…"
- "Please don't hesitate to…"
- "At your earliest convenience"
- "I would like to take this opportunity to…"
- "Thank you for your time and consideration"
- "Moving forward" / "Going forward"
- "I am thrilled/delighted/excited to…"
- "I trust this message finds you…"
- "Kindly note that…"
- "I am grateful for the opportunity to…"
- "It is my pleasure to…"

═══════════════════════════════════════════════
BANNED AI-SOUNDING PATTERNS
═══════════════════════════════════════════════
- Rule-of-three lists ("clear, concise, and compelling" / "proven, trusted, and effective") — use ONE strong adjective instead.
- Overuse of em dashes (—). Use at most one per email.
- Perfectly symmetric, balanced paragraphs. Real people write uneven paragraphs.
- Starting every paragraph with "I". Vary openings.
- Summary paragraphs that restate what you just said.
- Empty transitions ("With that in mind…", "That said…").
- Wrapping a simple ask in three layers of politeness.

═══════════════════════════════════════════════
HOW TO SOUND HUMAN
═══════════════════════════════════════════════
- Open with the actual reason, not a pleasantry. Example: "Quick update on the Q3 deck —" or "Wanted to flag something about next month's rate."
- Use contractions when the tone allows (I'm, don't, we'll, that's).
- Vary sentence length. Mix short punchy sentences with longer ones.
- Be specific. "Your team saved 40 hours last quarter" beats "I have delivered significant value."
- End with a clear, simple ask. One line. No ceremony.
- Sign-offs: "Thanks," "Best," "Cheers," or just your name. Avoid "Warm regards" or "Yours sincerely" unless tone is Formal.

═══════════════════════════════════════════════
FORMAT
═══════════════════════════════════════════════
Line 1: Subject: [subject here]
Line 2: (blank)
Line 3+: The email body.

Output ONLY the email. No explanations, no markdown, no asterisks, no quotation marks, no "Here is your email:" preamble.`;

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    const email = response.content.map(b => b.text || '').join('');

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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MailCraft server running on port ${PORT}`);
});

module.exports = app;
