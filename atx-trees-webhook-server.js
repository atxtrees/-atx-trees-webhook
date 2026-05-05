// ============================================================
//  ATX Trees — Vapi Webhook Backend
//  Stack: Node.js + Express + Twilio
//  Deploy to: Railway, Render, or Fly.io (all free tiers)
//
//  Required environment variables (set in Railway/Render dashboard):
//    TWILIO_ACCOUNT_SID   — from twilio.com/console
//    TWILIO_AUTH_TOKEN    — from twilio.com/console
//    TWILIO_PHONE_NUMBER  — your Twilio number e.g. +15127495149
//    OWNER_PHONE          — your personal cell for alerts e.g. +15121234567
//    PORT                 — 3000
// ============================================================

const express = require("express");
const twilio  = require("twilio");
const app     = express();
app.use(express.json());

const PORT        = process.env.PORT || 3000;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER || "+15127495149";
const OWNER_PHONE = process.env.OWNER_PHONE;

// ── Twilio client ──────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Send a real SMS via Twilio ─────────────────────────────
async function sendSMS(to, body) {
  try {
    const digits = to.replace(/\D/g, "");
    const e164   = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    const msg    = await twilioClient.messages.create({ to: e164, from: FROM_NUMBER, body });
    console.log(`[SMS OK] -> ${e164} | SID: ${msg.sid}`);
    return { success: true, sid: msg.sid };
  } catch (err) {
    console.error(`[SMS ERR] -> ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ── Alert owner via SMS (escalations + new consultations) ──
async function alertOwner(message) {
  if (!OWNER_PHONE) { console.warn("[Alert] OWNER_PHONE not set."); return; }
  await sendSMS(OWNER_PHONE, `ATX Trees Alert:\n${message}`);
}

// ── In-memory store ─────────────────────────────────────────
const store = { calls: [], consultations: [], followUps: [], smsLog: [] };


// ============================================================
//  VAPI WEBHOOK
// ============================================================
app.post("/vapi/webhook", async (req, res) => {
  const type = req.body?.message?.type;
  console.log(`[Vapi] ${type}`);

  if (type === "function-call") {
    await handleFunctionCall(req.body, res);
    return; // response handled inside
  }

  switch (type) {
    case "call-start":         handleCallStart(req.body);       break;
    case "transcript":         handleTranscript(req.body);      break;
    case "end-of-call-report": await handleEndOfCall(req.body); break;
    case "status-update":      handleStatusUpdate(req.body);    break;
  }

  res.status(200).json({ received: true });
});


// ============================================================
//  EVENT HANDLERS
// ============================================================

function handleCallStart(event) {
  const call   = event?.message?.call;
  const callId = call?.id;
  const from   = call?.customer?.number || "Unknown";
  store.calls.push({
    id: callId, phone: formatPhone(from), name: "Unknown",
    startedAt: new Date().toISOString(), endedAt: null,
    status: "in-progress", duration: null, transcript: [],
    summary: null, smsReplied: false, voicemail: null,
    followUp: null, service: null, recordingUrl: null,
    sentiment: null, escalated: false, escalationReason: null,
  });
  console.log(`[Call Start] ${callId} from ${from}`);
}

function handleTranscript(event) {
  const msg  = event?.message;
  const call = store.calls.find(c => c.id === msg?.call?.id);
  if (call && msg?.transcript) {
    call.transcript.push({ role: msg.role, text: msg.transcript, time: new Date().toISOString() });
  }
}

async function handleFunctionCall(event, res) {
  const msg    = event?.message;
  const callId = msg?.call?.id;
  const fnName = msg?.functionCall?.name;
  const params = msg?.functionCall?.parameters || {};
  const call   = store.calls.find(c => c.id === callId);
  let result   = { success: true };

  if (call) {
    switch (fnName) {

      case "collect_caller_info":
        if (params.name)    call.name    = params.name;
        if (params.phone)   call.phone   = formatPhone(params.phone) || call.phone;
        if (params.service) call.service = params.service;
        if (params.email)   call.email   = params.email;
        result = { success: true };
        break;

      case "schedule_callback":
        store.followUps.push({
          id: Date.now(), callId, name: call.name, phone: call.phone,
          date: params.date, time: params.time, service: call.service,
          notes: params.notes || "", createdAt: new Date().toISOString(),
        });
        call.followUp = `${params.time} on ${params.date}`;

        // SMS confirmation to caller
        const cbBody = `Hi${first(call.name)}! Your callback with ATX Trees is confirmed for ${params.date} at ${params.time}. We'll call ${call.phone}. Questions? Reply here. (512) 749-5149`;
        const cbR = await sendSMS(call.phone, cbBody);
        if (cbR.success) { call.smsReplied = true; logSMS(call.phone, cbBody, "callback", cbR.sid); }
        result = { success: true, message: "Follow-up scheduled and confirmation texted." };
        break;

      case "book_consultation":
        const con = {
          id: Date.now(), callId,
          name:     params.name     || call.name,
          phone:    params.phone    || call.phone,
          email:    params.email    || call.email || "",
          services: params.services || (call.service ? [call.service] : []),
          budget:   params.budget   || "",
          date:     params.date,
          time:     params.time,
          address:  params.address  || "",
          notes:    params.notes    || "",
          status:   "new",
          createdAt: new Date().toISOString(),
        };
        store.consultations.push(con);

        // SMS to caller
        const conBody = `Hi${first(con.name)}! Consultation confirmed!\nDate: ${con.date} @ ${con.time}\nAddress: ${con.address || "TBD"}\nATX Trees (512) 749-5149`;
        const conR = await sendSMS(con.phone, conBody);
        if (conR.success) { call.smsReplied = true; logSMS(con.phone, conBody, "consultation", conR.sid); }

        // Alert owner
        await alertOwner(`New consultation!\nName: ${con.name}\nPhone: ${con.phone}\nDate: ${con.date} @ ${con.time}\nService: ${con.services.join(", ")}`);
        result = { success: true, message: "Consultation booked and confirmation sent." };
        break;

      case "send_sms_confirmation":
        const toNum  = params.phone || call.phone;
        const smsTxt = params.message || `Hi${first(call.name)}! Thanks for calling ATX Trees. We'll be in touch shortly. (512) 749-5149`;
        const smsR   = await sendSMS(toNum, smsTxt);
        if (smsR.success) { call.smsReplied = true; logSMS(toNum, smsTxt, "confirmation", smsR.sid); }
        result = { success: smsR.success };
        break;

      case "escalate_to_human":
        call.escalated        = true;
        call.escalationReason = params.reason || "Caller requested human";
        const urgency         = params.urgency || "medium";
        await alertOwner(`${urgency.toUpperCase()} ESCALATION\nCaller: ${call.name}\nPhone: ${call.phone}\nReason: ${call.escalationReason}`);
        result = { success: true, message: "Escalated. Our team will call you right back." };
        break;
    }
  }

  res.status(200).json({ result: JSON.stringify(result) });
}

