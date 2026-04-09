const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.set('trust proxy', 1);

const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.MODEL || 'claude-sonnet-4-20250514',
  maxTokens: parseInt(process.env.MAX_TOKENS || '1000'),
};

app.use(express.json({ limit: '50kb' }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', apiConfigured: !!config.anthropicApiKey });
});

app.post('/api/generate', async (req, res) => {
  const { prompt, tone, lang, emailType } = req.body;

  if (!config.anthropicApiKey) {
    return res.status(503).json({ error: 'API key not configured.' });
  }
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt.' });
  }

  try {
    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: `You are an expert professional email writer. Write emails strictly in the requested tone. The tone requested is: ${tone || 'Professional'}. Always include a Subject line at the top: "Subject: [subject here]". Output ONLY the email — no explanations, no commentary, no markdown, no asterisks.`,
      messages: [{ role: 'user', content: prompt }],
    });

    const email = response.content.map(b => b.text || '').join('');
    return res.json({ success: true, email });

  } catch (err) {
    console.error('Anthropic error:', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'Invalid API key.' });
    if (err.status === 429) return res.status(429).json({ error: 'AI service busy. Try again.' });
    return res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));

module.exports = app;
