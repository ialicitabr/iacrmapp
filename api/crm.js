// ═══════════════════════════════════════════════════════════════════
// IACRM — api/crm.js
// Backend principal · 62 rotas · Multi-tenant · JWT Auth
// ═══════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signJWT(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }));
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function hashPassword(pass) {
  return createHmac('sha256', JWT_SECRET + 'salt').update(pass).digest('hex');
}

async function authJWT(req) {
  const h = req.headers['authorization'] || '';
  const token = h.replace('Bearer ', '').trim();
  if (!token) return null;
  return verifyJWT(token);
}

function ok(res, data = {}, status = 200) {
  return res.status(status).json({ ok: true, ...data });
}

function err(res, msg, status = 400) {
  return res.status(status).json({ ok: false, error: msg });
}

async function callGemini(prompt, tenantId, historico = null) {
  // Buscar key do tenant (se disponível), fallback para variável de ambiente
  let key = GEMINI_KEY;
  if (tenantId) {
    try {
      const { data: t } = await sb.from('tenants').select('gemini_api_key').eq('id', tenantId).maybeSingle();
      if (t?.gemini_api_key) key = t.gemini_api_key;
    } catch(e) { /* usa GEMINI_KEY do ambiente */ }
  }
  if (!key) throw new Error('Gemini API Key não configurada');

  // Suporte a histórico multi-turn (array de {role, content})
  let contents;
  if (historico && Array.isArray(historico) && historico.length > 0) {
    contents = historico.map(h => ({
      role: h.role === 'assistant' || h.role === 'model' ? 'model' : 'user',
      parts: [{ text: h.content }]
    }));
    // Adicionar mensagem atual ao final
    contents.push({ role: 'user', parts: [{ text: prompt }] });
  } else {
    contents = [{ parts: [{ text: prompt }] }];
  }

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents }),
    signal: AbortSignal.timeout(30000)
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || 'Erro Gemini API');
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function sendEmail(to, subject, html, tenantId) {
  const { data: t } = await sb.from('tenants').select('resend_api_key,email_remetente,nome').eq('id', tenantId).maybeSingle();
  const key = t?.resend_api_key || RESEND_KEY;
  if (!key) return false;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: t?.email_remetente || 'noreply@iacrm.com.br', to, subject, html }),
    signal: AbortSignal.timeout(10000)
  });
  return true;
}

