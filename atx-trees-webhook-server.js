bash

cat > /mnt/user-data/outputs/atx-trees-webhook-server.js << 'ENDOFFILE'
const express = require("express");
const twilio  = require("twilio");
const app     = express();
app.use(express.json());

const PORT        = process.env.PORT || 3000;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER || "+15127495149";
const OWNER_PHONE = process.env.OWNER_PHONE;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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

async function alertOwner(message) {
  if (!OWNER_PHONE) { console.warn("[Alert] OWNER_PHONE not set."); return; }
  await sendSMS(OWNER_PHONE, `ATX Trees Alert:\n${message}`);
}

const store = { calls: [], consultations: [], followUps: [], smsLog: [] };

// ============================================================
//  VAPI WEBHOOK
// ============================================================
app.post("/vapi/webhook", async (req, res) => {
  const body = req.body;

  // Vapi sends different event formats — handle both
  const type    = body?.message?.type || body?.type;
  const payload = body?.message || body;

  console.log(`[Vapi] ${type}`);

  try {
    switch (type) {
      case "assistant.started":
      case "call-start":
      case "call.started":
        handleCallStart(payload);
        break;

      case "conversation-update":
      case "transcript":
        handleTranscript(payload);
        break;

      case "end-of-call-report":
      case "call-end":
        await handleEndOfCall(payload);
        break;

      case "status-update":
      case "speech-update":
        handleStatusUpdate(payload);
        break;

      case "function-call":
        await handleFunctionCall(payload, res);
        return;

      default:
        console.log(`[Vapi] Unhandled: ${type}`);
    }
  } catch(err) {
    console.error(`[Vapi Error] ${type}:`, err.message);
  }

  res.status(200).json({ received: true });
});


// ============================================================
//  EVENT HANDLERS
// ============================================================

function handleCallStart(payload) {
  const call   = payload?.call || payload;
  const callId = call?.id || payload?.callId || `call_${Date.now()}`;
  const from   = call?.customer?.number || payload?.customer?.number || "Unknown";

  // Don't duplicate
  if (store.calls.find(c => c.id === callId)) return;

  store.calls.push({
    id: callId,
    phone: formatPhone(from),
    name: "Unknown",
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "in-progress",
    duration: null,
    transcript: [],
    summary: null,
    smsReplied: false,
    voicemail: null,
    followUp: null,
    service: null,
    recordingUrl: null,
    sentiment: null,
    escalated: false,
    escalationReason: null,
  });
  console.log(`[Call Start] ${callId} from ${from}`);
}

function handleTranscript(payload) {
  const callId = payload?.call?.id || payload?.callId;
  const call   = store.calls.find(c => c.id === callId);

  // Extract transcript from conversation-update format
  const messages = payload?.conversation || payload?.messages || [];
  if (call && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last?.content) {
      call.transcript.push({ role: last.role, text: last.content, time: new Date().toISOString() });
      // Extract caller name if mentioned
      if (last.role === "user" && last.content.length > 2) {
        call.lastUserMessage = last.content;
      }
    }
  }

  // Also handle simple transcript format
  if (payload?.transcript && call) {
    call.transcript.push({ role: payload.role || "user", text: payload.transcript, time: new Date().toISOString() });
  }
}

