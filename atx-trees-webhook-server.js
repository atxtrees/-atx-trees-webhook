const express = require("express");
const https   = require("https");
const app     = express();
app.use(express.json());

// ── CORS ──
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT         = process.env.PORT || 3000;
const SENDGRID_KEY = process.env.SENDGRID_KEY || '';
const GROK_EMAIL   = 'atxtrees@outlook.com';

// ── EMAIL TO GROK (Outlook) ──
function emailGrok(call) {
  if (!SENDGRID_KEY) { console.log('[Email] No SendGrid key'); return; }
  const urgent = call.lead_score === 'urgent';
  const subject = `${urgent ? '🚨 URGENT - ' : ''}Terra Call: ${call.name || 'Unknown'} | ${call.phone || 'No phone'} | ${call.call_type || 'general'}`;

  const transcriptHtml = (call.transcript || []).map(m => {
    const who = (m.role === 'assistant') ? 'Terra' : 'Caller';
    return `<tr><td style="padding:4px 8px;color:${who==='Terra'?'#2d5a2d':'#1a1a6e'};font-weight:600;white-space:nowrap">${who}</td><td style="padding:4px 8px">${m.content||''}</td></tr>`;
  }).join('');

  const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#1e3a1e;padding:16px 20px;border-radius:10px 10px 0 0">
    <h2 style="color:#d4a855;margin:0;font-size:20px">🌳 ATX Trees — Terra Call Report</h2>
  </div>
  <div style="background:#f9f9f9;padding:16px 20px;border:1px solid #ddd">
    ${urgent ? '<div style="background:#fdf0ef;border:2px solid #c0392b;border-radius:8px;padding:10px;margin-bottom:14px;color:#c0392b;font-weight:bold">🚨 URGENT — Warranty or upset caller. Follow up immediately.</div>' : ''}
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
      <tr><td style="padding:6px 0;color:#666;width:130px">Name</td><td style="padding:6px 0"><strong>${call.name || 'Unknown'}</strong></td></tr>
      <tr><td style="padding:6px 0;color:#666">Phone</td><td style="padding:6px 0"><strong>${call.phone || 'Not captured'}</strong></td></tr>
      <tr><td style="padding:6px 0;color:#666">Call Type</td><td style="padding:6px 0">${call.call_type || 'General'}</td></tr>
      <tr><td style="padding:6px 0;color:#666">Lead Score</td><td style="padding:6px 0">${call.lead_score || 'warm'}</td></tr>
      <tr><td style="padding:6px 0;color:#666">Duration</td><td style="padding:6px 0">${call.duration || 0}s</td></tr>
      <tr><td style="padding:6px 0;color:#666">Time</td><td style="padding:6px 0">${new Date().toLocaleString('en-US', {timeZone:'America/Chicago'})}</td></tr>
    </table>
    ${call.summary ? `<div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:16px"><strong>Summary:</strong><br>${call.summary}</div>` : ''}
    ${transcriptHtml ? `<div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px"><strong>Transcript:</strong><br><table style="width:100%">${transcriptHtml}</table></div>` : ''}
  </div>
  <div style="background:#1e3a1e;padding:10px 20px;border-radius:0 0 10px 10px;text-align:center">
    <span style="color:rgba(255,255,255,0.5);font-size:12px">ATX Trees · Terra AI · atxtrees.com</span>
  </div>
</div>`;

  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: GROK_EMAIL }] }],
    from: { email: 'albert@atxtrees.com', name: 'Terra - ATX Trees' },
    subject,
    content: [{ type: 'text/html', value: html }]
  });

  const req = https.request({
    hostname: 'api.sendgrid.com', port: 443,
    path: '/v3/mail/send', method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + SENDGRID_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, (res) => { console.log(`[Email → Grok] ${res.statusCode}`); });
  req.on('error', e => console.error('[Email Error]', e.message));
  req.write(payload);
  req.end();
}
const SUPABASE_URL = process.env.SUPABASE_URL || "https://jypqdtbyaeaelqenmtzj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp5cHFkdGJ5YWVhZWxxZW5tdHpqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjUyOTEwMSwiZXhwIjoyMTAyMTA1MTAxfQ.FGd8sAJGIkxCM7-1kTsZrI9C6HbbaQtZ1G29mLDMfP0";

// ── SUPABASE HELPER ──
function dbWrite(table, data, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const path = `/rest/v1/${table}${params ? '?' + params : ''}`;
    const options = {
      hostname: SUPABASE_URL.replace('https://', ''),
      port: 443,
      path,
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Prefer': 'return=minimal'
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log(`[DB] ${table} write → ${res.statusCode}`);
        resolve(res.statusCode);
      });
    });
    req.on('error', (e) => { console.error('[DB Error]', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

function dbPatch(table, id, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: SUPABASE_URL.replace('https://', ''),
      port: 443,
      path: `/rest/v1/${table}?id=eq.${id}`,
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Prefer': 'return=minimal'
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log(`[DB Patch] ${table} id=${id} → ${res.statusCode} body=${d.slice(0,200)}`);
        resolve(res.statusCode);
      });
    });
    req.on('error', (e) => { console.error('[DB Patch Error]', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

function dbGet(table, params) {
  return new Promise((resolve) => {
    const options = {
      hostname: SUPABASE_URL.replace('https://', ''),
      port: 443,
      path: `/rest/v1/${table}?${params || 'order=created_at.desc&limit=200'}`,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

function formatPhone(raw) {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return raw;
}

// ── IN-MEMORY CALL BUFFER (for active calls) ──
const activeCalls = {};

// ── VAPI WEBHOOK ──
app.post("/vapi/webhook", async function(req, res) {
  const body    = req.body;
  const type    = (body?.message?.type) || body?.type || '';
  const payload = body?.message || body;

  console.log(`[Vapi] ${type}`);

  try {
    // ── CALL START ──
    if (type === 'call-start' || type === 'assistant.started' || type === 'call.started') {
      const call   = payload.call || payload;
      const callId = call.id || payload.callId || ('call_' + Date.now());
      const from   = call?.customer?.number || payload?.customer?.number || '';

      activeCalls[callId] = {
        id:          callId,
        phone:       formatPhone(from),
        name:        '',
        started_at:  new Date().toISOString(),
        transcript:  [],
        call_type:   '',
        lead_score:  'warm',
        summary:     '',
        duration:    0
      };

      // Create row in Supabase immediately
      await dbWrite('calls', {
        id:         callId,
        phone:      formatPhone(from),
        started_at: activeCalls[callId].started_at,
        status:     'in-progress'
      }, 'on_conflict=id');

      console.log(`[Call Start] ${callId} from ${from}`);

    // ── TRANSCRIPT UPDATE ──
    } else if (type === 'conversation-update' || type === 'transcript') {
      const callId = payload?.call?.id || payload?.callId;
      const call   = activeCalls[callId];
      if (call) {
        // Vapi sends full conversation array each time — replace, don't append
        const messages = payload.conversation || payload.messages || [];
        if (messages.length > 0) {
          call.transcript = messages
            .filter(m => m.content || m.text)
            .map(m => ({ role: m.role, content: m.content || m.text || '' }));
        }
        // Single transcript line
        if (payload.transcript && payload.role) {
          const exists = call.transcript.find(t => t.content === payload.transcript);
          if (!exists) call.transcript.push({ role: payload.role, content: payload.transcript });
        }
      }

    // ── FUNCTION CALL (collect caller info) ──
    } else if (type === 'function-call') {
      const callId = payload?.call?.id || payload?.callId;
      const call   = activeCalls[callId];
      const fnName = payload?.functionCall?.name;
      const params = payload?.functionCall?.parameters || {};

      if (call) {
        if (fnName === 'collect_caller_info') {
          if (params.name)    call.name     = params.name;
          if (params.phone)   call.phone    = formatPhone(params.phone) || call.phone;
          if (params.service) call.call_type = params.service;
        }
        if (fnName === 'escalate_to_human' || fnName === 'callAlbert') {
          call.call_type  = 'warranty';
          call.lead_score = 'urgent';
        }
      }

      res.status(200).json({ result: JSON.stringify({ success: true }) });
      return;

    // ── END OF CALL ──
    } else if (type === 'end-of-call-report' || type === 'call-end') {
      // Log the full payload so we can see exactly what Vapi sends
      console.log('[EOC RAW]', JSON.stringify(payload).slice(0, 2000));
      const eocCallId = payload?.call?.id || payload?.callId || payload?.id;
      console.log('[EOC ID]', eocCallId, '| active keys:', Object.keys(activeCalls));
      const callId   = payload?.call?.id || payload?.callId || payload?.id;
      const call     = activeCalls[callId] || {};
      const startedAt = payload?.call?.startedAt || payload?.startedAt || call.started_at || new Date().toISOString();
      const endedAt   = payload?.call?.endedAt   || payload?.endedAt   || new Date().toISOString();
      const duration  = payload?.call?.duration  || payload?.duration  || Math.round((new Date(endedAt) - new Date(startedAt)) / 1000);
      const rawPhone  = payload?.call?.customer?.number || payload?.customer?.number || call.phone || '';
      const phone     = call.phone || formatPhone(rawPhone);
      // Vapi puts summary in analysis.summary or artifact.summary
      const summary = payload.summary || payload.analysis?.summary || payload.artifact?.summary || '';

      // Vapi puts transcript in artifact.messages
      let transcript = call.transcript || [];
      if (payload.artifact?.messages && Array.isArray(payload.artifact.messages)) {
        transcript = payload.artifact.messages
          .filter(m => m.role !== 'system' && (m.message || m.content))
          .map(m => ({ role: m.role, content: m.message || m.content || '' }));
      } else if (payload.transcript && Array.isArray(payload.transcript)) {
        transcript = payload.transcript.map(t => ({ role: t.role, content: t.content || t.text || '' }));
      } else if (payload.messages && Array.isArray(payload.messages)) {
        transcript = payload.messages.filter(m => m.role !== 'system').map(t => ({ role: t.role, content: t.content || t.message || '' }));
      }
      // Log what we got for debugging
      console.log(`[Transcript] ${transcript.length} lines from end-of-call`);

      // Extract caller name from summary or transcript
      let name = call.name || '';
      if (!name) {
        const searchText = summary + ' ' + transcript.map(t => t.content).join(' ');
        const m = searchText.match(/(?:my name is|i'm|i am|this is)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i);
        if (m) name = m[1];
      }

      // Detect call type from summary + transcript text
      let callType = call.call_type || '';
      const fullText = (summary + ' ' + transcript.map(t => t.content).join(' ')).toLowerCase();
      if (!callType) {
        const low = fullText;
        if (low.includes('warranty') || low.includes('dead') || low.includes('dying')) callType = 'warranty';
        else if (low.includes('root revive') || low.includes('fertiliz')) callType = 'root_revive';
        else if (low.includes('tree care') || low.includes('pruning') || low.includes('quarterly')) callType = 'tree_care';
        else if (low.includes('tree') || low.includes('buy') || low.includes('purchase') || low.includes('price')) callType = 'new_tree';
      }

      // Detect urgency
      let leadScore = call.lead_score || 'warm';
      if (callType === 'warranty') leadScore = 'urgent';
      else if (fullText.match(/ready to buy|wants to order|place an order|hot lead|interested in purchasing/)) leadScore = 'hot';

      // Save completed call to Supabase
      await dbPatch('calls', callId, {
        name:       name,
        phone:      phone,
        ended_at:   endedAt,
        duration:   duration,
        status:     'completed',
        summary:    summary,
        transcript: transcript,
        call_type:  callType,
        lead_score: leadScore,
        created_at: startedAt
      });

      console.log(`[End of Call] ${phone} | ${duration}s | type:${callType} | score:${leadScore}`);

      // ── EMAIL GROK ──
      emailGrok({
        name:       name,
        phone:      phone,
        call_type:  callType,
        lead_score: leadScore,
        summary:    summary,
        transcript: transcript,
        duration:   duration
      });

      delete activeCalls[callId];

      res.status(200).json({ received: true });
      return;
    }

  } catch(err) {
    console.error(`[Vapi Error] ${type}: ${err.message}`);
  }

  res.status(200).json({ received: true });
});

// ── TWILIO RING-ALBERT-FIRST ──
app.post('/twilio/ring-first', function(req, res) {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="15" action="https://atx-trees-webhook-x8tf.onrender.com/twilio/no-answer" method="POST">
    <Number>+17373284219</Number>
  </Dial>
</Response>`);
});