async function handleEndOfCall(event) {
  const msg    = event?.message;
  const call   = store.calls.find(c => c.id === msg?.call?.id);
  if (!call) return;

  const dur = msg?.call?.endedAt && msg?.call?.startedAt
    ? Math.round((new Date(msg.call.endedAt) - new Date(msg.call.startedAt)) / 1000)
    : null;

  call.status       = "completed";
  call.endedAt      = msg?.call?.endedAt || new Date().toISOString();
  call.duration     = dur;
  call.summary      = msg?.summary || null;
  call.recordingUrl = msg?.recordingUrl || null;
  if (msg?.transcript && !call.voicemail) call.voicemail = msg.transcript.slice(0, 600);

  if (call.summary) {
    const low = call.summary.toLowerCase();
    call.sentiment =
      low.match(/frustrated|upset|angry|unhappy|complaint/) ? "negative" :
      low.match(/happy|excited|great|wonderful|loved/)      ? "positive" : "neutral";
  }

  // Auto-send missed call SMS if nothing was sent during the call
  if (!call.smsReplied && call.phone !== "Unknown") {
    const body = `Hi${first(call.name)}! You called ATX Trees (512) 749-5149. Sorry we missed you! Reply here to get a free estimate or schedule a visit. We'll be in touch soon!`;
    const r = await sendSMS(call.phone, body);
    if (r.success) { call.smsReplied = true; logSMS(call.phone, body, "missed-call", r.sid); }
  }

  console.log(`[End of Call] ${call.name} | ${dur}s | sentiment: ${call.sentiment}`);
}