async function sendWhatsApp(phone, msg, tenantId, templateName = null, templateParams = []) {
  const { data: t } = await sb.from('tenants').select('whatsapp_phone_id,whatsapp_token').eq('id', tenantId).maybeSingle();
  if (!t?.whatsapp_phone_id || !t?.whatsapp_token) throw new Error('WhatsApp não configurado');
  let p = (phone || '').replace(/[\s\-\+\(\)]/g, '');
  if (!p.startsWith('55')) p = '55' + p;
  const payload = templateName
    ? { messaging_product: 'whatsapp', to: p, type: 'template', template: { name: templateName, language: { code: 'pt_BR' }, components: templateParams.length ? [{ type: 'body', parameters: templateParams.map(v => ({ type: 'text', text: v })) }] : [] } }
    : { messaging_product: 'whatsapp', to: p, type: 'text', text: { body: msg } };
  const r = await fetch(`https://graph.facebook.com/v25.0/${t.whatsapp_phone_id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t.whatsapp_token}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'Erro WhatsApp');
  return d.messages?.[0]?.id;
}

async function dispararWebhook(tenantId, evento, dados) {
  try {
    const { data: t } = await sb.from('tenants').select('webhook_url,webhook_secret,webhook_eventos').eq('id', tenantId).maybeSingle();
    if (!t?.webhook_url) return;
    if (t.webhook_eventos?.length && !t.webhook_eventos.includes(evento)) return;
    const payload = { evento, dados, timestamp: new Date().toISOString(), tenant_id: tenantId };
    const r = await fetch(t.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': t.webhook_secret || '', 'X-Webhook-Event': evento },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(5000)
    });
    await sb.from('webhook_logs').insert({ id: crypto.randomUUID(), tenant_id: tenantId, evento, payload, status_code: r.status, response: (await r.text()).substring(0, 500) });
  } catch (e) { console.log('Webhook err:', e.message); }
}

// ─────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = (req.url || '').replace('/api/crm', '').split('?')[0];
  const method = req.method;
  let body = {};
  const query = req.query || {};

  // Parse body se for JSON
  if (req.body) {
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body);
      } catch (e) {
        body = req.body;
      }
    } else {
      body = req.body;
    }
  }

  try {

    // ═══════════════════════════════════════
    // 0. ROTAS LEGADAS — landing pages IA CRM
    // POST /api/crm/agente com body.route
    // ═══════════════════════════════════════
    if (body.route && (path === '/agente' || path === '/login' || path === '/auth/login')) {
      const route = body.route;
      // Resolver tenantId via API Key para captura de leads
      let agtTenantId = null;
      try {
        const agtHdr = req.headers['authorization'] || '';
        const agtKey = agtHdr.replace('Bearer ', '').trim();
        if (agtKey && agtKey.startsWith('sk_')) {
          const { data: agtKr } = await sb.from('api_keys').select('tenant_id').eq('chave', agtKey).eq('ativo', true).maybeSingle();
          agtTenantId = agtKr?.tenant_id || null;
        }
      } catch(e) {}

      // 0.1 — Agente conversacional com Gemini
      if (route === 'crm.agenteChat') {
        const { tipo, historico, mensagem, systemPrompt: frontendSystemPrompt } = body;
        if (!mensagem) return err(res, 'mensagem obrigatória');

        const SISTEMAS = {
          iacrm: `Você é ARIA, agente de inteligência do IA CRM. Fale de forma natural, empática e consultiva em português brasileiro.
Sua missão: qualificar leads interessados no IA CRM e capturar dados para agendar uma demo.
Siga este fluxo conversacional (UMA pergunta por vez, nunca duas):
1. Pergunte qual o maior desafio em vendas ou atendimento ao cliente
2. Quantas pessoas tem na equipe comercial
3. Qual ferramenta/CRM usa atualmente (ou se não usa nenhuma)
4. Peça o nome completo
5. Peça o WhatsApp com DDD
6. Peça o e-mail

Quando tiver TODOS os dados (nome, whatsapp, email, desafio, equipe), responda SOMENTE com este JSON (sem markdown, sem explicação adicional):
{"leadCapturado":true,"nome":"VALOR","whatsapp":"VALOR","email":"VALOR","desafio":"VALOR","equipe":"VALOR","mensagemFinal":"Mensagem de encerramento calorosa confirmando contato em breve"}

Regras: nunca peça dois dados na mesma mensagem. Seja entusiasmado mas profissional. Mensagens curtas e diretas.`,

          licitacao: `Você é ARIA, agente de inteligência do IA LICITA. Fale em português brasileiro de forma amigável.
Missão: ajudar empresas a encontrar licitações públicas e capturar dados de contato.
Siga este fluxo (UMA pergunta por vez):
1. Nome da empresa e segmento de atuação
2. Cidade e estado
3. WhatsApp com DDD
4. E-mail

Quando tiver TODOS, responda SOMENTE com este JSON:
{"leadCapturado":true,"nome":"NOME_EMPRESA","cidade":"VALOR","whatsapp":"VALOR","email":"VALOR","mensagemFinal":"Mensagem confirmando que receberão as melhores oportunidades"}`,

          blog: `Você é ARIA, agente de conteúdo. Capture leads interessados em licitações. Fluxo: desafio → papel na empresa → nome → whatsapp → email. Quando tiver todos: {"leadCapturado":true,"nome":"x","whatsapp":"x","email":"x","papel":"x","mensagemFinal":"texto"}`,

          consultor: `Você é ARIA, agente consultor. Converta leads em consultores parceiros. Ticket médio R$450/mês, comissão 20% = R$90/cliente/mês. Fluxo: motivação → meta de renda → apresente cálculo → nome → whatsapp → email. Quando tiver todos: {"leadCapturado":true,"nome":"x","whatsapp":"x","email":"x","metaRenda":"x","mensagemFinal":"texto"}`,

          certificacao: `Você é ARIA, agente de certificações. Capture leads para cursos. Fluxo: nível de experiência → certificação de interesse → nome → whatsapp → email. Quando tiver todos: {"leadCapturado":true,"nome":"x","whatsapp":"x","email":"x","nivel":"x","mensagemFinal":"texto"}`
        };

        // Usar systemPrompt do frontend (tem contexto comportamental) ou fallback interno
        const sistema = frontendSystemPrompt || SISTEMAS[tipo] || SISTEMAS.iacrm;

        // Buscar Gemini API Key: tenant → variável de ambiente
        let geminiKey = GEMINI_KEY;
        if (agtTenantId) {
          try {
            const { data: t } = await sb.from('tenants').select('gemini_api_key').eq('id', agtTenantId).maybeSingle();
            if (t?.gemini_api_key) geminiKey = t.gemini_api_key;
          } catch(e) {}
        }
        if (!geminiKey) return err(res, 'Gemini API Key não configurada no servidor', 500);

        // Montar histórico multi-turn
        const contents = [];
        if (Array.isArray(historico)) {
          for (const h of historico) {
            contents.push({
              role: (h.role === 'assistant' || h.role === 'model') ? 'model' : 'user',
              parts: [{ text: String(h.content) }]
            });
          }
        }
        contents.push({ role: 'user', parts: [{ text: mensagem }] });

        let resposta = 'Olá! Tive um pequeno problema técnico. Pode repetir sua mensagem? 😊';
        try {
          const gemResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                system_instruction: { parts: [{ text: sistema }] },
                contents,
                generationConfig: { temperature: 0.75, maxOutputTokens: 600 }
              }),
              signal: AbortSignal.timeout(30000)
            }
          );
          const gemData = await gemResp.json();
          if (gemData.error) {
            console.error('[ARIA] Gemini error:', JSON.stringify(gemData.error));
          } else {
            const texto = gemData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (texto) resposta = texto;
          }
        } catch(e) {
          console.error('[ARIA] Erro fetch Gemini:', e.message);
        }

        // Detectar lead capturado
        let leadCapturado = null;
        try {
          const m = resposta.match(/\{[\s\S]*?"leadCapturado"\s*:\s*true[\s\S]*?\}/);
          if (m) {
            leadCapturado = JSON.parse(m[0]);
            // Salvar lead no banco automaticamente
            if (agtTenantId && leadCapturado) {
              const leadId = crypto.randomUUID();
              const nomeLead = leadCapturado.nome || leadCapturado.nome_empresa || 'Lead';
              const emailLead = leadCapturado.email || '';
              const waLead = (leadCapturado.whatsapp || '').replace(/\D/g,'');
              await sb.from('leads').insert({
                id: leadId, tenant_id: agtTenantId,
                nome_empresa: nomeLead, email: emailLead,
                whatsapp: waLead, cidade: leadCapturado.cidade || '',
                origem: 'agente_aria_' + (tipo || 'iacrm'), status: 'novo',
                dados_extra: { tipo_agente: tipo, dados_capturados: leadCapturado }
              }).catch(e => console.error('[ARIA] Erro salvar lead:', e.message));

              // Mensagem imediata de continuidade
              const msgBV = 'Ola ' + nomeLead + '! Aqui e a ARIA, assistente da IA Licita. ' +
                'Recebi seus dados e quero continuar nosso atendimento por aqui! ' +
                'Ja tenho seu nome, telefone e e-mail. ' +
                'Para avancarmos, consegue me informar o CNPJ da sua empresa?';

              if (waLead) {
                // Criar contato na inbox
                const { data: waEx } = await sb.from('whatsapp_contatos').select('id').eq('tenant_id', agtTenantId).eq('telefone', waLead).maybeSingle();
                if (!waEx) {
                  await sb.from('whatsapp_contatos').insert({ id: crypto.randomUUID(), tenant_id: agtTenantId, telefone: waLead, nome: nomeLead, etiqueta: 'lead_aria', nao_lidas: 0, status_atendimento: 'aguardando', ultima_msg: new Date().toISOString(), ultima_msg_texto: msgBV.substring(0,60) }).catch(()=>{});
                }
                await sendWhatsApp(waLead, msgBV, agtTenantId).catch(e => console.error('[ARIA BV WA]', e.message));
              }
              if (emailLead) {
                await sendEmail(emailLead, 'Ola ' + nomeLead + ', recebi seus dados!', msgBV, agtTenantId).catch(e => console.error('[ARIA BV Email]', e.message));
              }
            }
          }
        } catch(e) { console.error('[ARIA] Erro parse lead JSON:', e.message); }

        return ok(res, { data: { resposta: leadCapturado?.mensagemFinal || resposta, leadCapturado } });
      }

      // 0.2 — Capturar lead
      if (route === 'crm.capturarLeadAgente' || route === 'crm.capturarLead') {
        const { tipo, nome, nomeEmpresa, whatsapp, email, cidade, payload, contexto, origemWidget } = body;
        const nomeEmp = nome || nomeEmpresa || payload?.nomeEmpresa || email || 'Lead';
        const wa = whatsapp || payload?.whatsapp || '';
        const em = email || payload?.email || '';
        const cid = cidade || payload?.cidade || contexto?.cidade || '';
        const orig = origemWidget || payload?.origemWidget || 'agente_' + (tipo || 'landing');
        if (agtTenantId) {
          const leadId = crypto.randomUUID();
          await sb.from('leads').insert({
            id: leadId, tenant_id: agtTenantId,
            nome_empresa: nomeEmp, email: em, whatsapp: wa, cidade: cid,
            origem: orig, status: 'novo',
            dados_extra: { tipo, contexto, payload }
          }).catch(() => {});
          // Disparar jornada boas-vindas
          const { data: jBV } = await sb.from('crm_jornadas').select('id').eq('tenant_id', tenantId).eq('tipo', 'boas_vindas').eq('ativo', true).maybeSingle();
          if (jBV) await sb.from('jornada_execucoes').insert({ id: crypto.randomUUID(), tenant_id: tenantId, jornada_id: jBV.id, lead_id: leadId, status: 'ativa', etapa_atual: 0, iniciado_em: new Date().toISOString() }).catch(() => {});
          return ok(res, { data: { leadId, ok: true } });
        }
        return ok(res, { data: { ok: true } });
      }
    }

    // ═══════════════════════════════════════
    // 1. AUTH CRM — 7 rotas
    // ═══════════════════════════════════════

    // 1.1 — crm.login
    if (path === '/auth/login' && method === 'POST') {
      const { email, senha } = body;
      if (!email || !senha) return err(res, 'email e senha obrigatórios');
      const { data: user } = await sb.from('crm_usuarios')
        .select('*, tenants(id,nome,slug,plano,plano_status,trial_fim,logo_url,cor_primaria,cor_secundaria,whatsapp_phone_id,gemini_api_key)')
        .eq('email', email.toLowerCase()).eq('senha_hash', hashPassword(senha)).eq('status', 'ativo').maybeSingle();
      if (!user) return err(res, 'Credenciais inválidas', 401);
      const tenant = Array.isArray(user.tenants) ? user.tenants[0] : user.tenants;
      if (!tenant) return err(res, 'Tenant não encontrado', 404);
      if (tenant.plano_status === 'suspenso') return err(res, 'Conta suspensa. Entre em contato com o suporte.', 403);
      await sb.from('crm_usuarios').update({ ultimo_acesso: new Date().toISOString() }).eq('id', user.id);
      const token = signJWT({ userId: user.id, tenantId: user.tenant_id, papel: user.papel, nome: user.nome });
      const redirect = user.papel === 'superadmin' ? '/admin' : '/painel';
      return ok(res, { data: { token, redirect, user: { id: user.id, nome: user.nome, email: user.email, papel: user.papel, avatar_url: user.avatar_url }, tenant } });
    }

    // 1.2 — crm.me (rota pública com token)
    if (path === '/auth/me' && method === 'GET') {
      const auth = await authJWT(req);
      if (!auth) return err(res, 'Não autorizado', 401);
      const { data: user } = await sb.from('crm_usuarios').select('id,nome,email,papel,avatar_url,ultimo_acesso').eq('id', auth.userId).maybeSingle();
      const { data: tenant } = await sb.from('tenants').select('*').eq('id', auth.tenantId).maybeSingle();
      return ok(res, { data: { user, tenant } });
    }

    // 1.3 — crm.logout (stateless, apenas confirmação)
    if (path === '/auth/logout' && method === 'POST') {
      return ok(res, { data: { message: 'Logout realizado' } });
    }

    // 1.4b — Solicitar reset de senha (público)
    if (path === '/auth/esqueci-senha' && method === 'POST') {
      const { email } = body;
      if (!email) return err(res, 'E-mail obrigatório');

      const { data: user } = await sb.from('crm_usuarios')
        .select('id,nome,tenant_id').eq('email', email.toLowerCase()).eq('status', 'ativo').maybeSingle();

      // Sempre retorna ok para não vazar se email existe
      if (!user) return ok(res, { data: { msg: 'Se este e-mail existir, você receberá as instruções.' } });

      // Gerar token de reset (válido por 1h)
      const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
      const expira = new Date(Date.now() + 3600000).toISOString();

      // Salvar token na tabela (usando config do tenant como storage temporário)
      await sb.from('crm_usuarios').update({
        reset_token: token,
        reset_token_expira: expira
      }).eq('id', user.id);

      // Buscar config de email do tenant
      const { data: tenant } = await sb.from('tenants')
        .select('nome,resend_api_key,email_remetente').eq('id', user.tenant_id).maybeSingle();

      const appUrl = process.env.APP_URL || 'https://zapcrm-pi.vercel.app';
      const resetLink = `${appUrl}/login?reset=${token}`;
      const nomeUser = user.nome || email;

      // Enviar e-mail via Resend
      const resendKey = tenant?.resend_api_key || RESEND_KEY;
      if (resendKey) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: tenant?.email_remetente || 'IACRM <noreply@iacrm.com.br>',
            to: email,
            subject: '🔑 Redefinir sua senha — IACRM',
            html: `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#020509;padding:40px 20px">
              <div style="max-width:520px;margin:auto;background:#0a1828;border:1px solid rgba(0,212,255,.2);border-radius:12px;padding:40px">
                <div style="font-family:monospace;font-size:1.3rem;font-weight:700;margin-bottom:24px">
                  <span style="background:linear-gradient(135deg,#00d4ff,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent">IA</span>
                  <span style="color:#dceeff">CRM</span>
                </div>
                <h2 style="color:#dceeff;font-size:1.2rem;margin-bottom:8px">Redefinir senha</h2>
                <p style="color:#4d7a9e;font-size:.9rem;margin-bottom:24px">Olá, <strong style="color:#dceeff">${nomeUser}</strong>! Recebemos uma solicitação para redefinir sua senha.</p>
                <a href="${resetLink}" style="display:block;background:#00d4ff;color:#000;text-align:center;padding:14px 24px;border-radius:6px;font-family:monospace;font-weight:700;font-size:.85rem;text-decoration:none;letter-spacing:.05em;margin-bottom:20px">REDEFINIR SENHA →</a>
                <p style="color:#4d7a9e;font-size:.75rem;margin-bottom:8px">⏱ Este link expira em <strong style="color:#dceeff">1 hora</strong>.</p>
                <p style="color:#4d7a9e;font-size:.75rem">Se você não solicitou, ignore este e-mail. Sua senha não será alterada.</p>
                <div style="border-top:1px solid rgba(0,212,255,.1);margin-top:24px;padding-top:16px">
                  <p style="color:#4d7a9e;font-size:.7rem;font-family:monospace">Link: ${resetLink}</p>
                </div>
              </div>
            </body></html>`
          }),
          signal: AbortSignal.timeout(10000)
        });
      }

      return ok(res, { data: { msg: 'Se este e-mail existir, você receberá as instruções em breve.' } });
    }

    // 1.5b — Redefinir senha com token (público)
    if (path === '/auth/redefinir-senha' && method === 'POST') {
      const { token, novaSenha } = body;
      if (!token || !novaSenha) return err(res, 'Token e nova senha obrigatórios');
      if (novaSenha.length < 6) return err(res, 'Senha deve ter no mínimo 6 caracteres');

      const { data: user } = await sb.from('crm_usuarios')
        .select('id,reset_token_expira').eq('reset_token', token).eq('status', 'ativo').maybeSingle();

      if (!user) return err(res, 'Token inválido ou já utilizado', 400);
      if (new Date(user.reset_token_expira) < new Date()) return err(res, 'Token expirado. Solicite um novo reset.', 400);

      await sb.from('crm_usuarios').update({
        senha_hash: hashPassword(novaSenha),
        reset_token: null,
        reset_token_expira: null,
        updated_at: new Date().toISOString()
      }).eq('id', user.id);

      return ok(res, { data: { msg: 'Senha redefinida com sucesso! Faça login com sua nova senha.' } });
    }



    // 1.4 — crm.registrar (Onboarding - sem auth necessário)
    if (path === '/auth/registro' && method === 'POST') {
      const { nome, email, senha, empresa, whatsapp, segmento, canais, plano } = body;
      
      console.log('Registro recebido:', { nome, email, empresa, plano });
      
      // Validações
      if (!nome) return err(res, 'nome obrigatório');
      if (!email) return err(res, 'email obrigatório');
      if (!senha) return err(res, 'senha obrigatória');
      if (!empresa) return err(res, 'empresa obrigatória');
      
      if (senha.length < 6) {
        return err(res, 'Senha deve ter no mínimo 6 caracteres');
      }
      if (!email.includes('@')) {
        return err(res, 'E-mail inválido');
      }

      try {
        // Criar tenant (empresa)
        const tenantId = crypto.randomUUID();
        const slug = empresa
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '-')
          .substring(0, 50);

        const { error: tenantError } = await sb.from('tenants').insert({
          id: tenantId,
          nome: empresa,
          slug,
          email_admin: email.toLowerCase(),
          plano: plano || 'free',
          plano_status: 'trial',
          trial_fim: new Date(Date.now() + 14 * 86400000).toISOString(),
          whatsapp_phone_id: whatsapp || null,
          config: { segmento, canais: canais || [] },
          status: 'ativo'
        });

        if (tenantError) {
          console.error('Tenant insert error:', tenantError);
          // banco fora do ar (ex.: projeto do Supabase pausado): mensagem clara para o cliente, detalhe técnico só no log
          if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(String(tenantError.message) + ' ' + String(tenantError.details || ''))) {
            return err(res, 'Nosso sistema está indisponível por alguns minutos. Tente novamente em instantes.', 503);
          }
          return err(res, 'Erro ao criar empresa: ' + tenantError.message);
        }

        // Criar usuário admin
        const userId = crypto.randomUUID();
        const senhaHash = hashPassword(senha);

        const { error: userError } = await sb.from('crm_usuarios').insert({
          id: userId,
          tenant_id: tenantId,
          email: email.toLowerCase(),
          senha_hash: senhaHash,
          nome: nome,
          papel: 'admin',
          status: 'ativo'
        });

        if (userError) {
          console.error('User insert error:', userError);
          return err(res, 'Erro ao criar usuário: ' + userError.message);
        }

        // Gerar JWT
        const token = signJWT({ userId, tenantId, papel: 'admin', nome });

        // Buscar dados do tenant para retornar
        const { data: tenant } = await sb
          .from('tenants')
          .select('id,nome,slug,plano,email_admin,trial_fim,config')
          .eq('id', tenantId)
          .maybeSingle();

        return ok(
          res,
          {
            data: {
              token,
              user: { id: userId, nome, email: email.toLowerCase(), papel: 'admin' },
              tenant: tenant || { id: tenantId, nome: empresa, plano: plano || 'free' }
            }
          },
          201
        );
      } catch (e) {
        console.error('Registration error:', e);
        return err(res, 'Erro ao registrar: ' + e.message, 500);
      }
    }

    // Todas as rotas abaixo exigem auth (JWT ou API Key)
    const auth = await authJWT(req);
    // ═══════════════════════════════════════
    // DIAGNÓSTICO — rota pública (sem auth)
    // GET /api/crm/ping-gemini
    // ═══════════════════════════════════════
    if (path === '/ping-gemini' && method === 'GET') {
      return res.status(200).json({ ok: true, versao: 'v2025-05-07', status: 'online' });
    }
    if (path === '/ping-gemini-full' && method === 'GET') {
      const key = GEMINI_KEY;
      if (!key) return res.status(200).json({ ok: false, erro: 'GEMINI_API_KEY não definida na Vercel. Acesse: vercel.com → projeto iacrm-app → Settings → Environment Variables' });
      const modelos = [
        'gemini-2.5-flash-preview-04-17',
        'gemini-2.5-pro-preview-03-25',
        'gemini-2.0-flash',
        'gemini-2.0-flash-exp',
        'gemini-2.5-flash',
        'gemini-2.0-pro-exp',
        'gemini-exp-1206',
      ];
      const resultados = [];
      for (const modelo of modelos) {
        try {
          const t0 = Date.now();
          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${key}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ parts: [{ text: 'Responda apenas: OK' }] }] }),
              signal: AbortSignal.timeout(10000)
            }
          );
          const d = await r.json();
          const ms = Date.now() - t0;
          if (!d.error) {
            const texto = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return res.status(200).json({ ok: true, modelo, resposta: texto, ms, keyPrefix: key.substring(0, 8) + '...' });
          }
          resultados.push({ modelo, erro: d.error.message, code: d.error.code });
        } catch(e) {
          resultados.push({ modelo, erro: e.message });
        }
      }
      return res.status(200).json({ ok: false, erro: 'Nenhum modelo funcionou', resultados });
    }

        let tenantId, papel;

    if (auth) {
      tenantId = auth.tenantId;
      papel = auth.papel;
    } else {
      // Tentar API Key
      const h = req.headers['authorization'] || '';
      const apiKey = h.replace('Bearer ', '').trim();
      if (apiKey && apiKey.startsWith('sk_')) {
        const { data: keyRow } = await sb.from('api_keys')
          .select('tenant_id,scopes,ativo').eq('chave', apiKey).eq('ativo', true).maybeSingle();
        if (!keyRow) return err(res, 'API Key inválida ou revogada', 401);
        tenantId = keyRow.tenant_id;
        papel = 'api';
        await sb.from('api_keys').update({ ultimo_uso: new Date().toISOString() }).eq('chave', apiKey);
      } else {
        return err(res, 'Não autorizado', 401);
      }
    }

    // 1.4 — crm.criarUsuario
    if (path === '/auth/usuarios' && method === 'POST') {
      if (papel !== 'admin') return err(res, 'Apenas admins podem criar usuários', 403);
      const { email, senha, nome, papelNovo } = body;
      if (!email || !senha || !nome) return err(res, 'email, senha e nome obrigatórios');
      const { data: tenant } = await sb.from('tenants').select('limite_usuarios').eq('id', tenantId).maybeSingle();
      const { count } = await sb.from('crm_usuarios').select('id', { count: 'exact' }).eq('tenant_id', tenantId).eq('status', 'ativo');
      if (count >= (tenant?.limite_usuarios || 1)) return err(res, 'Limite de usuários do plano atingido');
      const id = crypto.randomUUID();
      await sb.from('crm_usuarios').insert({ id, tenant_id: tenantId, email: email.toLowerCase(), senha_hash: hashPassword(senha), nome, papel: papelNovo || 'operador' });
      return ok(res, { data: { id } }, 201);
    }

    // 1.5 — crm.listarUsuarios
    if (path === '/auth/usuarios' && method === 'GET') {
      if (papel !== 'admin') return err(res, 'Acesso negado', 403);
      const { data } = await sb.from('crm_usuarios').select('id,nome,email,papel,avatar_url,ultimo_acesso,status,created_at').eq('tenant_id', tenantId).order('created_at');
      return ok(res, { data: data || [] });
    }

    // 1.6 — crm.atualizarUsuario
    if (path.match(/^\/auth\/usuarios\/[\w-]+$/) && method === 'PUT') {
      const uid = path.split('/')[3];
      const updates = {};
      ['nome', 'papel', 'avatar_url'].forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });
      if (body.senha) updates.senha_hash = hashPassword(body.senha);
      if (Object.keys(updates).length === 0) return err(res, 'Nenhum campo para atualizar');
      await sb.from('crm_usuarios').update(updates).eq('id', uid).eq('tenant_id', tenantId);
      return ok(res, { data: { atualizado: true } });
    }

    // 1.6b — Admin redefine senha de outro usuário
    if (path.match(/^\/auth\/usuarios\/[\w-]+\/senha$/) && method === 'PUT') {
      if (papel !== 'admin' && papel !== 'api') return err(res, 'Apenas admins podem redefinir senhas', 403);
      const uid = path.split('/')[3];
      const { novaSenha } = body;
      if (!novaSenha || novaSenha.length < 6) return err(res, 'Senha deve ter no mínimo 6 caracteres');
      // Verificar que o usuário pertence ao mesmo tenant
      const { data: target } = await sb.from('crm_usuarios').select('id,nome,email').eq('id', uid).eq('tenant_id', tenantId).maybeSingle();
      if (!target) return err(res, 'Usuário não encontrado', 404);
      await sb.from('crm_usuarios').update({
        senha_hash: hashPassword(novaSenha),
        reset_token: null,
        reset_token_expira: null,
        updated_at: new Date().toISOString()
      }).eq('id', uid).eq('tenant_id', tenantId);
      return ok(res, { data: { redefinido: true, usuario: target.nome } });
    }



    // 1.7 — crm.removerUsuario
    if (path.match(/^\/auth\/usuarios\/[\w-]+$/) && method === 'DELETE') {
      if (papel !== 'admin') return err(res, 'Acesso negado', 403);
      const uid = path.split('/')[3];
      if (uid === auth.userId) return err(res, 'Não é possível remover a si mesmo');
      await sb.from('crm_usuarios').update({ status: 'inativo' }).eq('id', uid).eq('tenant_id', tenantId);
      return ok(res, { data: { removido: true } });
    }

    // ═══════════════════════════════════════
    // 2. TENANT — 4 rotas
    // ═══════════════════════════════════════

    // 2.1 — tenant.dados
    if (path === '/tenant' && method === 'GET') {
      const { data } = await sb.from('tenants').select('*').eq('id', tenantId).maybeSingle();
      return ok(res, { data });
    }

    // 2.2 — tenant.atualizar
    if (path === '/tenant' && method === 'PUT') {
      if (papel !== 'admin') return err(res, 'Acesso negado', 403);
      const campos = ['nome', 'logo_url', 'cor_primaria', 'cor_secundaria', 'whatsapp_phone_id', 'whatsapp_token', 'whatsapp_waba_id', 'gemini_api_key', 'resend_api_key', 'email_remetente', 'webhook_url', 'webhook_eventos', 'config'];
      const updates = {};
      campos.forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });
      updates.updated_at = new Date().toISOString();
      await sb.from('tenants').update(updates).eq('id', tenantId);
      return ok(res, { data: { atualizado: true } });
    }

    // 2.3 — tenant.gerarApiKey
    if ((path === '/tenant/api-key' || path === '/tenant/api-keys') && method === 'POST') {
      if (papel !== 'admin') return err(res, 'Acesso negado', 403);
      const { nome, scopes } = body;
      if (!nome) return err(res, 'nome obrigatório');
      const id = crypto.randomUUID();
      const chave = 'sk_live_' + crypto.randomUUID().replace(/-/g, '');
      await sb.from('api_keys').insert({ id, tenant_id: tenantId, nome, chave, scopes: scopes || ['read', 'write'], ativo: true });
      return ok(res, { data: { id, chave } }, 201);
    }

    // 2.4 — tenant.listarApiKeys
    if (path === '/tenant/api-keys' && method === 'GET') {
      const { data } = await sb.from('api_keys').select('id,nome,scopes,ultimo_uso,ativo,created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false });
      return ok(res, { data: data || [] });
    }

    // Revogar API Key
    if (path.startsWith('/tenant/api-keys/') && method === 'DELETE') {
      const keyId = path.split('/')[3];
      if (!keyId) return err(res, 'ID da key obrigatório');
      await sb.from('api_keys').update({ ativo: false }).eq('id', keyId).eq('tenant_id', tenantId);
      return ok(res, { data: { revogada: true } });
    }

    // ═══════════════════════════════════════
    // 3. LEADS — 6 rotas
    // ═══════════════════════════════════════

    // 3.1 — crm.listarLeads
    if (path === '/leads' && method === 'GET') {
      const { status, origem, segmento, busca, limit = 100, offset = 0 } = query;
      let q = sb.from('leads').select('*', { count: 'exact' }).eq('tenant_id', tenantId).order('created_at', { ascending: false }).range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
      if (status) q = q.eq('status', status);
      if (origem) q = q.eq('origem', origem);
      if (segmento) q = q.eq('segmento', segmento);
      if (busca) q = q.or(`nome_empresa.ilike.%${busca}%,email.ilike.%${busca}%,whatsapp.ilike.%${busca}%`);
      const { data, count } = await q;
      return ok(res, { data: data || [], total: count || 0 });
    }

    // 3.2 — crm.capturarLead
    if (path === '/leads' && method === 'POST') {
      const { nome_empresa, email, whatsapp, telefone, cidade, uf, segmento, origem, tags, notas, dados_extra, responsavel_id } = body;
      if (!nome_empresa) return err(res, 'nome_empresa obrigatório');
      const id = crypto.randomUUID();
      const { error: e } = await sb.from('leads').insert({ id, tenant_id: tenantId, nome_empresa, email: email || '', whatsapp: whatsapp || '', telefone: telefone || '', cidade: cidade || '', uf: uf || '', segmento: segmento || '', origem: origem || 'manual', tags: tags || [], notas: notas || '', dados_extra: dados_extra || {}, responsavel_id: responsavel_id || null });
      if (e) return err(res, 'Erro ao criar lead: ' + e.message);
      await dispararWebhook(tenantId, 'lead.novo', { id, nome_empresa, email, whatsapp });
      return ok(res, { data: { id } }, 201);
    }

    // 3.3 — crm.buscarLead
    if (path.match(/^\/leads\/[\w-]+$/) && method === 'GET') {
      const lid = path.split('/')[2];
      const { data } = await sb.from('leads').select('*, pipeline(*), crm_jornadas(*), whatsapp_contatos(id,telefone,ultima_msg,nao_lidas)').eq('id', lid).eq('tenant_id', tenantId).maybeSingle();
      if (!data) return err(res, 'Lead não encontrado', 404);
      return ok(res, { data });
    }

    // 3.4 — crm.atualizarLead
    if (path.match(/^\/leads\/[\w-]+$/) && method === 'PUT') {
      const lid = path.split('/')[2];
      const campos = ['nome_empresa', 'email', 'whatsapp', 'telefone', 'cidade', 'uf', 'status', 'score_comportamento', 'segmento', 'origem', 'tags', 'notas', 'dados_extra', 'responsavel_id'];
      const updates = {};
      campos.forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });
      updates.updated_at = new Date().toISOString();
      await sb.from('leads').update(updates).eq('id', lid).eq('tenant_id', tenantId);
      await dispararWebhook(tenantId, 'lead.atualizado', { id: lid, ...updates });
      if (updates.status === 'convertido') await dispararWebhook(tenantId, 'lead.convertido', { id: lid });
      return ok(res, { data: { atualizado: true } });
    }

    // 3.5 — crm.removerLead
    if (path.match(/^\/leads\/[\w-]+$/) && method === 'DELETE') {
      const lid = path.split('/')[2];
      await sb.from('leads').delete().eq('id', lid).eq('tenant_id', tenantId);
      return ok(res, { data: { removido: true } });
    }

    // 3.6 — crm.estatisticasLeads
    if (path === '/leads/stats' && method === 'GET') {
      const [total, porStatus, porOrigem, recentes] = await Promise.all([
        sb.from('leads').select('id', { count: 'exact' }).eq('tenant_id', tenantId),
        sb.from('leads').select('status').eq('tenant_id', tenantId),
        sb.from('leads').select('origem').eq('tenant_id', tenantId),
        sb.from('leads').select('id,created_at').eq('tenant_id', tenantId).gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
      ]);
      const statusCount = (porStatus.data || []).reduce((a, l) => { a[l.status] = (a[l.status] || 0) + 1; return a; }, {});
      const origemCount = (porOrigem.data || []).reduce((a, l) => { a[l.origem] = (a[l.origem] || 0) + 1; return a; }, {});
      return ok(res, { data: { total: total.count || 0, porStatus: statusCount, porOrigem: origemCount, ultimosSete: recentes.count || 0 } });
    }

    // ═══════════════════════════════════════
    // 4. CLIENTES — 5 rotas
    // ═══════════════════════════════════════

    // 4.1 — crm.listarClientes
    if (path === '/clientes' && method === 'GET') {
      const { status, busca, limit = 100, offset = 0 } = query;
      let q = sb.from('clientes').select('*', { count: 'exact' }).eq('tenant_id', tenantId).order('created_at', { ascending: false }).range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
      if (status) q = q.eq('status', status);
      if (busca) q = q.or(`nome_empresa.ilike.%${busca}%,email.ilike.%${busca}%`);
      const { data, count } = await q;
      return ok(res, { data: data || [], total: count || 0 });
    }

    // 4.2 — crm.salvarCliente
    if (path === '/clientes' && method === 'POST') {
      const { nome_empresa, email, whatsapp, telefone, cnpj, cidade, uf, plano, valor_mensal, lead_id, responsavel_id, tags, notas, dados_extra } = body;
      if (!nome_empresa) return err(res, 'nome_empresa obrigatório');
      const id = crypto.randomUUID();
      await sb.from('clientes').insert({ id, tenant_id: tenantId, nome_empresa, email: email || '', whatsapp: whatsapp || '', telefone: telefone || '', cnpj: cnpj || '', cidade: cidade || '', uf: uf || '', plano: plano || '', valor_mensal: valor_mensal || 0, lead_id: lead_id || null, responsavel_id: responsavel_id || null, tags: tags || [], notas: notas || '', dados_extra: dados_extra || {} });
      if (lead_id) await sb.from('leads').update({ status: 'convertido' }).eq('id', lead_id).eq('tenant_id', tenantId);
      return ok(res, { data: { id } }, 201);
    }

    // 4.3 — crm.buscarCliente
    if (path.match(/^\/clientes\/[\w-]+$/) && method === 'GET') {
      const cid = path.split('/')[2];
      const { data } = await sb.from('clientes').select('*').eq('id', cid).eq('tenant_id', tenantId).maybeSingle();
      if (!data) return err(res, 'Cliente não encontrado', 404);
      return ok(res, { data });
    }

    // 4.4 — crm.atualizarCliente
    if (path.match(/^\/clientes\/[\w-]+$/) && method === 'PUT') {
      const cid = path.split('/')[2];
      const campos = ['nome_empresa', 'email', 'whatsapp', 'telefone', 'cnpj', 'cidade', 'uf', 'plano', 'valor_mensal', 'status', 'responsavel_id', 'tags', 'notas', 'dados_extra'];
      const updates = {};
      campos.forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });
      updates.updated_at = new Date().toISOString();
      await sb.from('clientes').update(updates).eq('id', cid).eq('tenant_id', tenantId);
      return ok(res, { data: { atualizado: true } });
    }

    // 4.5 — clientes.estatisticas
    if (path === '/clientes/stats' && method === 'GET') {
      const { data } = await sb.from('clientes').select('id,status,valor_mensal').eq('tenant_id', tenantId);
      const ativos = (data || []).filter(c => c.status === 'ativo');
      const mrr = ativos.reduce((s, c) => s + parseFloat(c.valor_mensal || 0), 0);
      const porStatus = (data || []).reduce((a, c) => { a[c.status] = (a[c.status] || 0) + 1; return a; }, {});
      return ok(res, { data: { total: data?.length || 0, ativos: ativos.length, mrr, porStatus } });
    }

    // ═══════════════════════════════════════
    // 5. PIPELINE — 5 rotas
    // ═══════════════════════════════════════

    // 5.1 — pipeline.listar
    if (path === '/pipeline' && method === 'GET') {
      const { etapa } = query;
      let q = sb.from('pipeline').select('*, leads(nome_empresa,email,whatsapp), crm_usuarios(nome)').eq('tenant_id', tenantId).order('created_at', { ascending: false });
      if (etapa) q = q.eq('etapa', etapa);
      const { data } = await q;
      return ok(res, { data: data || [] });
    }

    // 5.2 — pipeline.adicionar
    if (path === '/pipeline' && method === 'POST') {
      const { titulo, descricao, valor, etapa, lead_id, cliente_id, responsavel_id, probabilidade, data_previsao, metadata } = body;
      if (!titulo) return err(res, 'titulo obrigatório');
      const id = crypto.randomUUID();
      await sb.from('pipeline').insert({ id, tenant_id: tenantId, titulo, descricao: descricao || '', valor: valor || 0, etapa: etapa || 'prospeccao', lead_id: lead_id || null, cliente_id: cliente_id || null, responsavel_id: responsavel_id || null, probabilidade: probabilidade || 0, data_previsao: data_previsao || null, metadata: metadata || {} });
      return ok(res, { data: { id } }, 201);
    }

    // 5.3 — pipeline.mover
    if (path.match(/^\/pipeline\/[\w-]+\/mover$/) && method === 'PUT') {
      const pid = path.split('/')[2];
      const { etapa } = body;
      if (!etapa) return err(res, 'etapa obrigatória');
      await sb.from('pipeline').update({ etapa, updated_at: new Date().toISOString() }).eq('id', pid).eq('tenant_id', tenantId);
      await dispararWebhook(tenantId, 'pipeline.movido', { id: pid, etapa });
      if (etapa === 'fechado_ganho') await dispararWebhook(tenantId, 'pipeline.fechado', { id: pid, etapa });
      return ok(res, { data: { movido: true } });
    }

    // 5.4 — pipeline.atualizar
    if (path.match(/^\/pipeline\/[\w-]+$/) && method === 'PUT') {
      const pid = path.split('/')[2];
      const campos = ['titulo', 'descricao', 'valor', 'etapa', 'probabilidade', 'data_previsao', 'responsavel_id', 'metadata'];
      const updates = {};
      campos.forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });
      updates.updated_at = new Date().toISOString();
      await sb.from('pipeline').update(updates).eq('id', pid).eq('tenant_id', tenantId);
      return ok(res, { data: { atualizado: true } });
    }

    // 5.5 — pipeline.remover
    if (path.match(/^\/pipeline\/[\w-]+$/) && method === 'DELETE') {
      const pid = path.split('/')[2];
      await sb.from('pipeline').delete().eq('id', pid).eq('tenant_id', tenantId);
      return ok(res, { data: { removido: true } });
    }

    // ═══════════════════════════════════════
    // WEBHOOK META
    if (path === '/whatsapp/webhook' && method === 'GET') {
      const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
      const mode = qs.get('hub.mode'), token = qs.get('hub.verify_token'), challenge = qs.get('hub.challenge');
      const fixed = process.env.WA_VERIFY_TOKEN || 'iacrm2025';
      if (mode === 'subscribe' && token === fixed) return res.status(200).send(challenge);
      const { data: tw } = await sb.from('tenants').select('id').eq('whatsapp_token', token).maybeSingle();
      if (mode === 'subscribe' && tw) return res.status(200).send(challenge);
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (path === '/whatsapp/webhook' && method === 'POST') {
      const changes = body?.entry?.[0]?.changes?.[0];
      const msgObj = changes?.value?.messages?.[0];
      if (!msgObj && changes?.value?.statuses) return res.status(200).json({ ok: true });
      const phoneId = changes?.value?.metadata?.phone_number_id || body?.entry?.[0]?.id;
      if (!msgObj || !phoneId) return res.status(200).json({ ok: true });
      const { data: tw } = await sb.from('tenants').select('id,nome,config,whatsapp_phone_id').eq('whatsapp_phone_id', phoneId).maybeSingle();
      if (!tw) return res.status(200).json({ ok: true });
      const tid = tw.id;
      const telefone = msgObj.from;
      const conteudo = msgObj.text?.body || '[mídia]';
      const { data: cEx } = await sb.from('whatsapp_contatos').select('id,lead_id,nao_lidas,status_atendimento').eq('tenant_id', tid).eq('telefone', telefone).maybeSingle();
      let cid;
      if (!cEx) {
        cid = crypto.randomUUID();
        await sb.from('whatsapp_contatos').insert({ id: cid, tenant_id: tid, telefone, nome: telefone, etiqueta: 'novo', nao_lidas: 1, ultima_msg: new Date().toISOString(), ultima_msg_texto: conteudo.substring(0, 60) });
      } else {
        cid = cEx.id;
        await sb.from('whatsapp_contatos').update({ nao_lidas: (cEx.nao_lidas||0)+1, ultima_msg: new Date().toISOString(), ultima_msg_texto: conteudo.substring(0, 60) }).eq('id', cid);
      }
      await sb.from('whatsapp_mensagens').insert({ id: crypto.randomUUID(), tenant_id: tid, contato_id: cid, direcao: 'recebida', conteudo, tipo: 'text', wamid: msgObj.id, created_at: new Date().toISOString() });

      // ARIA atendimento (só se não em atendimento humano)
      try {
        const statusAtual = cEx?.status_atendimento || 'aguardando';
        if (statusAtual !== 'atendendo' && statusAtual !== 'finalizado' && tw?.config?.aria_atendimento !== false) {
          const { data: hist } = await sb.from('whatsapp_mensagens').select('direcao,conteudo').eq('contato_id', cid).eq('tenant_id', tid).order('created_at', { ascending: false }).limit(6);
          const histStr = (hist||[]).reverse().map(m => (m.direcao==='recebida'?'Cliente':'ARIA')+': '+m.conteudo).join('\n');
          const sysP = (tw?.config?.aria_prompt || 'Voce e ARIA, assistente de vendas da ' + (tw?.nome||'IA Licita') + '. Responda de forma profissional e objetiva. Maximo 3 linhas. Se pedir humano ou frustracao intensa, termine com [ESCALAR].');
          const resp = await callGemini(sysP + '\n\nHistorico:\n' + histStr + '\n\nMensagem: ' + conteudo + '\n\nResposta:', tid);
          const msgFinal = resp.replace('[ESCALAR]','').trim();
          if (resp.includes('[ESCALAR]')) await sb.from('whatsapp_contatos').update({ status_atendimento: 'aguardando', etiqueta: 'escalar' }).eq('id', cid);
          await sendWhatsApp(telefone, msgFinal, tid);
          await sb.from('whatsapp_mensagens').insert({ id: crypto.randomUUID(), tenant_id: tid, contato_id: cid, direcao: 'enviada', conteudo: msgFinal, tipo: 'text', created_at: new Date(Date.now()+500).toISOString() });
          await sb.from('whatsapp_contatos').update({ ultima_msg: new Date().toISOString(), ultima_msg_texto: msgFinal.substring(0,60) }).eq('id', cid);
        }
      } catch(eA) { console.error('[ARIA]', eA.message); }
      return res.status(200).json({ ok: true });
    }

    // 6. WHATSAPP — 14 rotas
    // ═══════════════════════════════════════

    // 6.1 — whatsapp.listarContatos
    if (path === '/whatsapp/contatos' && method === 'GET') {
      const { busca, etiqueta, limit = 50, offset = 0 } = query;
      let q = sb.from('whatsapp_contatos').select('*', { count: 'exact' }).eq('tenant_id', tenantId).order('ultima_msg', { ascending: false }).range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
      if (etiqueta) q = q.eq('etiqueta', etiqueta);
      if (busca) q = q.or(`nome.ilike.%${busca}%,telefone.ilike.%${busca}%`);
      const { data, count } = await q;
      return ok(res, { data: data || [], total: count || 0 });
    }

    // 6.2 — whatsapp.buscarConversa
    if (path.match(/^\/whatsapp\/contatos\/[\w-]+\/mensagens$/) && method === 'GET') {
      const cid = path.split('/')[3];
      const { limit = 50, before } = query;
      let q = sb.from('whatsapp_mensagens').select('*').eq('tenant_id', tenantId).eq('contato_id', cid).order('created_at', { ascending: false }).limit(parseInt(limit));
      if (before) q = q.lt('created_at', before);
      const { data } = await q;
      await sb.from('whatsapp_contatos').update({ nao_lidas: 0 }).eq('id', cid).eq('tenant_id', tenantId);
      return ok(res, { data: (data || []).reverse() });
    }

    // 6.3 — whatsapp.enviarMensagem
    if (path === '/whatsapp/enviar' && method === 'POST') {
      const { contato_id, telefone, mensagem } = body;
      if (!mensagem) return err(res, 'mensagem obrigatória');
      let phone = telefone;
      if (!phone && contato_id) {
        const { data: c } = await sb.from('whatsapp_contatos').select('telefone').eq('id', contato_id).eq('tenant_id', tenantId).maybeSingle();
        phone = c?.telefone;
      }
      if (!phone) return err(res, 'telefone ou contato_id obrigatório');
      const wamid = await sendWhatsApp(phone, mensagem, tenantId);
      let p = phone.replace(/[\s\-\+\(\)]/g, '');
      if (!p.startsWith('55')) p = '55' + p;
      let { data: contato } = await sb.from('whatsapp_contatos').select('id').eq('tenant_id', tenantId).eq('telefone', p).maybeSingle();
      if (!contato) {
        const cId = crypto.randomUUID();
        await sb.from('whatsapp_contatos').insert({ id: cId, tenant_id: tenantId, telefone: p, nome: p });
        contato = { id: cId };
      }
      await sb.from('whatsapp_mensagens').insert({ id: crypto.randomUUID(), tenant_id: tenantId, contato_id: contato.id, direcao: 'enviada', tipo: 'texto', conteudo: mensagem, wamid: wamid || null, status: 'enviada' });
      return ok(res, { data: { enviado: true, wamid } });
    }

    // 6.4 — whatsapp.enviarTemplate
    if (path === '/whatsapp/template' && method === 'POST') {
      const { telefone, template_name, template_params, contato_id } = body;
      if (!template_name) return err(res, 'template_name obrigatório');
      let phone = telefone;
      if (!phone && contato_id) {
        const { data: c } = await sb.from('whatsapp_contatos').select('telefone').eq('id', contato_id).eq('tenant_id', tenantId).maybeSingle();
        phone = c?.telefone;
      }
      if (!phone) return err(res, 'telefone ou contato_id obrigatório');
      const wamid = await sendWhatsApp(phone, null, tenantId, template_name, template_params || []);
      return ok(res, { data: { enviado: true, wamid } });
    }

    // 6.5 — whatsapp.dispararLote
    if (path === '/whatsapp/lote' && method === 'POST') {
      const { contatos, mensagem, template_name, template_params } = body;
      if (!contatos?.length) return err(res, 'contatos obrigatório');
      if (!mensagem && !template_name) return err(res, 'mensagem ou template_name obrigatório');
      const campanhaId = crypto.randomUUID();
      let enviados = 0, erros = 0;
      for (const c of contatos) {
        try {
          const phone = c.telefone || c;
          if (template_name) await sendWhatsApp(phone, null, tenantId, template_name, template_params || []);
          else await sendWhatsApp(phone, mensagem, tenantId);
          enviados++;
          await new Promise(r => setTimeout(r, 200));
        } catch { erros++; }
      }
      return ok(res, { data: { campanhaId, enviados, erros, total: contatos.length } });
    }

    // 6.6 — whatsapp.atualizarContato
    if (path.match(/^\/whatsapp\/contatos\/[\w-]+$/) && method === 'PUT') {
      const cid = path.split('/')[3];
      const campos = ['nome', 'empresa', 'etiqueta', 'notas', 'lead_id', 'cliente_id'];
      const updates = {};
      campos.forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });
      updates.updated_at = new Date().toISOString();
      await sb.from('whatsapp_contatos').update(updates).eq('id', cid).eq('tenant_id', tenantId);
      return ok(res, { data: { atualizado: true } });
    }

    // 6.7 — whatsapp.listarTemplates
    if (path === '/whatsapp/templates' && method === 'GET') {
      const { data: tenant } = await sb.from('tenants').select('whatsapp_waba_id,whatsapp_token').eq('id', tenantId).maybeSingle();
      if (!tenant?.whatsapp_waba_id || !tenant?.whatsapp_token) return err(res, 'WhatsApp não configurado');
      const r = await fetch(`https://graph.facebook.com/v25.0/${tenant.whatsapp_waba_id}/message_templates?limit=100`, {
        headers: { 'Authorization': `Bearer ${tenant.whatsapp_token}` }, signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      return ok(res, { data: d.data || [] });
    }

    // 6.8 — whatsapp.gerarResposta (IA)
    if (path === '/whatsapp/ia-resposta' && method === 'POST') {
      const { contato_id, contexto } = body;
      if (!contato_id) return err(res, 'contato_id obrigatório');
      const { data: msgs } = await sb.from('whatsapp_mensagens').select('direcao,conteudo,created_at').eq('contato_id', contato_id).eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(10);
      const historico = (msgs || []).reverse().map(m => `${m.direcao === 'recebida' ? 'Cliente' : 'Empresa'}: ${m.conteudo}`).join('\n');
      const { data: tenant } = await sb.from('tenants').select('nome').eq('id', tenantId).maybeSingle();
      const prompt = `Você é um assistente de vendas da empresa "${tenant?.nome}". Baseado neste histórico de conversa, gere uma resposta profissional, empática e persuasiva:\n\n${historico}\n\nContexto adicional: ${contexto || 'sem contexto extra'}\n\nResponda apenas com o texto da mensagem, sem explicações.`;
      const resposta = await callGemini(prompt, tenantId);
      return ok(res, { data: { resposta: resposta.trim() } });
    }

    // 6.9 — whatsapp.analisarSentimento
    if (path === '/whatsapp/sentimento' && method === 'POST') {
      const { texto, contato_id } = body;
      let conteudo = texto;
      if (!conteudo && contato_id) {
        const { data: msgs } = await sb.from('whatsapp_mensagens').select('conteudo').eq('contato_id', contato_id).eq('tenant_id', tenantId).eq('direcao', 'recebida').order('created_at', { ascending: false }).limit(5);
        conteudo = (msgs || []).map(m => m.conteudo).join(' ');
      }
      if (!conteudo) return err(res, 'texto ou contato_id obrigatório');
      const prompt = `Analise o sentimento e intenção deste texto de uma conversa de vendas:\n"${conteudo}"\n\nResponda APENAS em JSON válido:\n{"interesse":0-100,"urgencia":0-100,"hesitacao":0-100,"confianca":0-100,"entusiasmo":0-100,"frustracao":0-100,"intencao_compra":0-100,"perfil":"hot|warm|cold","acao_recomendada":"texto curto","confianca_modelo":0-100}`;
      const raw = await callGemini(prompt, tenantId);
      let parsed;
      try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
      catch { parsed = { perfil: 'cold', acao_recomendada: 'Aguardar mais dados', confianca_modelo: 50 }; }
      return ok(res, { data: parsed });
    }

    // 6.10 — whatsapp.statsInbox
    if (path === '/whatsapp/stats' && method === 'GET') {
      const [contatos, mensagens] = await Promise.all([
        sb.from('whatsapp_contatos').select('id,etiqueta,nao_lidas').eq('tenant_id', tenantId),
        sb.from('whatsapp_mensagens').select('id,direcao,created_at').eq('tenant_id', tenantId).gte('created_at', new Date(Date.now() - 86400000).toISOString())
      ]);
      const totalNaoLidas = (contatos.data || []).reduce((s, c) => s + (c.nao_lidas || 0), 0);
      const porEtiqueta = (contatos.data || []).reduce((a, c) => { a[c.etiqueta] = (a[c.etiqueta] || 0) + 1; return a; }, {});
      return ok(res, { data: { totalContatos: contatos.data?.length || 0, totalNaoLidas, porEtiqueta, mensagens24h: mensagens.data?.length || 0 } });
    }

    // 6.11-6.14 — whatsapp extras
    if (path === '/whatsapp/contatos' && method === 'POST') {
      const { telefone, nome, empresa, etiqueta, lead_id, cliente_id } = body;
      if (!telefone) return err(res, 'telefone obrigatório');
      let p = telefone.replace(/[\s\-\+\(\)]/g, '');
      if (!p.startsWith('55')) p = '55' + p;
      const id = crypto.randomUUID();
      const { error: e } = await sb.from('whatsapp_contatos').upsert({ id, tenant_id: tenantId, telefone: p, nome: nome || p, empresa: empresa || '', etiqueta: etiqueta || 'novo', lead_id: lead_id || null, cliente_id: cliente_id || null }, { onConflict: 'tenant_id,telefone' });
      if (e) return err(res, e.message);
      return ok(res, { data: { id } }, 201);
    }

    if (path.match(/^\/whatsapp\/contatos\/[\w-]+\/marcar-lido$/) && method === 'POST') {
      const cid = path.split('/')[3];
      await sb.from('whatsapp_contatos').update({ nao_lidas: 0 }).eq('id', cid).eq('tenant_id', tenantId);
      return ok(res, { data: { ok: true } });
    }

    if (path === '/whatsapp/configurar' && method === 'POST') {
      if (papel !== 'admin') return err(res, 'Acesso negado', 403);
      const { phone_id, token, waba_id } = body;
      if (!phone_id || !token) return err(res, 'phone_id e token obrigatórios');
      await sb.from('tenants').update({ whatsapp_phone_id: phone_id, whatsapp_token: token, whatsapp_waba_id: waba_id || null }).eq('id', tenantId);
      return ok(res, { data: { configurado: true } });
    }

    if (path === '/whatsapp/bot' && method === 'PUT') {
      if (papel !== 'admin') return err(res, 'Acesso negado', 403);
      const { bot_ativo, bot_prompt } = body;
      await sb.from('tenants').update({ config: sb.rpc ? undefined : {} }).eq('id', tenantId);
      const { data: t } = await sb.from('tenants').select('config').eq('id', tenantId).maybeSingle();
      await sb.from('tenants').update({ config: { ...(t?.config || {}), bot_ativo: bot_ativo ?? true, bot_prompt: bot_prompt || '' } }).eq('id', tenantId);
      return ok(res, { data: { atualizado: true } });
    }

    // ═══════════════════════════════════════
    // 7. CONTEÚDO IA — 8 rotas
    // ═══════════════════════════════════════

    // 7.1 — conteudo.listar
    if (path === '/conteudo' && method === 'GET') {
      const { plataforma, status: st, limit = 50, offset = 0 } = query;
      let q = sb.from('conteudo').select('*', { count: 'exact' }).eq('tenant_id', tenantId).order('created_at', { ascending: false }).range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
      if (plataforma) q = q.eq('plataforma', plataforma);
      if (st) q = q.eq('status', st);
      const { data, count } = await q;
      return ok(res, { data: data || [], total: count || 0 });
    }

    // 7.2 — conteudo.gerarIA
    if (path === '/conteudo/gerar' && method === 'POST') {
      const { plataforma, tema, tom, idioma, publico, cta } = body;
      if (!plataforma || !tema) return err(res, 'plataforma e tema obrigatórios');
      const { data: tenant } = await sb.from('tenants').select('nome').eq('id', tenantId).maybeSingle();
      const prompt = `Você é um especialista em marketing de conteúdo. Gere um post profissional para ${plataforma} da empresa "${tenant?.nome}" sobre "${tema}". Tom: ${tom || 'profissional e empático'}. Público: ${publico || 'profissionais brasileiros'}. CTA: ${cta || 'sem CTA específico'}. Idioma: ${idioma || 'português brasileiro'}.\n\nResponda APENAS em JSON válido:\n{"titulo":"...","corpo":"...","hashtags":"...","cta_texto":"...","melhor_horario":"...","dicas":"..."}`;
      const raw = await callGemini(prompt, tenantId);
      let parsed;
      try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
      catch { parsed = { titulo: tema, corpo: raw, hashtags: '', cta_texto: '', melhor_horario: '', dicas: '' }; }
      const id = crypto.randomUUID();
      await sb.from('conteudo').insert({ id, tenant_id: tenantId, plataforma, tipo: 'post', titulo: parsed.titulo, corpo: parsed.corpo, hashtags: parsed.hashtags, tom: tom || 'profissional', status: 'rascunho', criado_por: auth.userId });
      return ok(res, { data: { id, ...parsed } }, 201);
    }

    // 7.3 — conteudo.gerarLote
    if (path === '/conteudo/lote' && method === 'POST') {
      const { plataformas, tema, tom } = body;
      if (!plataformas?.length || !tema) return err(res, 'plataformas e tema obrigatórios');
      const resultados = [];
      for (const plat of plataformas) {
        const prompt = `Gere post para ${plat} sobre "${tema}". Tom: ${tom || 'profissional'}. JSON: {"titulo":"...","corpo":"...","hashtags":"..."}`;
        const raw = await callGemini(prompt, tenantId);
        let parsed;
        try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { parsed = { titulo: tema, corpo: raw, hashtags: '' }; }
        const id = crypto.randomUUID();
        await sb.from('conteudo').insert({ id, tenant_id: tenantId, plataforma: plat, tipo: 'post', titulo: parsed.titulo, corpo: parsed.corpo, hashtags: parsed.hashtags, tom: tom || 'profissional', status: 'rascunho', criado_por: auth.userId });
        resultados.push({ id, plataforma: plat, ...parsed });
      }
      return ok(res, { data: resultados }, 201);
    }

    // 7.4 — conteudo.salvar
    if (path === '/conteudo' && method === 'POST') {
      const { plataforma, tipo, titulo, corpo, hashtags, tom, agendado_para } = body;
      if (!plataforma || !corpo) return err(res, 'plataforma e corpo obrigatórios');
      const id = crypto.randomUUID();
      await sb.from('conteudo').insert({ id, tenant_id: tenantId, plataforma, tipo: tipo || 'post', titulo: titulo || '', corpo, hashtags: hashtags || '', tom: tom || 'profissional', status: agendado_para ? 'agendado' : 'rascunho', agendado_para: agendado_para || null, criado_por: auth.userId });
      return ok(res, { data: { id } }, 201);
    }

    // 7.5 — conteudo.agendar
    if (path.match(/^\/conteudo\/[\w-]+\/agendar$/) && method === 'PUT') {
      const cid = path.split('/')[2];
      const { agendado_para } = body;
      if (!agendado_para) return err(res, 'agendado_para obrigatório');
      await sb.from('conteudo').update({ status: 'agendado', agendado_para }).eq('id', cid).eq('tenant_id', tenantId);
      return ok(res, { data: { agendado: true } });
    }

    // 7.6 — conteudo.atualizar
    if (path.match(/^\/conteudo\/[\w-]+$/) && method === 'PUT') {
      const cid = path.split('/')[2];
      const campos = ['titulo', 'corpo', 'hashtags', 'tom', 'status', 'agendado_para', 'imagem_url'];
      const updates = {};
      campos.forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });
      await sb.from('conteudo').update(updates).eq('id', cid).eq('tenant_id', tenantId);
      return ok(res, { data: { atualizado: true } });
    }

    // 7.7 — conteudo.remover
    if (path.match(/^\/conteudo\/[\w-]+$/) && method === 'DELETE') {
      const cid = path.split('/')[2];
      await sb.from('conteudo').delete().eq('id', cid).eq('tenant_id', tenantId);
      return ok(res, { data: { removido: true } });
    }

    // 7.8 — conteudo.sugerirTemas
    if (path === '/conteudo/sugerir-temas' && method === 'POST') {
      const { segmento, plataforma, quantidade } = body;
      const { data: tenant } = await sb.from('tenants').select('nome').eq('id', tenantId).maybeSingle();
      const prompt = `Sugira ${quantidade || 10} temas de conteúdo para ${plataforma || 'redes sociais'} para uma empresa do segmento "${segmento || 'B2B'}" chamada "${tenant?.nome}". Responda APENAS com JSON: {"temas":["tema1","tema2",...]}`;
      const raw = await callGemini(prompt, tenantId);
      let parsed;
      try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { parsed = { temas: [] }; }
      return ok(res, { data: parsed });
    }

    // ═══════════════════════════════════════
    // 8. JORNADAS CRM — 7 rotas
    // ═══════════════════════════════════════

    // 8.1 — crm.listarJornadas
    if (path === '/jornadas' && method === 'GET') {
      const { status: st } = query;
      let q = sb.from('crm_jornadas').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false });
      if (st) q = q.eq('status', st);
      const { data } = await q;
      return ok(res, { data: data || [] });
    }

    // 8.1b — Templates de jornadas IA pré-definidas
    if (path === '/jornadas/templates' && method === 'GET') {
      return ok(res, { data: [
        {
          tipo: 'boas_vindas', nome: '🎉 Boas-vindas', descricao: 'Sequência de onboarding para novos leads',
          passos: [
            { dia: 0, canal: 'whatsapp', mensagem: 'Olá {nome}! 👋 Bem-vindo(a)! Sou da equipe e estou aqui para ajudar. Como posso começar a apoiar você hoje?' },
            { dia: 1, canal: 'email', assunto: 'Bem-vindo(a) — próximos passos', mensagem: 'Olá {nome},\n\nFicamos felizes em ter você conosco! Aqui estão os próximos passos para começar...' },
            { dia: 3, canal: 'whatsapp', mensagem: 'Oi {nome}! Tudo certo com o acesso? Posso te ajudar com alguma dúvida?' },
            { dia: 7, canal: 'whatsapp', mensagem: '{nome}, já faz uma semana! 🚀 Quais resultados você já conseguiu? Adoraria ouvir!' }
          ]
        },
        {
          tipo: 'churn', nome: '🚨 Anti-churn', descricao: 'Reengajar clientes em risco de cancelamento',
          passos: [
            { dia: 0, canal: 'whatsapp', mensagem: 'Oi {nome}! Notamos que faz um tempo que você não acessa a plataforma. Posso ajudar com algo? 🤝' },
            { dia: 2, canal: 'email', assunto: 'Sentimos sua falta, {nome}', mensagem: 'Olá {nome},\n\nTemos novidades incríveis e gostaríamos de te mostrar o que melhorou desde sua última visita...' },
            { dia: 5, canal: 'whatsapp', mensagem: '{nome}, que tal uma conversa rápida? Posso te mostrar como nossos clientes estão usando a plataforma para crescer. Qual horário fica bom?' },
            { dia: 10, canal: 'whatsapp', mensagem: '{nome}, queremos muito continuar te ajudando. Temos uma oferta especial para você 🎁 Pode falar agora?' }
          ]
        },
        {
          tipo: 'retencao', nome: '💎 Retenção', descricao: 'Fortalecer relacionamento com clientes ativos',
          passos: [
            { dia: 0, canal: 'whatsapp', mensagem: 'Oi {nome}! Como está indo tudo? Queria saber se está aproveitando todos os recursos disponíveis 💪' },
            { dia: 14, canal: 'email', assunto: 'Dica exclusiva para {nome}', mensagem: 'Olá {nome},\n\nEsta semana queremos compartilhar uma estratégia que nossos melhores clientes usam...' },
            { dia: 30, canal: 'whatsapp', mensagem: '{nome}, completamos 1 mês juntos! 🎉 Obrigado pela confiança. Algum feedback ou sugestão?' }
          ]
        },
        {
          tipo: 'recuperacao', nome: '🔄 Recuperação', descricao: 'Reativar clientes que cancelaram',
          passos: [
            { dia: 0, canal: 'whatsapp', mensagem: 'Oi {nome}, tudo bem? Vi que você encerrou sua assinatura. Ficou faltando algo? Adoraria entender sua experiência 🙏' },
            { dia: 7, canal: 'email', assunto: 'Voltamos, {nome}! Com novidades', mensagem: 'Olá {nome},\n\nTemos novidades que acreditamos que iriam te surpreender. Que tal dar uma nova chance?' },
            { dia: 15, canal: 'whatsapp', mensagem: '{nome}! Preparamos uma condição especial de retorno exclusiva para você. Posso te enviar os detalhes?' }
          ]
        },
        {
          tipo: 'rentabilizacao', nome: '📈 Rentabilização', descricao: 'Upsell e cross-sell para clientes ativos',
          passos: [
            { dia: 0, canal: 'whatsapp', mensagem: 'Oi {nome}! Sua conta está indo muito bem 🚀 Você sabia que com o plano avançado você conseguiria [benefício]? Vale conhecer!' },
            { dia: 3, canal: 'email', assunto: 'Como {nome} pode crescer ainda mais', mensagem: 'Olá {nome},\n\nClientes como você que crescem rápido acabam precisando de mais recursos. Veja o que o upgrade oferece...' },
            { dia: 7, canal: 'whatsapp', mensagem: '{nome}, posso te mostrar em 5 minutos como o upgrade acelera seus resultados? Qual horário fica bom?' }
          ]
        }
      ]});
    }

    // 8.2 — crm.iniciarJornada
    if (path === '/jornadas' && method === 'POST') {
      const { tipo, nome, email, whatsapp, lead_id, cliente_id, passos } = body;
      if (!tipo) return err(res, 'tipo obrigatório');

      // Buscar template se não vier passos customizados
      let passosFinais = passos;
      if (!passosFinais || !passosFinais.length) {
        const templates = {
          boas_vindas: [
            { dia: 0, canal: 'whatsapp', mensagem: 'Olá! 👋 Bem-vindo(a)! Como posso ajudar você hoje?' },
            { dia: 1, canal: 'email', assunto: 'Bem-vindo(a)', mensagem: 'Ficamos felizes em ter você conosco! Aqui estão seus próximos passos.' },
            { dia: 3, canal: 'whatsapp', mensagem: 'Tudo certo com o acesso? Posso ajudar com alguma dúvida?' },
            { dia: 7, canal: 'whatsapp', mensagem: 'Já faz uma semana! 🚀 Como estão os resultados?' }
          ]
        };
        passosFinais = templates[tipo] || [];
      }

      const id = crypto.randomUUID();
      const prox = new Date().toISOString();
      await sb.from('crm_jornadas').insert({
        id, tenant_id: tenantId, tipo, nome: nome || tipo,
        email: email || '', whatsapp: whatsapp || '',
        lead_id: lead_id || null, cliente_id: cliente_id || null,
        status: 'ativa', dia_atual: 0, proximo_disparo: prox,
        passos: passosFinais, historico: [], ativo: true
      });
      await dispararWebhook(tenantId, 'jornada.iniciada', { id, tipo, lead_id, cliente_id });
      return ok(res, { data: { id } }, 201);
    }

    // 8.3 — crm.pausarJornada
    if (path.match(/^\/jornadas\/[\w-]+\/pausar$/) && method === 'POST') {
      const jid = path.split('/')[2];
      await sb.from('crm_jornadas').update({ status: 'pausada' }).eq('id', jid).eq('tenant_id', tenantId);
      return ok(res, { data: { pausada: true } });
    }

    // 8.4 — crm.retomarJornada
    if (path.match(/^\/jornadas\/[\w-]+\/retomar$/) && method === 'POST') {
      const jid = path.split('/')[2];
      await sb.from('crm_jornadas').update({ status: 'ativa', proximo_disparo: new Date().toISOString() }).eq('id', jid).eq('tenant_id', tenantId);
      return ok(res, { data: { retomada: true } });
    }

    // 8.5 — crm.cancelarJornada
    if (path.match(/^\/jornadas\/[\w-]+\/cancelar$/) && method === 'POST') {
      const jid = path.split('/')[2];
      await sb.from('crm_jornadas').update({ status: 'cancelada' }).eq('id', jid).eq('tenant_id', tenantId);
      return ok(res, { data: { cancelada: true } });
    }

    // 8.6 — crm.executarJornada (cron trigger)
    if (path === '/jornadas/executar' && method === 'POST') {
      const agora = new Date().toISOString();
      const { data: jornadas } = await sb.from('crm_jornadas').select('*').eq('tenant_id', tenantId).eq('status', 'ativa').lte('proximo_disparo', agora);
      let executadas = 0;
      for (const j of (jornadas || [])) {
        try {
          const passos = j.passos || [];
          const passo = passos[j.dia_atual];
          if (!passo) { await sb.from('crm_jornadas').update({ status: 'concluida' }).eq('id', j.id); continue; }
          if (passo.canal === 'email' && j.email) await sendEmail(j.email, passo.assunto || 'Mensagem', passo.conteudo || '', tenantId);
          if (passo.canal === 'whatsapp' && j.whatsapp) await sendWhatsApp(j.whatsapp, passo.conteudo, tenantId);
          const proximo = new Date(Date.now() + (passo.intervalo_horas || 24) * 3600000).toISOString();
          const historico = [...(j.historico || []), { dia: j.dia_atual, executado: agora, canal: passo.canal }];
          const proximoDia = j.dia_atual + 1;
          const novoStatus = proximoDia >= passos.length ? 'concluida' : 'ativa';
          await sb.from('crm_jornadas').update({ dia_atual: proximoDia, proximo_disparo: novoStatus === 'concluida' ? null : proximo, status: novoStatus, historico }).eq('id', j.id);
          executadas++;
        } catch (e) { console.error('Jornada err:', e.message); }
      }
      return ok(res, { data: { executadas } });
    }

    // 8.7 — crm.jornadasDisponiveis
    if (path === '/jornadas/modelos' && method === 'GET') {
      return ok(res, { data: [
        { tipo: 'boas_vindas', nome: 'Boas-vindas', descricao: 'Sequência de onboarding para novos clientes', canais: ['email', 'whatsapp'], dias: 7 },
        { tipo: 'nutricao', nome: 'Nutrição de Lead', descricao: 'Educar e engajar leads frios', canais: ['email'], dias: 30 },
        { tipo: 'reativacao', nome: 'Reativação', descricao: 'Reativar clientes inativos', canais: ['email', 'whatsapp', 'sms'], dias: 14 },
        { tipo: 'pos_venda', nome: 'Pós-venda', descricao: 'Onboarding e sucesso do cliente', canais: ['email', 'whatsapp'], dias: 30 },
        { tipo: 'upsell', nome: 'Upsell', descricao: 'Apresentar upgrade de plano', canais: ['email', 'whatsapp'], dias: 7 },
        { tipo: 'nps', nome: 'NPS', descricao: 'Coletar NPS após 30 dias', canais: ['email', 'whatsapp'], dias: 1 },
      ]});
    }

    // ═══════════════════════════════════════
    // 9. CAMPANHAS — 6 rotas
    // ═══════════════════════════════════════

    // 9.1 — crm.listarCampanhas
    if (path === '/campanhas' && method === 'GET') {
      const { data } = await sb.from('campanhas').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false });
      return ok(res, { data: data || [] });
    }

    // 9.2 — crm.criarCampanha
    if (path === '/campanhas' && method === 'POST') {
      const { nome, tipo, segmento, template_id, conteudo, agendado_para } = body;
      if (!nome || !tipo) return err(res, 'nome e tipo obrigatórios');
      const id = crypto.randomUUID();
      await sb.from('campanhas').insert({ id, tenant_id: tenantId, nome, tipo, segmento: segmento || {}, template_id: template_id || null, conteudo: conteudo || '', status: agendado_para ? 'agendada' : 'rascunho', agendado_para: agendado_para || null, criado_por: auth.userId });
      return ok(res, { data: { id } }, 201);
    }

    // 9.3 — crm.dispararCampanha
    if (path.match(/^\/campanhas\/[\w-]+\/disparar$/) && method === 'POST') {
      const cid = path.split('/')[2];
      const { data: campanha } = await sb.from('campanhas').select('*').eq('id', cid).eq('tenant_id', tenantId).maybeSingle();
      if (!campanha) return err(res, 'Campanha não encontrada', 404);
      await sb.from('campanhas').update({ status: 'enviando' }).eq('id', cid);
      // disparo assíncrono — retorna imediatamente
      (async () => {
        try {
          let destinatarios = [];
          if (campanha.tipo === 'whatsapp') {
            const { data: contatos } = await sb.from('whatsapp_contatos').select('telefone').eq('tenant_id', tenantId).neq('etiqueta', 'bloqueado');
            destinatarios = (contatos || []).map(c => c.telefone);
          } else if (campanha.tipo === 'email') {
            const { data: leads } = await sb.from('leads').select('email').eq('tenant_id', tenantId).neq('email', '');
            destinatarios = (leads || []).map(l => l.email).filter(Boolean);
          }
          let enviados = 0;
          for (const dest of destinatarios.slice(0, 500)) {
            try {
              if (campanha.tipo === 'whatsapp') await sendWhatsApp(dest, campanha.conteudo, tenantId, campanha.template_id);
              else if (campanha.tipo === 'email') await sendEmail(dest, campanha.nome, campanha.conteudo, tenantId);
              enviados++;
              await new Promise(r => setTimeout(r, 300));
            } catch { /* continua */ }
          }
          await sb.from('campanhas').update({ status: 'concluida', total_destinatarios: destinatarios.length, total_enviados: enviados }).eq('id', cid);
        } catch (e) { await sb.from('campanhas').update({ status: 'rascunho' }).eq('id', cid); }
      })();
      return ok(res, { data: { disparado: true, mensagem: 'Campanha em disparo' } });
    }

    // 9.4 — crm.atualizarCampanha
    if (path.match(/^\/campanhas\/[\w-]+$/) && method === 'PUT') {
      const cid = path.split('/')[2];
      const campos = ['nome', 'conteudo', 'segmento', 'template_id', 'agendado_para', 'status'];
      const updates = {};
      campos.forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });
      await sb.from('campanhas').update(updates).eq('id', cid).eq('tenant_id', tenantId);
      return ok(res, { data: { atualizado: true } });
    }

    // 9.5 — crm.removerCampanha
    if (path.match(/^\/campanhas\/[\w-]+$/) && method === 'DELETE') {
      const cid = path.split('/')[2];
      await sb.from('campanhas').delete().eq('id', cid).eq('tenant_id', tenantId);
      return ok(res, { data: { removido: true } });
    }

    // 9.6 — crm.gerarCopyIACampanha
    if (path === '/campanhas/gerar-copy' && method === 'POST') {
      const { tipo, objetivo, publico, tom } = body;
      const { data: tenant } = await sb.from('tenants').select('nome').eq('id', tenantId).maybeSingle();
      const prompt = `Gere o conteúdo de uma campanha de ${tipo || 'email'} para a empresa "${tenant?.nome}". Objetivo: ${objetivo || 'engajamento'}. Público: ${publico || 'leads'}. Tom: ${tom || 'profissional'}. JSON: {"assunto":"...","corpo":"...","cta":"...","preview":"..."}`;
      const raw = await callGemini(prompt, tenantId);
      let parsed;
      try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { parsed = { assunto: objetivo, corpo: raw, cta: '', preview: '' }; }
      return ok(res, { data: parsed });
    }

    // ═══════════════════════════════════════
    // 10. NPS — 6 rotas
    // ═══════════════════════════════════════

    // 10.1 — nps.listar
    if (path === '/nps' && method === 'GET') {
      const { data } = await sb.from('nps_campanhas').select('*, nps_respostas(count)').eq('tenant_id', tenantId).order('created_at', { ascending: false });
      return ok(res, { data: data || [] });
    }

    // 10.2 — nps.criar
    if (path === '/nps' && method === 'POST') {
      const { nome, pergunta } = body;
      if (!nome) return err(res, 'nome obrigatório');
      const id = crypto.randomUUID();
      await sb.from('nps_campanhas').insert({ id, tenant_id: tenantId, nome, pergunta: pergunta || 'De 0 a 10, quanto você recomendaria nossos serviços?', status: 'ativa', total_respostas: 0, nps_score: 0 });
      return ok(res, { data: { id } }, 201);
    }

    // 10.3 — nps.registrar (endpoint público p/ resposta)
    if (path.match(/^\/nps\/[\w-]+\/responder$/) && method === 'POST') {
      const nid = path.split('/')[2];
      const { nota, comentario, nome: nomeResp, email: emailResp } = body;
      if (nota === undefined || nota < 0 || nota > 10) return err(res, 'nota deve ser entre 0 e 10');
      const rid = crypto.randomUUID();
      await sb.from('nps_respostas').insert({ id: rid, tenant_id: tenantId, campanha_id: nid, nota: parseInt(nota), comentario: comentario || '', nome: nomeResp || '', email: emailResp || '' });
      const { data: all } = await sb.from('nps_respostas').select('nota').eq('campanha_id', nid);
      const total = all?.length || 0;
      const promotores = (all || []).filter(r => r.nota >= 9).length;
      const detratores = (all || []).filter(r => r.nota <= 6).length;
      const npsScore = total > 0 ? Math.round(((promotores - detratores) / total) * 100) : 0;
      await sb.from('nps_campanhas').update({ total_respostas: total, nps_score: npsScore }).eq('id', nid);
      await dispararWebhook(tenantId, 'nps.respondido', { campanha_id: nid, nota, nps_score: npsScore });
      return ok(res, { data: { rid, nps_score: npsScore } }, 201);
    }

    // 10.4 — nps.dashboard
    if (path.match(/^\/nps\/[\w-]+\/dashboard$/) && method === 'GET') {
      const nid = path.split('/')[2];
      const { data: respostas } = await sb.from('nps_respostas').select('nota,comentario,nome,created_at').eq('campanha_id', nid).eq('tenant_id', tenantId).order('created_at', { ascending: false });
      const total = respostas?.length || 0;
      const promotores = (respostas || []).filter(r => r.nota >= 9);
      const neutros = (respostas || []).filter(r => r.nota >= 7 && r.nota < 9);
      const detratores = (respostas || []).filter(r => r.nota <= 6);
      const npsScore = total > 0 ? Math.round(((promotores.length - detratores.length) / total) * 100) : 0;
      return ok(res, { data: { total, nps_score: npsScore, promotores: promotores.length, neutros: neutros.length, detratores: detratores.length, respostas: respostas?.slice(0, 20) || [] } });
    }

    // 10.5 — nps.enviarTodos
    if (path.match(/^\/nps\/[\w-]+\/enviar$/) && method === 'POST') {
      const nid = path.split('/')[2];
      const { canal } = body;
      const { data: campanha } = await sb.from('nps_campanhas').select('*').eq('id', nid).eq('tenant_id', tenantId).maybeSingle();
      if (!campanha) return err(res, 'Campanha não encontrada', 404);
      const { data: clientes } = await sb.from('clientes').select('email,whatsapp,nome_empresa').eq('tenant_id', tenantId).eq('status', 'ativo');
      const link = `${process.env.APP_URL || 'https://app.iacrm.com.br'}/nps/${nid}`;
      let enviados = 0;
      for (const c of (clientes || []).slice(0, 200)) {
        try {
          if ((canal === 'email' || !canal) && c.email) await sendEmail(c.email, campanha.nome, `<p>Olá! Responda nossa pesquisa: <a href="${link}">${link}</a></p>`, tenantId);
          if (canal === 'whatsapp' && c.whatsapp) await sendWhatsApp(c.whatsapp, `${campanha.pergunta}\nResponda aqui: ${link}`, tenantId);
          enviados++;
          await new Promise(r => setTimeout(r, 200));
        } catch { /* continua */ }
      }
      return ok(res, { data: { enviados } });
    }

    // 10.6 — nps.remover
    if (path.match(/^\/nps\/[\w-]+$/) && method === 'DELETE') {
      const nid = path.split('/')[2];
      await sb.from('nps_campanhas').delete().eq('id', nid).eq('tenant_id', tenantId);
      return ok(res, { data: { removido: true } });
    }

    // ═══════════════════════════════════════
    // 11. INTEGRAÇÕES — 3 rotas
    // ═══════════════════════════════════════

    if (path === '/integracoes' && method === 'GET') {
      const { data } = await sb.from('integracoes').select('*').eq('tenant_id', tenantId);
      return ok(res, { data: data || [] });
    }

    if (path === '/integracoes' && method === 'POST') {
      const { plataforma, nome, icone, config: cfg } = body;
      if (!plataforma) return err(res, 'plataforma obrigatória');
      const id = crypto.randomUUID();
      await sb.from('integracoes').upsert({ id, tenant_id: tenantId, plataforma, nome: nome || plataforma, icone: icone || '', config: cfg || {}, status: 'conectado' }, { onConflict: 'tenant_id,plataforma' });
      return ok(res, { data: { id } }, 201);
    }

    if (path.match(/^\/integracoes\/[\w-]+$/) && method === 'DELETE') {
      const iid = path.split('/')[2];
      await sb.from('integracoes').update({ status: 'desconectado', config: {} }).eq('id', iid).eq('tenant_id', tenantId);
      return ok(res, { data: { desconectado: true } });
    }

    // ═══════════════════════════════════════
    // 12. CALENDÁRIO — 3 rotas
    // ═══════════════════════════════════════

    if (path === '/calendario' && method === 'GET') {
      const { inicio, fim } = query;
      let q = sb.from('calendario').select('*').eq('tenant_id', tenantId).order('data_inicio');
      if (inicio) q = q.gte('data_inicio', inicio);
      if (fim) q = q.lte('data_inicio', fim);
      const { data } = await q;
      return ok(res, { data: data || [] });
    }

    if (path === '/calendario' && method === 'POST') {
      const { titulo, descricao, data_inicio, data_fim, tipo, lead_id, cliente_id, responsavel_id } = body;
      if (!titulo || !data_inicio) return err(res, 'titulo e data_inicio obrigatórios');
      const id = crypto.randomUUID();
      await sb.from('calendario').insert({ id, tenant_id: tenantId, titulo, descricao: descricao || '', data_inicio, data_fim: data_fim || null, tipo: tipo || 'tarefa', lead_id: lead_id || null, cliente_id: cliente_id || null, responsavel_id: responsavel_id || auth.userId });
      return ok(res, { data: { id } }, 201);
    }

    if (path.match(/^\/calendario\/[\w-]+$/) && method === 'DELETE') {
      const eid = path.split('/')[2];
      await sb.from('calendario').delete().eq('id', eid).eq('tenant_id', tenantId);
      return ok(res, { data: { removido: true } });
    }

    // ═══════════════════════════════════════
    // 13. PUSH NOTIFICATIONS — 3 rotas
    // ═══════════════════════════════════════

    if (path === '/push' && method === 'GET') {
      const { data } = await sb.from('push_notifications').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(50);
      return ok(res, { data: data || [] });
    }

    if (path === '/push' && method === 'POST') {
      const { titulo, mensagem, tipo, destinatarios } = body;
      if (!titulo || !mensagem) return err(res, 'titulo e mensagem obrigatórios');
      const id = crypto.randomUUID();
      await sb.from('push_notifications').insert({ id, tenant_id: tenantId, titulo, mensagem, tipo: tipo || 'info', destinatarios: destinatarios || [], enviado_em: new Date().toISOString() });
      return ok(res, { data: { id } }, 201);
    }

    if (path.match(/^\/push\/[\w-]+$/) && method === 'DELETE') {
      const pid = path.split('/')[2];
      await sb.from('push_notifications').delete().eq('id', pid).eq('tenant_id', tenantId);
      return ok(res, { data: { removido: true } });
    }

    // ═══════════════════════════════════════
    // 14. DASHBOARD — 1 rota
    // ═══════════════════════════════════════

    if (path === '/dashboard' && method === 'GET') {
      const [leads, clientes, pipeline, waContatos, jornadas, campanhas, nps] = await Promise.all([
        sb.from('leads').select('id,status,score_comportamento', { count: 'exact' }).eq('tenant_id', tenantId),
        sb.from('clientes').select('id,status,valor_mensal', { count: 'exact' }).eq('tenant_id', tenantId),
        sb.from('pipeline').select('id,etapa,valor').eq('tenant_id', tenantId),
        sb.from('whatsapp_contatos').select('id,nao_lidas,etiqueta', { count: 'exact' }).eq('tenant_id', tenantId),
        sb.from('crm_jornadas').select('id,status').eq('tenant_id', tenantId),
        sb.from('campanhas').select('id,status,total_enviados').eq('tenant_id', tenantId),
        sb.from('nps_campanhas').select('nps_score').eq('tenant_id', tenantId).eq('status', 'ativa').order('created_at', { ascending: false }).limit(1)
      ]);

      const pipelineValor = (pipeline.data || []).filter(p => !['fechado_perdido'].includes(p.etapa)).reduce((s, p) => s + parseFloat(p.valor || 0), 0);
      const mrr = (clientes.data || []).filter(c => c.status === 'ativo').reduce((s, c) => s + parseFloat(c.valor_mensal || 0), 0);
      const waNaoLidas = (waContatos.data || []).reduce((s, c) => s + (c.nao_lidas || 0), 0);
      const pipelinePorEtapa = (pipeline.data || []).reduce((a, p) => { a[p.etapa] = (a[p.etapa] || 0) + 1; return a; }, {});
      const scoresMedio = (leads.data || []).length > 0 ? Math.round((leads.data || []).reduce((s, l) => s + (l.score_comportamento || 0), 0) / (leads.data || []).length) : 0;

      return ok(res, { data: {
        leads: { total: leads.count || 0, porStatus: (leads.data || []).reduce((a, l) => { a[l.status] = (a[l.status] || 0) + 1; return a; }, {}), scoreMedio: scoresMedio },
        clientes: { total: clientes.count || 0, ativos: (clientes.data || []).filter(c => c.status === 'ativo').length, mrr },
        pipeline: { total: pipeline.data?.length || 0, valor: pipelineValor, porEtapa: pipelinePorEtapa },
        whatsapp: { totalContatos: waContatos.count || 0, naoLidas: waNaoLidas },
        jornadas: { ativas: (jornadas.data || []).filter(j => j.status === 'ativa').length, total: jornadas.data?.length || 0 },
        campanhas: { total: campanhas.data?.length || 0, totalEnviados: (campanhas.data || []).reduce((s, c) => s + (c.total_enviados || 0), 0) },
        nps: { score: nps.data?.[0]?.nps_score || 0 }
      }});
    }

    // ═══════════════════════════════════════
    // 15. INSIGHTS IA — 2 rotas
    // ═══════════════════════════════════════

    if (path === '/insights' && method === 'GET') {
      const [leads, clientes, nps] = await Promise.all([
        sb.from('leads').select('segmento,origem,status,score_comportamento').eq('tenant_id', tenantId),
        sb.from('clientes').select('plano,status,valor_mensal').eq('tenant_id', tenantId),
        sb.from('nps_respostas').select('nota').eq('tenant_id', tenantId)
      ]);
      const totalLeads = leads.data?.length || 0;
      const txConversao = totalLeads > 0 ? Math.round(((leads.data || []).filter(l => l.status === 'convertido').length / totalLeads) * 100) : 0;
      const origens = (leads.data || []).reduce((a, l) => { a[l.origem] = (a[l.origem] || 0) + 1; return a; }, {});
      const melhorOrigem = Object.entries(origens).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
      return ok(res, { data: { txConversao, melhorOrigem, scoreLeads: (leads.data || []).reduce((s, l) => s + (l.score_comportamento || 0), 0) / (totalLeads || 1), npsMediaGeral: (nps.data || []).reduce((s, r) => s + r.nota, 0) / ((nps.data?.length) || 1), origens } });
    }

    if (path === '/insights/ia' && method === 'POST') {
      const { pergunta, contexto, historico } = body;
      if (!pergunta) return err(res, 'pergunta obrigatória');
      
      // Prioridade: usar contexto do agente IA se disponível (landing page)
      // Senão, usar contexto de análise de dados do tenant
      let prompt = '';
      
      if (contexto) {
        // MODO AGENTE IA (LANDING PAGE) — contexto comportamental completo
        prompt = `${contexto}\n\nHistórico da conversa: ${JSON.stringify(historico || [])}\n\nNova pergunta do lead: "${pergunta}"\n\nResponda de forma natural, humana e inteligente. Máximo 2 frases.`;
      } else {
        // MODO ANALYTICS (PAINEL ADMIN) — análise de dados do tenant
        const [leads, clientes] = await Promise.all([
          sb.from('leads').select('status,segmento,origem,score_comportamento').eq('tenant_id', tenantId),
          sb.from('clientes').select('status,valor_mensal,plano').eq('tenant_id', tenantId)
        ]);
        const contextoData = `Leads: ${JSON.stringify((leads.data || []).slice(0, 20))}. Clientes: ${JSON.stringify((clientes.data || []).slice(0, 20))}.`;
        prompt = `Você é um analista de CRM especialista em inteligência comportamental. Com base nestes dados do tenant:\n${contextoData}\n\nResponda esta pergunta de negócio de forma clara e acionável:\n"${pergunta}"\n\nForneça insights precisos baseado em dados.`;
      }
      
      const resposta = await callGemini(prompt, tenantId);
      return ok(res, { data: { resposta } });
    }

    // ═══════════════════════════════════════
    // 16. SMS — 2 rotas
    // ═══════════════════════════════════════

    if (path === '/sms/enviar' && method === 'POST') {
      const { telefone, mensagem } = body;
      if (!telefone || !mensagem) return err(res, 'telefone e mensagem obrigatórios');
      const { data: t } = await sb.from('tenants').select('config').eq('id', tenantId).maybeSingle();
      const smsConfig = t?.config?.sms || {};
      if (!smsConfig.api_key) return err(res, 'SMS não configurado. Adicione sua API key de SMS nas configurações.');
      return ok(res, { data: { enviado: true, mensagem: 'SMS integração via config.sms' } });
    }

    if (path === '/sms/lote' && method === 'POST') {
      const { telefones, mensagem } = body;
      if (!telefones?.length || !mensagem) return err(res, 'telefones e mensagem obrigatórios');
      return ok(res, { data: { agendado: true, total: telefones.length } });
    }

    // ═══════════════════════════════════════
    // 15. SDK UNIVERSAL
    // Rotas públicas autenticadas por API Key
    // ═══════════════════════════════════════

    // SDK: capturar lead via snippet
    if (path === '/sdk/lead' && method === 'POST') {
      const { visitor_id, session_id, nome_empresa, email, whatsapp, cidade, uf, origem, behavior, dados_extra } = body;
      if (!nome_empresa && !email && !whatsapp) return err(res, 'Informe pelo menos nome, email ou whatsapp');

      // Verificar lead duplicado por email ou whatsapp neste tenant
      let leadId = null;
      if (email) {
        const { data: existing } = await sb.from('leads').select('id').eq('tenant_id', tenantId).eq('email', email).maybeSingle();
        if (existing) {
          leadId = existing.id;
          await sb.from('leads').update({
            visitor_id: visitor_id || null,
            dados_extra: { ...(dados_extra || {}), ...(behavior || {}), sdk: true },
            updated_at: new Date().toISOString()
          }).eq('id', leadId);
        }
      }

      if (!leadId) {
        leadId = crypto.randomUUID();
        await sb.from('leads').insert({
          id: leadId, tenant_id: tenantId,
          nome_empresa: nome_empresa || email || whatsapp || 'Lead SDK',
          email: email || '', whatsapp: whatsapp || '',
          cidade: cidade || '', uf: uf || '',
          origem: origem || 'sdk', status: 'novo',
          visitor_id: visitor_id || null,
          dados_extra: { ...(dados_extra || {}), behavior: behavior || {}, sdk: true, session_id }
        });
        await dispararWebhook(tenantId, 'lead.novo', { id: leadId, nome_empresa, email, whatsapp, origem: 'sdk' });

        // Disparar jornada de boas-vindas automática
        try {
          const { data: jornadaBV } = await sb.from('crm_jornadas')
            .select('id').eq('tenant_id', tenantId).eq('tipo', 'boas_vindas').eq('ativo', true).maybeSingle();
          if (jornadaBV) {
            await sb.from('jornada_execucoes').insert({
              id: crypto.randomUUID(), tenant_id: tenantId,
              jornada_id: jornadaBV.id, lead_id: leadId,
              status: 'ativa', etapa_atual: 0,
              iniciado_em: new Date().toISOString()
            });
          }
        } catch(e) {}
      }

      return ok(res, { data: { leadId, criado: true } }, 201);
    }

    // SDK: identificar visitante
    if (path === '/sdk/identify' && method === 'POST') {
      const { visitor_id, dados } = body;
      if (dados?.email) {
        const { data: lead } = await sb.from('leads').select('id').eq('tenant_id', tenantId).eq('email', dados.email).maybeSingle();
        if (lead) {
          await sb.from('leads').update({ visitor_id: visitor_id || null, dados_extra: dados }).eq('id', lead.id);
          return ok(res, { data: { leadId: lead.id, atualizado: true } });
        }
      }
      return ok(res, { data: { identificado: false } });
    }

    // SDK: rastrear evento
    if (path === '/sdk/evento' && method === 'POST') {
      const { visitor_id, evento, props, behavior } = body;
      await sb.from('sdk_eventos').insert({
        id: crypto.randomUUID(), tenant_id: tenantId,
        visitor_id: visitor_id || null, evento,
        props: props || {}, behavior: behavior || {},
        created_at: new Date().toISOString()
      }).catch(() => {}); // silencioso se tabela não existir ainda
      return ok(res, { data: { registrado: true } });
    }

    // SDK: pageview
    if (path === '/sdk/pageview' && method === 'POST') {
      const { visitor_id, pagina, titulo, behavior } = body;
      await sb.from('sdk_pageviews').insert({
        id: crypto.randomUUID(), tenant_id: tenantId,
        visitor_id: visitor_id || null, pagina: pagina || '/',
        titulo: titulo || '', behavior: behavior || {},
        created_at: new Date().toISOString()
      }).catch(() => {});
      return ok(res, { data: { ok: true } });
    }

    // SDK: servir o arquivo sdk.js com o tenant embutido
    if (path === '/sdk.js' && method === 'GET') {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end('// IA CRM SDK — tenant: ' + tenantId + '\n// Use: <script src="https://iacrmapp.com.br/sdk.js" data-key="SUA_API_KEY"></script>');
    }

    // ═══════════════════════════════════════
    // 16. SUPER-ADMIN (apenas papel superadmin)
    // ═══════════════════════════════════════

    if (path.startsWith('/superadmin') && papel !== 'superadmin') {
      return err(res, 'Acesso restrito ao super-admin', 403);
    }

    // 16.1 — Listar todos os tenants
    if (path === '/superadmin/tenants' && method === 'GET') {
      const { data: tenants } = await sb.from('tenants')
        .select('id,nome,slug,plano,plano_status,trial_fim,created_at,cor_primaria')
        .order('created_at', { ascending: false });
      // Para cada tenant, buscar contagens
      const result = await Promise.all((tenants || []).map(async t => {
        const [{ count: leads }, { count: usuarios }, { count: clientes }] = await Promise.all([
          sb.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
          sb.from('crm_usuarios').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id).eq('status', 'ativo'),
          sb.from('clientes').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        ]);
        return { ...t, _leads: leads || 0, _usuarios: usuarios || 0, _clientes: clientes || 0 };
      }));
      return ok(res, { data: result });
    }

    // 16.2 — Dashboard super-admin (KPIs globais)
    if (path === '/superadmin/dashboard' && method === 'GET') {
      const [{ count: totalTenants }, { count: totalLeads }, { count: totalUsuarios }] = await Promise.all([
        sb.from('tenants').select('id', { count: 'exact', head: true }),
        sb.from('leads').select('id', { count: 'exact', head: true }),
        sb.from('crm_usuarios').select('id', { count: 'exact', head: true }).eq('status', 'ativo'),
      ]);
      const { data: planos } = await sb.from('tenants').select('plano, plano_status');
      const mrr = (planos || []).reduce((acc, t) => {
        if (t.plano_status !== 'ativo') return acc;
        const precos = { starter: 97, pro: 197, enterprise: 497 };
        return acc + (precos[t.plano?.toLowerCase()] || 0);
      }, 0);
      const ativos = (planos || []).filter(t => t.plano_status === 'ativo').length;
      const trial = (planos || []).filter(t => t.plano_status === 'trial').length;
      const suspensos = (planos || []).filter(t => t.plano_status === 'suspenso').length;
      return ok(res, { data: { totalTenants, totalLeads, totalUsuarios, mrr, ativos, trial, suspensos } });
    }

    // 16.3 — Suspender/reativar tenant
    if (path.match(/^\/superadmin\/tenants\/[\w-]+\/status$/) && method === 'PUT') {
      const tid = path.split('/')[3];
      const { status } = body;
      if (!['ativo', 'suspenso', 'cancelado'].includes(status)) return err(res, 'Status inválido');
      await sb.from('tenants').update({ plano_status: status }).eq('id', tid);
      return ok(res, { data: { atualizado: true } });
    }

    // 16.4 — Ver detalhe de um tenant
    if (path.match(/^\/superadmin\/tenants\/[\w-]+$/) && method === 'GET') {
      const tid = path.split('/')[3];
      const { data: tenant } = await sb.from('tenants').select('*').eq('id', tid).maybeSingle();
      const { data: usuarios } = await sb.from('crm_usuarios').select('id,nome,email,papel,status,ultimo_acesso').eq('tenant_id', tid);
      const { data: apiKeys } = await sb.from('api_keys').select('id,nome,ativo,created_at,ultimo_uso').eq('tenant_id', tid);
      return ok(res, { data: { tenant, usuarios, apiKeys } });
    }

    // 16.5 — Criar usuário superadmin
    if (path === '/superadmin/criar' && method === 'POST') {
      const { email, senha, nome, tenantId } = body;
      if (!email || !senha || !tenantId) return err(res, 'email, senha e tenantId obrigatórios');
      const id = crypto.randomUUID();
      await sb.from('crm_usuarios').insert({
        id, tenant_id: tenantId, email: email.toLowerCase(),
        nome: nome || 'Super Admin', senha_hash: hashPassword(senha),
        papel: 'superadmin', status: 'ativo'
      });
      return ok(res, { data: { id, criado: true } }, 201);
    }

    // 16.6 — Criar tenant completo (super-admin)
    if (path === '/tenant/criar' && method === 'POST' && papel === 'superadmin') {
      const { nome, slug, plano, adminNome, adminEmail, adminSenha } = body;
      if (!nome || !slug || !adminEmail || !adminSenha) return err(res, 'Campos obrigatórios: nome, slug, adminEmail, adminSenha');
      // Verificar slug único
      const { data: existing } = await sb.from('tenants').select('id').eq('slug', slug).maybeSingle();
      if (existing) return err(res, 'Slug já em uso. Escolha outro.');
      const tenantId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const trialFim = new Date(Date.now() + 14 * 86400000).toISOString();
      await sb.from('tenants').insert({
        id: tenantId, nome, slug, plano: plano || 'free',
        plano_status: plano && plano !== 'free' ? 'ativo' : 'trial',
        trial_fim: trialFim
      });
      await sb.from('crm_usuarios').insert({
        id: userId, tenant_id: tenantId,
        email: adminEmail.toLowerCase(), nome: adminNome || nome,
        senha_hash: hashPassword(adminSenha), papel: 'admin', status: 'ativo'
      });
      return ok(res, { data: { tenantId, userId, slug, msg: 'Cliente criado! Login: ' + adminEmail } }, 201);
    }


    // ═══════════════════════════════════════
    // 17. INTEGRAÇÃO IA LICITA → IACRM
    // Recebe eventos do IA Licita e sincroniza
    // ═══════════════════════════════════════

    // 17.1 — Sincronizar lead capturado pelos agentes IA do IA Licita
    if (path === '/ialicita/lead' && method === 'POST') {
      const { nome_empresa, email, whatsapp, cidade, uf, segmento, origem, plano_interesse, tipo_agente, dados_extra } = body;
      if (!nome_empresa) return err(res, 'nome_empresa obrigatório');

      // Verificar se lead já existe neste tenant
      const { data: existing } = await sb.from('leads')
        .select('id,status').eq('tenant_id', tenantId).eq('email', email || '').limit(1);

      let leadId;
      if (existing?.length) {
        // Atualizar lead existente com novos dados
        leadId = existing[0].id;
        await sb.from('leads').update({
          whatsapp: whatsapp || undefined,
          dados_extra: { ...dados_extra, plano_interesse, tipo_agente, origem_ialicita: true },
          updated_at: new Date().toISOString()
        }).eq('id', leadId).eq('tenant_id', tenantId);
      } else {
        // Criar novo lead
        leadId = crypto.randomUUID();
        await sb.from('leads').insert({
          id: leadId, tenant_id: tenantId,
          nome_empresa, email: email || '', whatsapp: whatsapp || '',
          cidade: cidade || '', uf: uf || '', segmento: segmento || 'licitacoes',
          origem: origem || 'ialicita', status: 'novo',
          tags: ['ialicita', tipo_agente || 'agente'].filter(Boolean),
          dados_extra: { ...dados_extra, plano_interesse, tipo_agente, origem_ialicita: true }
        });
        await dispararWebhook(tenantId, 'lead.novo', { id: leadId, nome_empresa, email, whatsapp, origem: 'ialicita' });
      }

      return ok(res, { data: { leadId, criado: !existing?.length } }, 201);
    }

    // 17.2 — Confirmar conversão (cliente pagou no IA Licita)
    if (path === '/ialicita/conversao' && method === 'POST') {
      const { email, nome_empresa, plano, valor_mensal, lead_id_crm } = body;
      if (!email && !lead_id_crm) return err(res, 'email ou lead_id_crm obrigatório');

      // Buscar lead no CRM
      let leadRow = null;
      if (lead_id_crm) {
        const { data } = await sb.from('leads').select('*').eq('id', lead_id_crm).eq('tenant_id', tenantId).maybeSingle();
        leadRow = data;
      } else if (email) {
        const { data } = await sb.from('leads').select('*').eq('email', email).eq('tenant_id', tenantId).maybeSingle();
        leadRow = data;
      }

      // Criar/atualizar cliente
      const clienteId = crypto.randomUUID();
      const { data: existingCli } = await sb.from('clientes').select('id').eq('email', email || '').eq('tenant_id', tenantId).maybeSingle();

      if (existingCli) {
        await sb.from('clientes').update({
          plano: plano || '', valor_mensal: valor_mensal || 0, status: 'ativo',
          dados_extra: { origem_ialicita: true, plano_ialicita: plano }
        }).eq('id', existingCli.id).eq('tenant_id', tenantId);
      } else {
        await sb.from('clientes').insert({
          id: clienteId, tenant_id: tenantId,
          nome_empresa: nome_empresa || leadRow?.nome_empresa || '',
          email: email || '', whatsapp: leadRow?.whatsapp || '',
          plano: plano || '', valor_mensal: valor_mensal || 0, status: 'ativo',
          lead_id: leadRow?.id || null,
          tags: ['ialicita'], dados_extra: { origem_ialicita: true, plano_ialicita: plano }
        });
      }

      // Marcar lead como convertido
      if (leadRow) {
        await sb.from('leads').update({ status: 'convertido' }).eq('id', leadRow.id).eq('tenant_id', tenantId);
        await dispararWebhook(tenantId, 'lead.convertido', { id: leadRow.id, email, plano });
      }

      return ok(res, { data: { convertido: true, clienteId: existingCli?.id || clienteId } });
    }

    // 17.3 — Webhook do IA Licita → CRM (receber eventos do IA Licita)
    // Esta rota NÃO exige auth — valida via X-IaLicita-Secret
    // (mas está dentro do bloco autenticado pois é por API Key do tenant)
    if (path === '/ialicita/webhook' && method === 'POST') {
      const { evento, dados } = body;
      if (!evento) return err(res, 'evento obrigatório');

      if (evento === 'lead.capturado') {
        // Re-disparar como lead.novo no CRM
        const r = await fetch(`https://${req.headers.host}/api/crm/ialicita/lead`, {
          method: 'POST',
          headers: { 'Authorization': req.headers['authorization'], 'Content-Type': 'application/json' },
          body: JSON.stringify(dados)
        });
        const d = await r.json();
        return ok(res, { data: { processado: true, resultado: d.data } });
      }

      if (evento === 'pagamento.confirmado') {
        const r = await fetch(`https://${req.headers.host}/api/crm/ialicita/conversao`, {
          method: 'POST',
          headers: { 'Authorization': req.headers['authorization'], 'Content-Type': 'application/json' },
          body: JSON.stringify(dados)
        });
        const d = await r.json();
        return ok(res, { data: { processado: true, resultado: d.data } });
      }

      // Outros eventos: apenas logar
      await sb.from('webhook_logs').insert({
        id: crypto.randomUUID(), tenant_id: tenantId,
        evento: 'ialicita.' + evento, payload: body,
        status_code: 200, response: 'logged'
      });
      return ok(res, { data: { processado: true, evento } });
    }

    // 17.4 — Buscar token de API Key do tenant (para configurar no IA Licita)
    if (path === '/ialicita/config' && method === 'GET') {
      const { data: keys } = await sb.from('api_keys')
        .select('id,nome,chave,ativo,created_at')
        .eq('tenant_id', tenantId).eq('ativo', true)
        .order('created_at', { ascending: false });
      const { data: tenant } = await sb.from('tenants').select('nome,webhook_url').eq('id', tenantId).maybeSingle();
      return ok(res, { data: {
        tenant: tenant?.nome,
        apiKeys: (keys || []).map(k => ({ id: k.id, nome: k.nome, chave: k.chave.substring(0, 12) + '...', ativo: k.ativo })),
        webhookUrl: `https://zapcrm-pi.vercel.app/api/crm/ialicita/webhook`,
        instrucoes: 'Configure IACRM_API_KEY e IACRM_TENANT_ID nas variáveis de ambiente do IA Licita'
      }});
    }

    // ═══════════════════════════════════════
    // 404
    // ═══════════════════════════════════════
    if (path === '/cron/jornadas' && (method === 'POST' || method === 'GET')) {
      const sec = req.headers['x-cron-secret'];
      if (req.headers['x-vercel-cron'] !== '1' && sec !== (process.env.CRON_SECRET||'cron_iacrm_2025')) return res.status(401).json({ error: 'nao autorizado' });
      const { data: execs } = await sb.from('jornada_execucoes').select('*, crm_jornadas(passos), leads(email,whatsapp,nome_empresa)').eq('status','ativa').lte('proximo_disparo', new Date().toISOString()).not('proximo_disparo','is',null);
      let n = 0;
      for (const ex of (execs||[])) {
        try {
          const passos = ex.crm_jornadas?.passos||[];
          const p = passos[ex.etapa_atual];
          if (!p) { await sb.from('jornada_execucoes').update({status:'concluida'}).eq('id',ex.id); continue; }
          const msg = (p.conteudo||p.mensagem||'').replace('{nome}', ex.leads?.nome_empresa||'');
          if (p.canal==='whatsapp' && ex.leads?.whatsapp) await sendWhatsApp(ex.leads.whatsapp, msg, ex.tenant_id);
          if (p.canal==='email' && ex.leads?.email) await sendEmail(ex.leads.email, p.assunto||'Mensagem', msg, ex.tenant_id);
          const prox = ex.etapa_atual+1;
          const p2 = passos[prox];
          await sb.from('jornada_execucoes').update({ etapa_atual: prox, status: p2?'ativa':'concluida', proximo_disparo: p2 ? new Date(Date.now()+(p2.intervalo_horas||24)*3600000).toISOString() : null }).eq('id',ex.id);
          n++;
        } catch(e) { console.error('[CRON]',e.message); }
      }
      return res.status(200).json({ ok:true, executadas:n });
    }

        return err(res, `Rota não encontrada: ${method} ${path}`, 404);

  } catch (e) {
    console.error('CRM Error:', e);
    return err(res, 'Erro interno: ' + e.message, 500);
  }
}
