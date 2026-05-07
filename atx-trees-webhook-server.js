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
    const e164   = digits.length === 10 ? "+1" + digits : "+" + digits;
    const msg    = await twilioClient.messages.create({ to: e164, from: FROM_NUMBER, body });
    console.log("[SMS OK] -> " + e164 + " | SID: " + msg.sid);
    return { success: true, sid: msg.sid };
  } catch (err) {
    console.error("[SMS ERR] -> " + to + ": " + err.message);
    return { success: false, error: err.message };
  }
}

async function alertOwner(message) {
  if (!OWNER_PHONE) { console.warn("[Alert] OWNER_PHONE not set."); return; }
  await sendSMS(OWNER_PHONE, "ATX Trees Alert:\n" + message);
}

var store = { calls: [], consultations: [], followUps: [], smsLog: [] };

function logSMS(to, body, type, sid) {
  store.smsLog.push({ to: to, body: body, type: type, sid: sid, sentAt: new Date().toISOString() });
}

function formatPhone(raw) {
  if (!raw) return "Unknown";
  var d = raw.replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") return "(" + d.slice(1,4) + ") " + d.slice(4,7) + "-" + d.slice(7);
  if (d.length === 10) return "(" + d.slice(0,3) + ") " + d.slice(3,6) + "-" + d.slice(6);
  return raw;
}

function first(name) {
  if (!name || name === "Unknown") return "";
  return " " + name.split(" ")[0];
}

// ============================================================
//  VAPI WEBHOOK
// ============================================================
app.post("/vapi/webhook", async function(req, res) {
  var body    = req.body;
  var type    = (body && body.message && body.message.type) || body.type || "";
  var payload = (body && body.message) || body;

  console.log("[Vapi] " + type);

  try {
    if (type === "assistant.started" || type === "call-start" || type === "call.started") {
      handleCallStart(payload);

    } else if (type === "conversation-update" || type === "transcript") {
      handleTranscript(payload);

    } else if (type === "end-of-call-report" || type === "call-end") {
      await handleEndOfCall(payload, res);
      return;

    } else if (type === "function-call") {
      await handleFunctionCall(payload, res);
      return;

    } else if (type === "status-update" || type === "speech-update") {
      handleStatusUpdate(payload);
    }
  } catch(err) {
    console.error("[Vapi Error] " + type + ": " + err.message);
  }

  res.status(200).json({ received: true });
});

function handleCallStart(payload) {
  var call   = payload.call || payload;
  var callId = call.id || payload.callId || ("call_" + Date.now());
  var from   = (call.customer && call.customer.number) || (payload.customer && payload.customer.number) || "Unknown";

  if (store.calls.find(function(c) { return c.id === callId; })) return;

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
  console.log("[Call Start] " + callId + " from " + from);
}

function handleTranscript(payload) {
  var callId = (payload.call && payload.call.id) || payload.callId;
  var call   = store.calls.find(function(c) { return c.id === callId; });
  var messages = payload.conversation || payload.messages || [];

  if (call && messages.length > 0) {
    var last = messages[messages.length - 1];
    if (last && last.content) {
      call.transcript.push({ role: last.role, text: last.content, time: new Date().toISOString() });
    }
  }

  if (payload.transcript && call) {
    call.transcript.push({ role: payload.role || "user", text: payload.transcript, time: new Date().toISOString() });
  }
}