function handleStatusUpdate(event) {
  const msg  = event?.message;
  const call = store.calls.find(c => c.id === msg?.call?.id);
  if (call) call.status = msg?.status;
}


// ============================================================
//  DASHBOARD API
// ============================================================

app.get("/api/calls",         (_, res) => res.json([...store.calls].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))));
app.get("/api/calls/:id",     (req, res) => { const c = store.calls.find(c => c.id === req.params.id); c ? res.json(c) : res.status(404).json({ error: "Not found" }); });
app.get("/api/consultations", (_, res) => res.json([...store.consultations].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))));
app.get("/api/followups",     (_, res) => res.json([...store.followUps].sort((a, b) => new Date(a.date) - new Date(b.date))));
app.get("/api/smslog",        (_, res) => res.json([...store.smsLog].sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))));

app.get("/api/stats", (_, res) => {
  const today = new Date().toDateString();
  res.json({
    totalCalls:    store.calls.length,
    todayCalls:    store.calls.filter(c => new Date(c.startedAt).toDateString() === today).length,
    unreplied:     store.calls.filter(c => !c.smsReplied).length,
    escalated:     store.calls.filter(c => c.escalated).length,
    consultations: store.consultations.length,
    followUps:     store.followUps.length,
    smsSent:       store.smsLog.length,
    sentiment: {
      positive: store.calls.filter(c => c.sentiment === "positive").length,
      neutral:  store.calls.filter(c => c.sentiment === "neutral").length,
      negative: store.calls.filter(c => c.sentiment === "negative").length,
    },
  });
});

// Manual SMS from dashboard
app.post("/api/calls/:id/sms", async (req, res) => {
  const call = store.calls.find(c => c.id === req.params.id);
  if (!call) return res.status(404).json({ error: "Not found" });
  const body = req.body.message || `Hi${first(call.name)}! Following up from ATX Trees. Give us a call at (512) 749-5149 or reply here. We'd love to help!`;
  const r = await sendSMS(call.phone, body);
  if (r.success) { call.smsReplied = true; logSMS(call.phone, body, "manual", r.sid); }
  res.json(r);
});

// Mark consultation reviewed
app.post("/api/consultations/:id/review", (req, res) => {
  const c = store.consultations.find(x => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Not found" });
  c.status = "reviewed";
  res.json({ ok: true });
});

app.get("/health", (_, res) => res.json({
  status: "ok",
  uptime: Math.round(process.uptime()),
  twilio: !!process.env.TWILIO_ACCOUNT_SID ? "connected" : "not configured",
  ownerAlerts: !!OWNER_PHONE ? OWNER_PHONE : "not set",
  smsSent: store.smsLog.length,
}));


// ============================================================
//  HELPERS
// ============================================================

function logSMS(to, body, type, sid) {
  store.smsLog.push({ to, body, type, sid, sentAt: new Date().toISOString() });
}

function first(name) {
  if (!name || name === "Unknown") return "";
  return ` ${name.split(" ")[0]}`;
}

function formatPhone(raw) {
  if (!raw) return "Unknown";
  const d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return raw;
}


// ============================================================
//  START
// ============================================================
app.listen(PORT, () => {
  console.log(`
+------------------------------------------+
|   ATX Trees Webhook + SMS Backend        |
|   Port: ${PORT}                             |
|                                          |
|   POST /vapi/webhook  <- Vapi events     |
|   GET  /api/calls     <- Call history    |
|   GET  /api/stats     <- Dashboard       |
|   GET  /api/smslog    <- SMS history     |
|   GET  /health        <- Health check    |
|                                          |
|   Twilio: ${process.env.TWILIO_ACCOUNT_SID ? "CONNECTED" : "NOT CONFIGURED"}                  |
|   Alerts: ${process.env.OWNER_PHONE    ? "ON -> " + process.env.OWNER_PHONE : "NOT SET"}    |
+------------------------------------------+
  `);
});