app.post('/twilio/no-answer', function(req, res) {
  const status = req.body.DialCallStatus;
  res.type('text/xml');
  if (status === 'completed') {
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  } else {
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Sip>sip:${(req.body.To||'').replace('+','')}@sip.vapi.ai</Sip></Dial></Response>`);
  }
});

// ── INBOUND TEXT WEBHOOK (iPhone Shortcuts → Dashboard) ──
app.post('/inbound-text', async function(req, res) {
  const { from, name, body, type } = req.body;
  if (!from && !body) return res.status(400).json({ error: 'Missing fields' });

  const entry = {
    phone:      from || '',
    name:       name || '',
    message:    body || '',
    type:       type || 'text',   // 'text' | 'missed_call'
    received_at: new Date().toISOString()
  };

  await dbWrite('inbound_texts', entry, '');
  console.log(`[Inbound Text] from ${entry.phone}: ${entry.message.slice(0,60)}`);
  res.json({ ok: true });
});

// ── READ INBOUND TEXTS (for dashboard) ──
app.get('/inbound-texts', async function(req, res) {
  const days = parseInt(req.query.days) || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const data = await dbGet('inbound_texts', `order=received_at.desc&limit=200&received_at=gte.${since}`);
  res.json({ texts: data || [] });
});

// ── READ CALLS (for dashboard / Grok) ──
app.get('/calls', async function(req, res) {
  const days = parseInt(req.query.days) || 14;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const data = await dbGet('calls', `order=created_at.desc&limit=500&created_at=gte.${since}`);
  res.json({ calls: data || [] });
});

// ── HEALTH ──
app.get('/health', function(req, res) {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), activeCalls: Object.keys(activeCalls).length });
});

app.listen(PORT, function() {
  console.log(`ATX Trees Webhook running on port ${PORT}`);
});
