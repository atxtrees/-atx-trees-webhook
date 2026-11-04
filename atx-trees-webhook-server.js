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
      res.on('end', () => resolve(res.statusCode));
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
        const messages = payload.conversation || payload.messages || [];
        if (messages.length > 0) {
          const last = messages[messages.length - 1];
          if (last?.content) {
            call.transcript.push({ role: last.role, content: last.content });
          }
        }
        if (payload.transcript && payload.role) {
          call.transcript.push({ role: payload.role, content: payload.transcript });
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
      const callId   = payload?.call?.id || payload?.callId;
      const call     = activeCalls[callId] || {};
      const startedAt = payload?.call?.startedAt || call.started_at || new Date().toISOString();
      const endedAt   = payload?.call?.endedAt   || new Date().toISOString();
      const duration  = Math.round((new Date(endedAt) - new Date(startedAt)) / 1000);
      const summary   = payload.summary || '';

      // Parse transcript array from payload if available
      let transcript = call.transcript || [];
      if (payload.transcript && Array.isArray(payload.transcript)) {
        transcript = payload.transcript.map(t => ({ role: t.role, content: t.content || t.text || '' }));
      }

      // Extract caller name from summary if not collected via function call
      let name = call.name || '';
      if (!name && summary) {
        const m = summary.match(/(?:name is|caller is|customer is)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i);
        if (m) name = m[1];
      }

      // Detect call type from summary
      let callType = call.call_type || '';
      if (!callType && summary) {
        const low = summary.toLowerCase();
        if (low.includes('warranty') || low.includes('dead') || low.includes('dying')) callType = 'warranty';
        else if (low.includes('root revive') || low.includes('fertiliz')) callType = 'root_revive';
        else if (low.includes('tree care') || low.includes('pruning') || low.includes('quarterly')) callType = 'tree_care';
        else if (low.includes('tree') || low.includes('buy') || low.includes('purchase') || low.includes('price')) callType = 'new_tree';
      }

      // Detect urgency
      let leadScore = call.lead_score || 'warm';
      if (callType === 'warranty') leadScore = 'urgent';
      else if (summary && summary.toLowerCase().match(/ready to buy|wants to order|place an order|hot lead/)) leadScore = 'hot';

      // Save completed call to Supabase
      await dbPatch('calls', callId, {
        name:       name,
        phone:      call.phone || formatPhone(payload?.call?.customer?.number || ''),
        ended_at:   endedAt,
        duration:   duration,
        status:     'completed',
        summary:    summary,
        transcript: transcript,
        call_type:  callType,
        lead_score: leadScore,
        created_at: startedAt
      });

      console.log(`[End of Call] ${call.phone} | ${duration}s | type:${callType} | score:${leadScore}`);
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
