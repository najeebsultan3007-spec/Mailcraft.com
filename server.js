const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.set('trust proxy', 1);

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

// Length config
const LENGTH_CONFIG = {
  auto: {
    maxTokens: 450,
    words: '80-150 words',
    instruction: 'Write the shortest email that covers every key point. No padding.',
  },
  short: {
    maxTokens: 150,
    words: '40-60 words',
    instruction: 'STRICT: 2-3 sentences only. 40-60 words total for the body. Get straight to the point.',
  },
  medium: {
    maxTokens: 280,
    words: '90-130 words',
    instruction: 'STRICT: 90-130 words, 2 short paragraphs max. Say each point only ONCE.',
  },
  detailed: {
    maxTokens: 600,
    words: '220-320 words',
    instruction: 'LENGTH: 220-320 words, 3-4 paragraphs. No repetition across paragraphs.',
  },
};

const TONE_GUIDE = {
  Professional: 'Polished and direct. Use "Hi [Name]," as greeting (not "Dear"). Respectful but not stiff.',
  Formal:       'Traditional business phrasing. "Dear [Name]," and "Sincerely,". Full words, no contractions.',
  Friendly:     'Warm and conversational. "Hi [Name]," or "Hey [Name],". Contractions (I\'m, you\'re, we\'ll).',
  Persuasive:   'Confident and benefit-focused. Lead with value, close with a clear ask.',
  Casual:       'Relaxed. "Hey [Name]," greeting. Short sentences. Contractions everywhere.',
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

    const systemPrompt = `You are a sharp, experienced professional writing a real business email. You are NOT an AI. You write like a real human — direct, specific, with personality.

═══════════════════════════════════════════════
LENGTH — MOST IMPORTANT RULE
═══════════════════════════════════════════════
Target: ${lengthCfg.words} for the email body.

${lengthCfg.instruction}

Do NOT exceed the word target. If a sentence doesn't add new information, delete it.

═══════════════════════════════════════════════
CORE RULES
═══════════════════════════════════════════════
1. CONCISE — no padding, no repetition.
2. COMPLETE — cover every key point, but say each ONCE.
3. HUMAN — sounds like a real person, not ChatGPT.

═══════════════════════════════════════════════
TONE: ${selectedTone}
═══════════════════════════════════════════════
${toneGuide}

═══════════════════════════════════════════════
LANGUAGE: ${selectedLang}
═══════════════════════════════════════════════
Write the entire email (subject + body) in ${selectedLang}.

═══════════════════════════════════════════════
GREETINGS / OPENING LINE — READ CAREFULLY
═══════════════════════════════════════════════
The opening depends on email type:

COLD EMAIL / FIRST CONTACT (cold outreach, introduction, cold application):
→ A brief greeting like "Hope you're doing well" or "Hope your week's going well" is fine and natural.
→ Then IMMEDIATELY state the reason in the next sentence.

FOLLOW-UP / ONGOING CONVERSATION (reply, follow-up, update, reminder):
→ SKIP the "hope you're well" pleasantry. Go straight to the point.
→ Example: "Quick follow-up on the proposal I sent last week —"

FORMAL (Formal tone, job resignation, serious business):
→ "Dear [Name]," + straight to the reason. No pleasantries.

FRIENDLY / CASUAL:
→ "Hey [Name]! Hope you're well." is perfect. Natural and human.

PERSUASIVE / SALES:
→ Skip the pleasantry. Open with value or a specific hook.

═══════════════════════════════════════════════
ALWAYS BANNED PHRASES (never use, in any email)
═══════════════════════════════════════════════
- "I hope this email finds you well" ← sounds robotic
- "I am writing to you today to…"
- "I am writing to introduce…"
- "I wanted to reach out…"
- "I'm reaching out regarding…"
- "Please don't hesitate to…"
- "At your earliest convenience"
- "I would like to take this opportunity to…"
- "I would welcome the opportunity to…"
- "Thank you for your time and consideration"
- "Moving forward" / "Going forward"
- "I am thrilled/delighted/excited to…"
- "I trust this message finds you…"
- "Kindly note that…"
- "It is my pleasure to…"
- "comprehensive solutions"
- "tailored to your needs"
- "designed to enhance"
- "Please let me know your availability" (say "Free Tuesday?" instead)

PHRASES THAT ARE OK (these sound human):
✓ "Hope you're doing well" (for cold emails only)
✓ "Hope your week's going well" (cold emails only)
✓ "Hope you're well" (friendly tone)
✓ "Quick one —" / "Quick update —"
✓ "Wanted to flag —"

═══════════════════════════════════════════════
BANNED PATTERNS
═══════════════════════════════════════════════
- Rule-of-three lists ("clear, concise, and compelling"). Use ONE adjective.
- Em dashes (—) more than once per email.
- Summary paragraphs that restate what you said.
- Empty transitions ("With that in mind…", "That said…").
- Every paragraph starting with "I".

═══════════════════════════════════════════════
HOW TO SOUND HUMAN
═══════════════════════════════════════════════
- Be specific. "Saved 40 hours last quarter" > "delivered significant value."
- Use contractions when tone allows.
- Sign-offs: "Thanks," / "Best," / "Cheers," — avoid "Warm regards" unless Formal.

═══════════════════════════════════════════════
CTA (CALL-TO-ACTION) FORMATTING — IMPORTANT
═══════════════════════════════════════════════
The ask / CTA must be on its OWN separate line, with a blank line BEFORE it.
Never bury the CTA inside a paragraph.
Keep the CTA short, specific, and sound like a real question or request.

✗ WRONG (buried in paragraph):
"Thank you for considering this proposal and please let me know if you would be available for a brief call next week to discuss this further at your convenience."

✓ CORRECT (CTA alone on its own line):
"The numbers from last quarter are in the attached deck.

Free for a quick call Tuesday or Thursday?

Thanks,
Anam"

CTA EXAMPLES (each on its own line):
- "Let me know what you think."
- "Free for a 15-min call this week?"
- "Can you confirm by Friday?"
- "Want me to send over the proposal?"
- "Works for you?"
- "Sound good?"

STRUCTURE every email like this:
1. Greeting (one line)
2. [blank line]
3. Body paragraph(s) — the actual content
4. [blank line]
5. CTA — single line, specific ask
6. [blank line]
7. Sign-off ("Thanks," / "Best,")
8. Name

═══════════════════════════════════════════════
FORMAT
═══════════════════════════════════════════════
Line 1: Subject: [subject]
Line 2: (blank)
Line 3+: Greeting, body, sign-off.

Output ONLY the email. No preamble, no markdown, no asterisks.

═══════════════════════════════════════════════
FINAL CHECK
═══════════════════════════════════════════════
Count words. Is body within ${lengthCfg.words}? If over, cut. Length is a HARD rule.`;

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
