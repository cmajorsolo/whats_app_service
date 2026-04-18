// server.js  — full file, replace your existing one

import express from 'express';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

const app = express();

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  APP_SECRET,
  PHONE_NUMBER_ID,
  ANTHROPIC_API_KEY,
  LAPTOP_WEBHOOK_URL,   // e.g. your ngrok URL: https://xxxx.ngrok.io/job
  PORT = 3000
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Conversation history store (phone number → messages array) ────────────────
const conversations = new Map();

// ── System prompt — the personality and rules for the bot ─────────────────────
const SYSTEM_PROMPT = `You are a friendly AI video creator assistant on WhatsApp.
Your only job is to help users create short pitch/advertising videos for their products.

For any other request, reply exactly: "I can only create videos for you, I can't help with anything else."

When a user wants a video, gather this information through natural conversation:
- Product name and what it does
- Video duration (e.g. 15s, 30s, 60s)
- Target audience
- Key message or call to action
- Tone (e.g. fun, professional, emotional)

Ask one or two questions at a time — keep it conversational, not like a form.

Once you have enough information, output EXACTLY this JSON block and nothing else:
<READY>
{
  "product": "...",
  "duration": "15s",
  "audience": "...",
  "tone": "...",
  "keyMessage": "...",
  "scenes": [
    { "scene": 1, "visual": "...", "text": "...", "duration": 5 },
    { "scene": 2, "visual": "...", "text": "...", "duration": 5 },
    { "scene": 3, "visual": "...", "text": "...", "duration": 5 }
  ]
}
</READY>`;

app.get('/', (req, res) => res.send('OK'));

// ── Verification handshake ────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Signature verification ────────────────────────────────────────────────────
function verifySignature(req, res, buf) {
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(buf)
    .digest('hex');
  if (sig !== expected) res.sendStatus(401);
}
app.use(express.json({ verify: verifySignature }));

// ── Incoming message handler ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // always respond immediately

  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || message.type !== 'text') return;

  const from = message.from;
  const text = message.text.body;

  handleMessage(from, text).catch(console.error);
});

// ── Conversation manager ──────────────────────────────────────────────────────
async function handleMessage(from, userText) {
  // 1. Load or create history for this user
  if (!conversations.has(from)) {
    conversations.set(from, []);
  }
  const history = conversations.get(from);

  // 2. Append the new user message
  history.push({ role: 'user', content: userText });

  // 3. Call Claude with full history
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const assistantText = response.content[0].text;

  // 4. Save assistant reply to history
  history.push({ role: 'assistant', content: assistantText });

  // 5. Check if Claude has enough info and produced a job payload
  const readyMatch = assistantText.match(/<READY>([\s\S]*?)<\/READY>/);

  if (readyMatch) {
    // Claude has all the info — dispatch job to laptop and notify user
    const jobPayload = JSON.parse(readyMatch[1].trim());

    await sendWhatsAppMessage(from, 
      "Great! I have everything I need. Starting to create your video now — I'll send it to you when it's ready!"
    );

    await dispatchJobToLaptop({ ...jobPayload, requester: from });

    // Clear conversation so user can request another video
    conversations.delete(from);

  } else {
    // Still gathering info — send Claude's reply back to the user
    await sendWhatsAppMessage(from, assistantText);
  }
}

// ── Dispatch job to your laptop ───────────────────────────────────────────────
async function dispatchJobToLaptop(job) {
  console.log('Dispatching job:', JSON.stringify(job, null, 2));

  if (!LAPTOP_WEBHOOK_URL) {
    console.warn('LAPTOP_WEBHOOK_URL not set — job logged but not dispatched');
    return;
  }

  await fetch(LAPTOP_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });
}

// ── Send WhatsApp message ─────────────────────────────────────────────────────
async function sendWhatsAppMessage(to, body) {
  await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
}

// Add these before app.listen(...)
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));