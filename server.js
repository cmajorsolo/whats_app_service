// server.js
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,       // you make this up — must match what you enter in Meta dashboard
  WHATSAPP_TOKEN,     // from Meta Business API (Bearer token)
  APP_SECRET,         // from Meta app settings — used to verify signatures
  PORT = 3000
} = process.env;

// ── 1. Verification handshake (one-time, during Meta dashboard setup) ──────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge); // echo back the challenge
  } else {
    res.sendStatus(403);
  }
});

// ── 2. Signature verification middleware ───────────────────────────────────────
function verifySignature(req, res, buf) {
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return; // let the route handler reject it
  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(buf)
    .digest('hex');
  if (sig !== expected) res.sendStatus(401);
}
app.use(express.json({ verify: verifySignature }));

// ── 3. Incoming message handler ────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately — Meta will retry if you don't
  res.sendStatus(200);

  const entry   = req.body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value   = changes?.value;
  const message = value?.messages?.[0];

  if (!message) return; // not a message event (e.g. status update)

  const from = message.from;       // sender's phone number
  const text = message.text?.body; // message text

  console.log(`Message from ${from}: ${text}`);

  // Hand off to your async conversation handler — don't await here
  handleMessage(from, text).catch(console.error);
});

// ── 4. Async conversation logic (this is where Claude goes later) ──────────────
async function handleMessage(from, text) {
  // For now, just echo back
  await sendWhatsAppMessage(from, `You said: "${text}"`);
}

// ── 5. Send a message back via WhatsApp API ────────────────────────────────────
async function sendWhatsAppMessage(to, body) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID; // from Meta dashboard

  await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
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

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));