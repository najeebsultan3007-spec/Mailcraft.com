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

// Length config — TIGHTENED
// max_tokens acts as a hard ceiling. Word targets are enforced in prompt.
const LENGTH_CONFIG = {
  auto: {
    maxTokens: 450,
    words: '80-150 words',
    instruction: 'Write the shortest email that covers every key point. No padding. No repetition.',
  },
  short: {
    maxTokens: 150,             // ~50 words hard ceiling → forces brevity
    words: '40-60 words',
    instruction: 'STRICT: 2-3 sentences only. 40-60 words total for the body. No greeting pleasantries. Get straight to the point in sentence one. Every word must carry meaning.',
  },
  medium: {
    maxTokens: 280,             // ~100 words hard ceiling
    words: '90-130 words',
    instruction: 'STRICT: 90-130 words total for the body. 2 short paragraphs maximum. Do NOT write a 3rd paragraph. Do NOT restate points. Cover all key points but say each one only ONCE.',
  },
  detailed: {
    maxTokens: 600,
    words: '220-320 words',
    instruction: 'LENGTH: 220-320 words, 3-4 paragraphs. Each paragraph covers a different point — no repetition across paragraphs.',
  },
};

// Tone guidance
const TONE_GUIDE = {
  Professional: 'Polished and direct. Open with "Hi [Name]," (not "Dear" unless it\'s a very formal cold email). Respectful but not stiff. No pleasantries like "I hope you\'re well." Get to the point in sentence one.',
  Formal:       'Traditional business phrasing. Use "Dear [Name]," and "Sincerely,". Full words, no contractions. Reserved and respectful.',
  Friendly:     'Warm and conversational. Open with "Hi [Name]," or "Hey [Name],". Use contractions (I\'m, you\'re, we\'ll). Sound like you actually like the person.',
  Persuasive:   'Confident and benefit-focused. Lead with the value or result, close with a clear specific ask. No hedging.',
  Casual:       'Relaxed. "Hey [Name]," is the greeting. Short sentences. Contractions everywhere. No corporate phrases.',
  Empathetic:   'Acknowledge the situation or feeling in sentence one. Soft, specific, human. Avoid corporate language entirely.',
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

// GENERATE EMAIL
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
    const lengthCfg = LENGTH_CONFIG[lengthKey] || LENGTH_CONFIG.auto;

    const selectedTone = tone || 'Professional';
    const selectedLang = lang || 'English';
    const toneGuide = TONE_GUIDE[selectedTone] || TONE_GUIDE.Professional;

    // Core system prompt — length emphasized at TOP and BOTTOM
    const systemPrompt = `You are a sharp, experienced professional writing a real business email. You are NOT an AI. You write like an actual human — direct, specific, with personality.

═══════════════════════════════════════════════
LENGTH LIMIT — THIS IS THE MOST IMPORTANT RULE
═══════════════════════════════════════════════
Target: ${lengthCfg.words} for the email body (not counting subject, greeting, or sign-off).

${lengthCfg.instruction}

Before writing, pick your sentences. If a sentence doesn't add new information, delete it. Do NOT exceed the word target — hitting it under is better than over.

═══════════════════════════════════════════════
CORE QUALITY RULES
═══════════════════════════════════════════════
1. CONCISE — no wasted words, no padding, no repeating the same point twice.
2. COMPLETE — cover every key point from the user's brief, but say each thing ONCE.
3. HUMAN — sounds like a real person wrote it on their phone, not like ChatGPT.

═══════════════════════════════════════════════
TONE: ${selectedTone}
═══════════════════════════════════════════════
${toneGuide}

═══════════════════════════════════════════════
LANGUAGE: ${selectedLang}
═══════════════════════════════════════════════
Write the ENTIRE email (subject + body) in ${selectedLang}. Do not mix languages.

═══════════════════════════════════════════════
BANNED AI-SOUNDING PHRASES (never use these)
═══════════════════════════════════════════════
- "I hope this email finds you well"
- "I hope you're doing well" / "I hope all is well"
- "I am writing to you today to…" / "I am writing to introduce…"
- "I wanted to reach out…"
- "I'm reaching out regarding…"
- "Please don't hesitate to…"
- "At your earliest convenience" / "at your convenience"
- "I would like to take this opportunity to…"
- "I would welcome the opportunity to…"
- "Thank you for your time and consideration"
- "Moving forward" / "Going forward"
- "I am thrilled/delighted/excited to…"
- "I trust this message finds you…"
- "Kindly note that…"
- "I am grateful for the opportunity to…"
- "It is my pleasure to…"
- "comprehensive solutions" / "tailored to your needs" / "designed to enhance"

═══════════════════════════════════════════════
BANNED PATTERNS
═══════════════════════════════════════════════
- Rule-of-three lists ("clear, concise, and compelling"). Use ONE adjective.
- Em dashes (—) more than once per email.
- Starting the email with a pleasantry. Start with the actual reason.
- Summary paragraphs that restate what you already said.
- Empty transitions ("With that in mind…", "That said…").
- Wrapping an ask in three layers of politeness.
- Every paragraph starting with "I".

═══════════════════════════════════════════════
HOW TO SOUND HUMAN
═══════════════════════════════════════════════
- Open with the reason. "Quick update on X —" or "Wanted to check on Y."
- Use contractions when tone allows (I'm, don't, we'll, that's).
- Be specific. "Saved your team 40 hours last quarter" > "delivered significant value."
- One clear ask at the end. One line. No ceremony.
- Sign-offs: "Thanks," / "Best," / "Cheers," — avoid "Warm regards" unless Formal tone.

═══════════════════════════════════════════════
FORMAT
═══════════════════════════════════════════════
Line 1: Subject: [subject]
Line 2: (blank)
Line 3+: Greeting, body, sign-off.

Output ONLY the email. No preamble, no markdown, no asterisks, no quotation marks around anything.

═══════════════════════════════════════════════
FINAL CHECK BEFORE OUTPUTTING
═══════════════════════════════════════════════
Count the words in your body. Is it within ${lengthCfg.words}? If over, cut sentences until it fits. Length target is a HARD rule.`;

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: lengthCfg.maxTokens,
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
