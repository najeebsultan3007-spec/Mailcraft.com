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
    maxTokens: 350,
    words: '60-100 words',
    instruction: 'Write the SHORTEST email that covers the key points. No padding. Skip unnecessary transitions.',
  },
  short: {
    maxTokens: 110,
    words: '30-50 words',
    instruction: 'CRITICAL: 30-50 words MAX for the body. 2-3 sentences ONLY. NO multiple paragraphs. Write it as ONE block, not three separate paragraphs. Get to the point in the FIRST sentence.',
  },
  medium: {
    maxTokens: 220,
    words: '70-110 words',
    instruction: 'STRICT: 70-110 words body. 2 paragraphs MAX (NOT 3). Say each point exactly ONCE.',
  },
  detailed: {
    maxTokens: 500,
    words: '180-260 words',
    instruction: 'LENGTH: 180-260 words, 3 paragraphs MAX. Every paragraph must say something NEW.',
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
  const { prompt, tone, lang, emailType, length, useMyVoice } = req.body;

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

    // ═══════════════════════════════════════════════
    // VOICE INJECTION — Learn My Voice feature
    // ═══════════════════════════════════════════════
    let voiceBlock = '';
    if (useMyVoice) {
      try {
        const { data: voiceProfile } = await supabase
          .from('user_voice_profiles')
          .select('style_profile, style_summary, sample_emails')
          .eq('user_id', req.user.id)
          .eq('is_active', true)
          .single();

        if (voiceProfile && voiceProfile.style_profile) {
          voiceBlock = buildVoicePromptInjection(voiceProfile);
          // Update last_used_at (non-blocking)
          supabase.from('user_voice_profiles')
            .update({ last_used_at: new Date().toISOString() })
            .eq('user_id', req.user.id)
            .then(() => {}, () => {});
        }
      } catch (voiceErr) {
        console.warn('Voice load failed, continuing without:', voiceErr.message);
      }
    }

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
- "comprehensive solutions" / "comprehensive analysis" / "comprehensive" (AVOID this word entirely)
- "tailored to your needs" / "tailored to your requirements"
- "designed to enhance"
- "Please let me know your availability" (say "Free Tuesday?" instead)
- "optimize your current spend" / "optimize your" ← corporate jargon
- "strategic plan restructuring" / "strategic" (AVOID)
- "leverage" ← NEVER use this word
- "synergy" / "synergies"
- "based on your usage patterns" / "based on your needs"
- "holistic approach"
- "value proposition"
- "circle back"
- "touch base"
- "deep dive"
- "recommended tier adjustments"
- "align with" / "aligned"
- "streamline" / "streamlining"
- "robust"
- "seamless" / "seamlessly"
- "cutting-edge" / "state-of-the-art"
- "unlock potential" / "unlock value"
- "end-to-end"
- "best-in-class"

PHRASES THAT ARE OK (these sound human):
✓ "Hope you're doing well" (for cold emails only)
✓ "Hope your week's going well" (cold emails only)
✓ "Hope you're well" (friendly tone)
✓ "Quick one —" / "Quick update —"
✓ "Wanted to flag —"
✓ "Quick thought on X —"
✓ "Noticed X, thought you'd want to know"

═══════════════════════════════════════════════
BANNED PATTERNS
═══════════════════════════════════════════════
- Rule-of-three lists ("clear, concise, and compelling"). Use ONE adjective.
- Em dashes (—) more than once per email.
- Summary paragraphs that restate what you said.
- Empty transitions ("With that in mind…", "That said…").
- Every paragraph starting with "I".
- Using 3+ syllable words when a 1-2 syllable word works (say "use" not "utilize", "help" not "facilitate", "fix" not "remediate", "send" not "transmit")
- Corporate buzzword stacking ("strategic comprehensive optimization")
- Vague numbers without context ("improve by 15-20%" — if specific, say WHY)

═══════════════════════════════════════════════
SOUND LIKE A REAL HUMAN — CRITICAL
═══════════════════════════════════════════════
Real humans write emails like they talk. Short. Punchy. Specific.

✗ AI version: "I've prepared a comprehensive pricing analysis for Google services that could optimize your current spend by 15-20%."

✓ Human version: "Looked at your Google spend — think you can save 15-20% with a few plan tweaks."

✗ AI version: "The analysis shows potential annual savings of $12,000-15,000 through strategic plan restructuring."

✓ Human version: "Rough numbers: $12-15K/year savings."

✗ AI version: "Can we schedule a brief call this week to review the details?"

✓ Human version: "15-min call Tuesday?"

RULE: If a sentence sounds like a consultant wrote it, rewrite it like a human would TEXT it.
RULE: Short words beat long words. "use" > "utilize". "help" > "facilitate". "send" > "forward".
RULE: Specific numbers/names beat vague phrases. "saved 40 hours" > "significant time savings".
RULE: Fragments are OK. Real emails have fragments. "15-min call?" is better than "Can we schedule a call for approximately 15 minutes?"

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
Count words. Is body within ${lengthCfg.words}? If over, cut. Length is a HARD rule.${voiceBlock}`;

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: lengthCfg.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    const email = response.content.map(b => b.text || '').join('');

    // Update usage counter
    await supabase.from('users').update({ emails_used: user.emails_used + 1 }).eq('id', req.user.id);

    // Save to emails history (non-blocking - don't fail generation if save fails)
    try {
      await supabase.from('emails').insert([{
        user_id: req.user.id,
        email_type: emailType || null,
        tone: selectedTone,
        language: selectedLang,
        length_type: lengthKey,
        prompt: prompt.slice(0, 5000), // Cap at 5000 chars
        generated_email: email,
        mode: req.body.mode || 'new'
      }]);
    } catch (saveErr) {
      console.warn('Could not save email to history:', saveErr.message);
    }

    return res.json({ success: true, email, emails_used: user.emails_used + 1, limit });

  } catch (err) {
    console.error('Generate error:', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'Invalid API key.' });
    if (err.status === 429) return res.status(429).json({ error: 'AI busy. Try again.' });
    return res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════
// LEARN MY VOICE — Voice profile endpoints
// ═══════════════════════════════════════════════

// Build the voice injection block appended to system prompt
function buildVoicePromptInjection(profile) {
  const p = profile.style_profile || {};
  const samples = Array.isArray(profile.sample_emails) ? profile.sample_emails.slice(0, 2) : [];

  return `

═══════════════════════════════════════════════
CRITICAL: WRITE IN THE USER'S PERSONAL VOICE
═══════════════════════════════════════════════
This is the HIGHEST priority rule. Match this writing fingerprint exactly.

VOICE SUMMARY: ${profile.style_summary || 'N/A'}

PATTERNS TO MATCH:
- Greeting: ${p.greeting_style || 'natural'}
- Opening: ${p.opening_line_style || 'direct'}
- Sentence length: ${p.avg_sentence_length || 'medium'}
- Formality: ${p.formality_level || 5}/10
- Frequent phrases (use 1-2 naturally): ${(p.common_phrases || []).join(', ') || 'none'}
- Sign-off: ${p.signoff_style || 'Best,'}
- Contractions: ${p.uses_contractions ? 'YES use them' : 'NO, use full words'}
- Emojis: ${p.uses_emojis ? 'OK sparingly' : 'NEVER use emojis'}
- Structure: ${p.structure_preference || 'paragraphs'}
- Quirks: ${p.unique_quirks || 'none'}

REFERENCE SAMPLES (the user's actual past emails — match this voice):
${samples.map((s, i) => `--- Sample ${i + 1} ---\n${String(s).slice(0, 800)}`).join('\n\n')}

The generated email MUST sound like the same person wrote it. If there's a conflict between the tone setting above and the user's voice, PRIORITIZE THE USER'S VOICE.`;
}

// Analyze samples and extract style profile using Claude
async function extractStyleProfile(emails) {
  const joinedEmails = emails
    .map((e, i) => `--- Email ${i + 1} ---\n${String(e).slice(0, 1500)}`)
    .join('\n\n');

  const analysisSystem = `You are a writing style analyst. You extract a person's unique writing fingerprint from their past emails. You return ONLY valid JSON, no markdown, no preamble, no commentary.`;

  const analysisUser = `Analyze these ${emails.length} emails written by ONE person. Extract their unique writing fingerprint.

${joinedEmails}

Return ONLY a JSON object with this exact structure (no markdown fences, no text before or after):
{
  "patterns": {
    "greeting_style": "short description, e.g. 'Hi [name], — casual first-name basis'",
    "opening_line_style": "e.g. 'jumps straight to point, no pleasantries'",
    "avg_sentence_length": "short|medium|long",
    "formality_level": 5,
    "common_phrases": ["phrase 1", "phrase 2", "phrase 3"],
    "signoff_style": "e.g. 'Cheers, [first name]'",
    "uses_contractions": true,
    "uses_emojis": false,
    "structure_preference": "bullet_points|paragraphs|mixed|one_liners",
    "tone_descriptors": ["friendly", "direct"],
    "unique_quirks": "e.g. often starts with 'So,' or ends with 'LMK'"
  },
  "summary": "2-3 sentences describing this person's writing voice in natural language"
}`;

  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await anthropic.messages.create({
    model: config.model,
    max_tokens: 800,
    system: analysisSystem,
    messages: [{ role: 'user', content: analysisUser }],
  });

  const raw = response.content.map(b => b.text || '').join('').trim();
  // Strip code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.patterns || !parsed.summary) throw new Error('Missing fields');
    return parsed;
  } catch (e) {
    console.error('Style profile parse error:', e.message, 'Raw:', raw.slice(0, 300));
    throw new Error('Could not analyze writing style. Try with different email samples.');
  }
}