async function handleEndOfCall(payload) {
  const callId = payload?.call?.id || payload?.callId;
  let call     = store.calls.find(c => c.id === callId);

  // Create call record if we missed the start event
  if (!call) {
    const from = payload?.call?.customer?.number || "Unknown";
    call = {
      id: callId || `call_${Date.now()}`,
      phone: formatPhone(from),
      name: "Unknown",
      startedAt: payload?.call?.startedAt || new Date().toISOString(),
      transcript: [],
      smsReplied: false,
      voicemail: null,
      followUp: null,
      service: null,
      sentiment: null,
      escalated: false,
    };
    store.calls.push(call);
  }

  // Extract duration
  const startedAt = payload?.call?.startedAt || call.startedAt;
  const endedAt   = payload?.call?.endedAt   || new Date().toISOString();
  const dur = startedAt ? Math.round((new Date(endedAt) - new Date(startedAt)) / 1000) : null;

  call.status       = "completed";
  call.endedAt      = endedAt;
  call.duration     = dur;
  call.summary      = payload?.summary || null;
  call.recordingUrl = payload?.recordingUrl || payload?.call?.recordingUrl || null;

  // Extract transcript from end-of-call report
  if (payload?.transcript) {
    if (typeof payload.transcript === "string") {
      call.voicemail = payload.transcript.slice(0, 600);
    } else if (Array.isArray(payload.transcript)) {
      const userLines = payload.transcript.filter(t => t.role === "user").map(t => t.content || t.text || "").join(" ");
      if (userLines) call.voicemail = userLines.slice(0, 600);
    }
  }

  // Extract caller name from transcript messages
  if (payload?.messages) {
    const userMsgs = payload.messages.filter(m => m.role === "user");
    if (userMsgs.length > 0) call.lastUserMessage = userMsgs[userMsgs.length-1].content;
  }

  // Sentiment detection
  if (call.summary) {
    const low = call.summary.toLowerCase();
    call.sentiment =
      low.match(/frustrated|upset|angry|unhappy|complaint/) ? "negative" :
      low.match(/happy|excited|great|wonderful|loved/)      ? "positive" : "neutral";
  }

  // Auto-send missed call SMS
  if (!call.smsReplied && call.phone !== "Unknown") {
    const body = `Hi! You called ATX Trees (512) 749-5149. Sorry we missed you! Reply here to get a free estimate or schedule a visit. We'll be in touch soon! 🌳`;
    const r = await sendSMS(call.phone, body);
    if (r.success) { call.smsReplied = true; logSMS(call.phone, body, "missed-call", r.sid); }
  }

  console.log(`[End of Call] ${call.phone} | ${dur}s | ${call.sentiment}`);
}

function handleStatusUpdate(payload) {
  const callId = payload?.call?.id || payload?.callId;
  const call   = store.calls.find(c => c.id === callId);
  if (call && payload?.status) call.status = payload.status;
}

async function handleFunctionCall(payload, res) {
  const callId = payload?.call?.id || payload?.callId;
  const fnName = payload?.functionCall?.name;
  const params = payload?.functionCall?.parameters || {};
  const call   = store.calls.find(c => c.id === callId);
  let result   = { success: true };

  if (call) {
    switch (fnName) {
      case "collect_caller_info":
        if (params.name)    call.name    = params.name;
        if (params.phone)   call.phone   = formatPhone(params.phone) || call.phone;
        if (params.service) call.service = params.service;
        if (params.email)   call.email   = params.email;
        break;

      case "schedule_callback":
        store.followUps.push({ id: Date.now(), callId, name: call.name, phone: call.phone, date: params.date, time: params.time, service: call.service, notes: params.notes || "", createdAt: new Date().toISOString() });
        call.followUp = `${params.time} on ${params.date}`;
        const cbBody = `Hi! Your callback with ATX Trees is confirmed for ${params.date} at ${params.time}. We'll call ${call.phone}. Questions? Reply here. (512) 749-5149`;
        const cbR = await sendSMS(call.phone, cbBody);
        if (cbR.success) { call.smsReplied = true; logSMS(call.phone, cbBody, "callback", cbR.sid); }
        break;

      case "book_consultation":
        const con = { id: Date.now(), callId, name: params.name||call.name, phone: params.phone||call.phone, email: params.email||"", services: params.services||(call.service?[call.service]:[]), budget: params.budget||"", date: params.date, time: params.time, address: params.address||"", notes: params.notes||"", status: "new", createdAt: new Date().toISOString() };
        store.consultations.push(con);
        const conBody = `Hi! Consultation confirmed!\nDate: ${con.date} @ ${con.time}\nATX Trees (512) 749-5149`;
        const conR = await sendSMS(con.phone, conBody);
        if (conR.success) { call.smsReplied = true; logSMS(con.phone, conBody, "consultation", conR.sid); }
        await alertOwner(`New consultation!\nName: ${con.name}\nPhone: ${con.phone}\nDate: ${con.date} @ ${con.time}`);
        break;

      case "send_sms_confirmation":
        const toNum  = params.phone || call.phone;
        const smsTxt = params.message || `Hi! Thanks for calling ATX Trees. We'll be in touch shortly. (512) 749-5149`;
        const smsR   = await sendSMS(toNum, smsTxt);
        if (smsR.success) { call.smsReplied = true; logSMS(toNum, smsTxt, "confirmation", smsR.sid); }
        result = { success: smsR.success };
        break;

      case "escalate_to_human":
        call.escalated = true;
        call.escalationReason = params.reason || "Caller requested human";
        await alertOwner(`ESCALATION!\nCaller: ${call.name}\nPhone: ${call.phone}\nReason: ${call.escalationReason}`);
        break;
    }
  }

  res.status(200).json({ result: JSON.stringify(result) });
}


