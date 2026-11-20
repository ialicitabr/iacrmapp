// ═══════════════════════════════════════
// CRM SaaS — WhatsApp Webhook Handler
// Recebe mensagens e status do Meta
// ═══════════════════════════════════════

import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  // Webhook verification (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const verifyToken = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Find tenant by webhook token
    if (mode === 'subscribe' && verifyToken) {
      const { data: tenant } = await sb.from('tenants').select('id')
        .eq('whatsapp_webhook_token', verifyToken).single();
      if (tenant) return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // Incoming webhooks (POST)
  if (req.method === 'POST') {
    const body = req.body;

    try {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const phoneId = value?.metadata?.phone_number_id;

      if (!phoneId) return res.json({ ok: true });

      // Find tenant by phone_id
      const { data: tenant } = await sb.from('tenants').select('id,webhook_url,webhook_secret,webhook_eventos')
        .eq('whatsapp_phone_id', phoneId).single();
      if (!tenant) { console.log('Webhook: tenant not found for phoneId', phoneId); return res.json({ ok: true }); }

      const tenantId = tenant.id;

      // ── Incoming messages ──
      if (value?.messages) {
        for (const msg of value.messages) {
          const from = msg.from;
          const contactName = value.contacts?.[0]?.profile?.name || from;

          // Ensure contact exists
          let { data: contato } = await sb.from('whatsapp_contatos')
            .select('id,nao_lidas').eq('tenant_id', tenantId).eq('telefone', from).single();

          if (!contato) {
            const cId = crypto.randomUUID();
            await sb.from('whatsapp_contatos').insert({
              id: cId, tenant_id: tenantId, telefone: from, nome: contactName,
              empresa: '', etiqueta: 'novo', nao_lidas: 1,
              ultima_msg: new Date().toISOString()
            });
            contato = { id: cId, nao_lidas: 0 };
          }

          // Parse message content
          let conteudo = '', tipo = msg.type || 'texto';
          if (msg.type === 'text') conteudo = msg.text?.body || '';
          else if (msg.type === 'image') { conteudo = '[Imagem]'; tipo = 'imagem'; }
          else if (msg.type === 'audio') { conteudo = '[Áudio]'; tipo = 'audio'; }
          else if (msg.type === 'video') { conteudo = '[Vídeo]'; tipo = 'video'; }
          else if (msg.type === 'document') { conteudo = '[Documento] ' + (msg.document?.filename || ''); tipo = 'documento'; }
          else if (msg.type === 'location') { conteudo = '[Localização]'; tipo = 'localizacao'; }
          else if (msg.type === 'contacts') { conteudo = '[Contato]'; tipo = 'contato'; }
          else if (msg.type === 'sticker') { conteudo = '[Sticker]'; tipo = 'sticker'; }
          else conteudo = '[' + msg.type + ']';

          // Save message
          await sb.from('whatsapp_mensagens').insert({
            id: crypto.randomUUID(), tenant_id: tenantId, contato_id: contato.id,
            direcao: 'recebida', tipo, conteudo, wamid: msg.id, status: 'recebida',
            created_at: new Date(parseInt(msg.timestamp) * 1000).toISOString()
          });

          // Update contact
          await sb.from('whatsapp_contatos').update({
            nao_lidas: (contato.nao_lidas || 0) + 1,
            ultima_msg: new Date().toISOString(),
            ultima_msg_texto: conteudo.substring(0, 100),
            nome: contactName
          }).eq('id', contato.id);

          // Dispatch webhook to tenant
          if (tenant.webhook_url) {
            const shouldNotify = !tenant.webhook_eventos?.length || tenant.webhook_eventos.includes('whatsapp.mensagem_recebida');
            if (shouldNotify) {
              try {
                await fetch(tenant.webhook_url, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Secret': tenant.webhook_secret || '',
                    'X-Webhook-Event': 'whatsapp.mensagem_recebida'
                  },
                  body: JSON.stringify({
                    evento: 'whatsapp.mensagem_recebida',
                    dados: { contatoId: contato.id, telefone: from, nome: contactName, tipo, conteudo },
                    timestamp: new Date().toISOString()
                  }),
                  signal: AbortSignal.timeout(5000)
                });
              } catch(e) { console.log('Webhook dispatch error:', e.message); }
            }
          }
        }
      }

      // ── Status updates ──
      if (value?.statuses) {
        for (const s of value.statuses) {
          if (s.id) {
            await sb.from('whatsapp_mensagens').update({ status: s.status })
              .eq('wamid', s.id).eq('tenant_id', tenantId);
          }
        }
      }

    } catch(e) {
      console.error('Webhook error:', e.message);
    }

    return res.json({ ok: true });
  }

  return res.status(405).send('Method not allowed');
}