// POST /api/voice/train — analyze samples and save voice profile
app.post('/api/voice/train', authMiddleware, async (req, res) => {
  if (!config.anthropicApiKey) return res.status(503).json({ error: 'API key not configured.' });

  const { emails } = req.body;

  if (!Array.isArray(emails)) {
    return res.status(400).json({ error: 'Provide an array of email samples.' });
  }

  // Validate: 3-5 emails, each at least 50 words
  const cleaned = emails
    .map(e => String(e || '').trim())
    .filter(e => e.length > 0 && e.split(/\s+/).length >= 50);

  if (cleaned.length < 3) {
    return res.status(400).json({ error: 'Please provide at least 3 emails (each with 50+ words).' });
  }

  const samples = cleaned.slice(0, 5);

  // Rate limit: max 3 retrains per user per day
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from('user_voice_profiles')
      .select('updated_at')
      .eq('user_id', req.user.id)
      .gte('updated_at', oneDayAgo)
      .single();
    // (Simple check — if you want strict 3/day counter, add a separate retrains_today column)
    // For now we just allow retraining freely but log.
    void existing;
  } catch { /* no existing, fine */ }

  try {
    // Extract style profile via Claude
    const profile = await extractStyleProfile(samples);

    // Upsert into user_voice_profiles
    const { data, error } = await supabase
      .from('user_voice_profiles')
      .upsert({
        user_id: req.user.id,
        sample_emails: samples,
        sample_count: samples.length,
        style_profile: profile.patterns,
        style_summary: profile.summary,
        is_active: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' })
      .select('sample_count, style_summary')
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      profile: {
        summary: data.style_summary,
        sample_count: data.sample_count
      }
    });
  } catch (err) {
    console.error('Voice train error:', err.message);
    return res.status(500).json({ error: err.message || 'Voice training failed. Try again.' });
  }
});