async function handleEndOfCall(payload, res) {
  var callId = (payload.call && payload.call.id) || payload.callId;
  var call   = store.calls.find(function(c) { return c.id === callId; });

  if (!call) {
    var from = (payload.call && payload.call.customer && payload.call.customer.number) || "Unknown";
    call = {
      id: callId || ("call_" + Date.now()),
      phone: formatPhone(from),
      name: "Unknown",
      startedAt: (payload.call && payload.call.startedAt) || new Date().toISOString(),
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

  var startedAt = (payload.call && payload.call.startedAt) || call.startedAt;
  var endedAt   = (payload.call && payload.call.endedAt)   || new Date().toISOString();
  var dur = startedAt ? Math.round((new Date(endedAt) - new Date(startedAt)) / 1000) : null;

  call.status       = "completed";
  call.endedAt      = endedAt;
  call.duration     = dur;
  call.summary      = payload.summary || null;
  call.recordingUrl = payload.recordingUrl || (payload.call && payload.call.recordingUrl) || null;

  if (payload.transcript) {
    if (typeof payload.transcript === "string") {
      call.voicemail = payload.transcript.slice(0, 600);
    } else if (Array.isArray(payload.transcript)) {
      var userLines = payload.transcript
        .filter(function(t) { return t.role === "user"; })
        .map(function(t) { return t.content || t.text || ""; })
        .join(" ");
      if (userLines) call.voicemail = userLines.slice(0, 600);
    }
  }

  if (call.summary) {
    var low = call.summary.toLowerCase();
    if (low.match(/frustrated|upset|angry|unhappy|complaint/)) {
      call.sentiment = "negative";
    } else if (low.match(/happy|excited|great|wonderful|loved/)) {
      call.sentiment = "positive";
    } else {
      call.sentiment = "neutral";
    }
  }

  if (!call.smsReplied && call.phone !== "Unknown") {
    var body = "Hi" + first(call.name) + "! You called ATX Trees (512) 749-5149. Sorry we missed you! Reply here to get a free estimate or schedule a visit. We'll be in touch soon!";
    var r = await sendSMS(call.phone, body);
    if (r.success) { call.smsReplied = true; logSMS(call.phone, body, "missed-call", r.sid); }
  }

  console.log("[End of Call] " + call.phone + " | " + dur + "s | " + call.sentiment);
  res.status(200).json({ received: true });
}

async function handleFunctionCall(payload, res) {
  var callId = (payload.call && payload.call.id) || payload.callId;
  var fnName = payload.functionCall && payload.functionCall.name;
  var params = (payload.functionCall && payload.functionCall.parameters) || {};
  var call   = store.calls.find(function(c) { return c.id === callId; });
  var result = { success: true };

  if (call) {
    if (fnName === "collect_caller_info") {
      if (params.name)    call.name    = params.name;
      if (params.phone)   call.phone   = formatPhone(params.phone) || call.phone;
      if (params.service) call.service = params.service;
      if (params.email)   call.email   = params.email;

    } else if (fnName === "schedule_callback") {
      store.followUps.push({ id: Date.now(), callId: callId, name: call.name, phone: call.phone, date: params.date, time: params.time, service: call.service, notes: params.notes || "", createdAt: new Date().toISOString() });
      call.followUp = params.time + " on " + params.date;
      var cbBody = "Hi" + first(call.name) + "! Your callback with ATX Trees is confirmed for " + params.date + " at " + params.time + ". We will call " + call.phone + ". Questions? Reply here. (512) 749-5149";
      var cbR = await sendSMS(call.phone, cbBody);
      if (cbR.success) { call.smsReplied = true; logSMS(call.phone, cbBody, "callback", cbR.sid); }

    } else if (fnName === "book_consultation") {
      var con = { id: Date.now(), callId: callId, name: params.name || call.name, phone: params.phone || call.phone, email: params.email || "", services: params.services || (call.service ? [call.service] : []), budget: params.budget || "", date: params.date, time: params.time, address: params.address || "", notes: params.notes || "", status: "new", createdAt: new Date().toISOString() };
      store.consultations.push(con);
      var conBody = "Hi" + first(con.name) + "! Consultation confirmed!\nDate: " + con.date + " at " + con.time + "\nATX Trees (512) 749-5149";
      var conR = await sendSMS(con.phone, conBody);
      if (conR.success) { call.smsReplied = true; logSMS(con.phone, conBody, "consultation", conR.sid); }
      await alertOwner("New consultation!\nName: " + con.name + "\nPhone: " + con.phone + "\nDate: " + con.date + " at " + con.time);

    } else if (fnName === "send_sms_confirmation") {
      var toNum  = params.phone || call.phone;
      var smsTxt = params.message || ("Hi" + first(call.name) + "! Thanks for calling ATX Trees. We will be in touch shortly. (512) 749-5149");
      var smsR   = await sendSMS(toNum, smsTxt);
      if (smsR.success) { call.smsReplied = true; logSMS(toNum, smsTxt, "confirmation", smsR.sid); }
      result = { success: smsR.success };

    } else if (fnName === "escalate_to_human") {
      call.escalated        = true;
      call.escalationReason = params.reason || "Caller requested human";
      await alertOwner("ESCALATION!\nCaller: " + call.name + "\nPhone: " + call.phone + "\nReason: " + call.escalationReason);
    }
  }

  res.status(200).json({ result: JSON.stringify(result) });
}

function handleStatusUpdate(payload) {
  var callId = (payload.call && payload.call.id) || payload.callId;
  var call   = store.calls.find(function(c) { return c.id === callId; });
  if (call && payload.status) call.status = payload.status;
}


// ============================================================
//  DASHBOARD API
// ============================================================
app.get("/api/calls", function(_, res) {
  res.json(store.calls.slice().sort(function(a,b) { return new Date(b.startedAt) - new Date(a.startedAt); }));
});

app.get("/api/calls/:id", function(req, res) {
  var c = store.calls.find(function(c) { return c.id === req.params.id; });
  c ? res.json(c) : res.status(404).json({ error: "Not found" });
});

app.get("/api/consultations", function(_, res) {
  res.json(store.consultations.slice().sort(function(a,b) { return new Date(b.createdAt) - new Date(a.createdAt); }));
});

app.get("/api/followups", function(_, res) {
  res.json(store.followUps.slice().sort(function(a,b) { return new Date(a.date) - new Date(b.date); }));
});

app.get("/api/smslog", function(_, res) {
  res.json(store.smsLog.slice().sort(function(a,b) { return new Date(b.sentAt) - new Date(a.sentAt); }));
});

app.get("/api/stats", function(_, res) {
  var today = new Date().toDateString();
  res.json({
    totalCalls:    store.calls.length,
    todayCalls:    store.calls.filter(function(c) { return new Date(c.startedAt).toDateString() === today; }).length,
    unreplied:     store.calls.filter(function(c) { return !c.smsReplied; }).length,
    escalated:     store.calls.filter(function(c) { return c.escalated; }).length,
    consultations: store.consultations.length,
    followUps:     store.followUps.length,
    smsSent:       store.smsLog.length,
    sentiment: {
      positive: store.calls.filter(function(c) { return c.sentiment === "positive"; }).length,
      neutral:  store.calls.filter(function(c) { return c.sentiment === "neutral"; }).length,
      negative: store.calls.filter(function(c) { return c.sentiment === "negative"; }).length,
    },
  });
});

app.post("/api/calls/:id/sms", async function(req, res) {
  var call = store.calls.find(function(c) { return c.id === req.params.id; });
  if (!call) return res.status(404).json({ error: "Not found" });
  var body = req.body.message || ("Hi" + first(call.name) + "! Following up from ATX Trees. Call us at (512) 749-5149 or reply here!");
  var r = await sendSMS(call.phone, body);
  if (r.success) { call.smsReplied = true; logSMS(call.phone, body, "manual", r.sid); }
  res.json(r);
});

app.post("/api/consultations/:id/review", function(req, res) {
  var c = store.consultations.find(function(x) { return x.id === Number(req.params.id); });
  if (!c) return res.status(404).json({ error: "Not found" });
  c.status = "reviewed";
  res.json({ ok: true });
});

app.get("/health", function(_, res) {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    calls: store.calls.length,
    twilio: process.env.TWILIO_ACCOUNT_SID ? "connected" : "not configured",
    ownerAlerts: OWNER_PHONE || "not set",
    smsSent: store.smsLog.length,
  });
});

app.listen(PORT, function() {
  console.log("ATX Trees Webhook running on port " + PORT);
});