// ============================================================
//  DASHBOARD API
// ============================================================
app.get("/api/calls",         (_, res) => res.json([...store.calls].sort((a,b) => new Date(b.startedAt)-new Date(a.startedAt))));
app.get("/api/calls/:id",     (req, res) => { const c = store.calls.find(c=>c.id===req.params.id); c ? res.json(c) : res.status(404).json({error:"Not found"}); });
app.get("/api/consultations", (_, res) => res.json([...store.consultations].sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt))));
app.get("/api/followups",     (_, res) => res.json([...store.followUps].sort((a,b) => new Date(a.date)-new Date(b.date))));
app.get("/api/smslog",        (_, res) => res.json([...store.smsLog].sort((a,b) => new Date(b.sentAt)-new Date(a.sentAt))));

app.get("/api/stats", (_, res) => {
  const today = new Date().toDateString();
  res.json({
    totalCalls:    store.calls.length,
    todayCalls:    store.calls.filter(c => new Date(c.startedAt).toDateString()===today).length,
    unreplied:     store.calls.filter(c => !c.smsReplied).length,
    escalated:     store.calls.filter(c => c.escalated).length,
    consultations: store.consultations.length,
    followUps:     store.followUps.length,
    smsSent:       store.smsLog.length,
    sentiment: {
      positive: store.calls.filter(c=>c.sentiment==="positive").length,
      neutral:  store.calls.filter(c=>c.sentiment==="neutral").length,
      negative: store.calls.filter(c=>c.sentiment==="negative").length,
    },
  });
});

app.post("/api/calls/:id/sms", async (req, res) => {
  const call = store.calls.find(c=>c.id===req.params.id);
  if (!call) return res.status(404).json({error:"Not found"});
  const body = req.body.message || `Hi! Following up from ATX Trees. Give us a call at (512) 749-5149 or reply here!`;
  const r = await sendSMS(call.phone, body);
  if (r.success) { call.smsReplied = true; logSMS(call.phone, body, "manual", r.sid); }
  res.json(r);
});

app.post("/api/consultations/:id/review", (req, res) => {
  const c = store.consultations.find(x=>x.id===Number(req.params.id));
  if (!c) return res.status(404).json({error:"Not found"});
  c.status = "reviewed";
  res.json({ok:true});
});

app.get("/health", (_, res) => res.json({
  status: "ok",
  uptime: Math.round(process.uptime()),
  calls: store.calls.length,
  twilio: !!process.env.TWILIO_ACCOUNT_SID ? "connected" : "not configured",
  ownerAlerts: OWNER_PHONE || "not set",
  smsSent: store.smsLog.length,
}));


// ============================================================
//  HELPERS
// ============================================================
function logSMS(to, body, type, sid) {
  store.smsLog.push({to, body, type, sid, sentAt: new Date().toISOString()});
}

function formatPhone(raw) {
  if (!raw) return "Unknown";
  const d = raw.replace(/\D/g,"");
  if (d.length===11&&d.startsWith("1")) return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length===10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return raw;
}

app.listen(PORT, () => console.log(`ATX Trees Webhook running on port ${PORT} | Calls: ${store.calls.length}`));
ENDOFFILE
echo "Done"
Output

Done