// GET /api/voice/status — check if user has trained voice
app.get('/api/voice/status', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_voice_profiles')
      .select('sample_count, style_summary, updated_at, last_used_at')
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return res.json({ success: true, trained: false });
    }

    return res.json({
      success: true,
      trained: true,
      sample_count: data.sample_count,
      summary: data.style_summary,
      updated_at: data.updated_at,
      last_used_at: data.last_used_at
    });
  } catch (err) {
    return res.json({ success: true, trained: false });
  }
});

// DELETE /api/voice — remove user's voice profile
app.delete('/api/voice', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('user_voice_profiles')
      .delete()
      .eq('user_id', req.user.id);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('Voice delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete voice profile.' });
  }
});

// ═══════════════════════════════════════════════
// REVIEWS ENDPOINTS
// ═══════════════════════════════════════════════

// Admin password for moderation (set ADMIN_PASSWORD in Railway env vars)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Simple admin middleware - checks password in header
function adminMiddleware(req, res, next) {
  const pwd = req.headers['x-admin-password'];
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin password not configured on server.' });
  if (!pwd || pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password.' });
  next();
}

// Random avatar color picker
const AVATAR_COLORS = ['#4a9eff','#ff6b47','#a8d030','#9b59b6','#e67e22','#1abc9c','#f39c12','#e74c3c'];
function randomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

// GET /api/reviews — Public: fetch approved reviews only
app.get('/api/reviews', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('id, name, role, rating, text, avatar_color, created_at')
      .eq('approved', true)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) throw error;
    res.json({ success: true, reviews: data || [] });
  } catch (err) {
    console.error('Fetch reviews error:', err.message);
    res.status(500).json({ error: 'Could not load reviews.' });
  }
});

// POST /api/reviews — Authenticated users only: submit a new review
app.post('/api/reviews', authMiddleware, async (req, res) => {
  const { name, role, rating, text } = req.body;

  // Validation
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'Name is required (min 2 characters).' });
  }
  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return res.status(400).json({ error: 'Review text must be at least 10 characters.' });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: 'Review text too long (max 500 characters).' });
  }
  const ratingNum = parseInt(rating);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
  }

  try {
    // Prevent duplicate reviews from same user
    const { data: existing } = await supabase
      .from('reviews')
      .select('id')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ error: 'You have already submitted a review. Thanks!' });
    }

    const cleanName = name.trim().slice(0, 40);
    const cleanRole = (role || '').trim().slice(0, 60) || 'MailCraft user';
    const cleanText = text.trim().slice(0, 500);

    const { data: review, error } = await supabase
      .from('reviews')
      .insert([{
        name: cleanName,
        role: cleanRole,
        rating: ratingNum,
        text: cleanText,
        avatar_color: randomColor(),
        approved: false, // Pending moderation
        user_id: req.user.id
      }])
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Thanks! Your review has been submitted and will appear after a quick review.',
      review: { id: review.id }
    });
  } catch (err) {
    console.error('Submit review error:', err.message);
    res.status(500).json({ error: 'Could not submit review. Please try again.' });
  }
});

// ADMIN: GET /api/admin/reviews — fetch ALL reviews (pending + approved)
app.get('/api/admin/reviews', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, reviews: data || [] });
  } catch (err) {
    console.error('Admin fetch reviews error:', err.message);
    res.status(500).json({ error: 'Could not load reviews.' });
  }
});

// ADMIN: PATCH /api/admin/reviews/:id/approve — approve or unapprove a review
app.patch('/api/admin/reviews/:id/approve', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { approved } = req.body;

  try {
    const { data, error } = await supabase
      .from('reviews')
      .update({ approved: !!approved })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Review not found.' });

    res.json({ success: true, review: data });
  } catch (err) {
    console.error('Approve review error:', err.message);
    res.status(500).json({ error: 'Could not update review.' });
  }
});

// ADMIN: DELETE /api/admin/reviews/:id — delete a review
app.delete('/api/admin/reviews/:id', adminMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('reviews')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: 'Review deleted.' });
  } catch (err) {
    console.error('Delete review error:', err.message);
    res.status(500).json({ error: 'Could not delete review.' });
  }
});

// ═══════════════════════════════════════════════
// END REVIEWS ENDPOINTS
// ═══════════════════════════════════════════════


// ═══════════════════════════════════════════════
// EMAILS HISTORY ENDPOINTS
// ═══════════════════════════════════════════════

// GET /api/emails — user fetches their own email history
app.get('/api/emails', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const { data, error, count } = await supabase
      .from('emails')
      .select('id, email_type, tone, language, length_type, prompt, generated_email, mode, created_at', { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ 
      success: true, 
      emails: data || [],
      total: count || 0,
      limit,
      offset
    });
  } catch (err) {
    console.error('Fetch emails error:', err.message);
    res.status(500).json({ error: 'Could not load email history.' });
  }
});

// GET /api/emails/:id — user fetches a single email in detail
app.get('/api/emails/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('emails')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Email not found.' });
    res.json({ success: true, email: data });
  } catch (err) {
    console.error('Fetch email error:', err.message);
    res.status(500).json({ error: 'Could not load email.' });
  }
});

// DELETE /api/emails/:id — user deletes their own email from history
app.delete('/api/emails/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('emails')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id); // Can only delete own emails

    if (error) throw error;
    res.json({ success: true, message: 'Email deleted.' });
  } catch (err) {
    console.error('Delete email error:', err.message);
    res.status(500).json({ error: 'Could not delete email.' });
  }
});

// DELETE /api/emails — user clears entire history
app.delete('/api/emails', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('emails')
      .delete()
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true, message: 'History cleared.' });
  } catch (err) {
    console.error('Clear history error:', err.message);
    res.status(500).json({ error: 'Could not clear history.' });
  }
});

// ADMIN: GET /api/admin/emails — admin fetches all emails (stats)
app.get('/api/admin/emails', adminMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    const { data, error, count } = await supabase
      .from('emails')
      .select('id, user_id, email_type, tone, language, length_type, mode, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ 
      success: true, 
      emails: data || [],
      total: count || 0
    });
  } catch (err) {
    console.error('Admin fetch emails error:', err.message);
    res.status(500).json({ error: 'Could not load emails.' });
  }
});

// ADMIN: GET /api/admin/stats — overview stats for admin dashboard
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
    const [usersRes, emailsRes, reviewsRes, pendingReviewsRes] = await Promise.all([
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('emails').select('id', { count: 'exact', head: true }),
      supabase.from('reviews').select('id', { count: 'exact', head: true }),
      supabase.from('reviews').select('id', { count: 'exact', head: true }).eq('approved', false)
    ]);

    // Emails in last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count: recentEmails } = await supabase
      .from('emails')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sevenDaysAgo);

    res.json({
      success: true,
      stats: {
        totalUsers: usersRes.count || 0,
        totalEmails: emailsRes.count || 0,
        totalReviews: reviewsRes.count || 0,
        pendingReviews: pendingReviewsRes.count || 0,
        emailsLast7Days: recentEmails || 0
      }
    });
  } catch (err) {
    console.error('Admin stats error:', err.message);
    res.status(500).json({ error: 'Could not load stats.' });
  }
});

// ═══════════════════════════════════════════════
// END EMAILS HISTORY ENDPOINTS
// ═══════════════════════════════════════════════

app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MailCraft server running on port ${PORT}`);
});

module.exports = app;
