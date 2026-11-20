-- ═══════════════════════════════════════════════════════
-- iaCRM — banco completo, num schema próprio ("iacrm")
-- Pode rodar num projeto Supabase que já tem outro sistema (ex.: Plano Certo ou IA Licita):
-- as tabelas ficam separadas em "iacrm" e nada do schema "public" é alterado.
-- Depois de rodar: Supabase → Project Settings → Data API → Exposed schemas → adicione "iacrm".
-- Na Vercel: SUPABASE_SCHEMA=iacrm (e SUPABASE_URL / SUPABASE_SERVICE_KEY desse projeto).
-- ═══════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS iacrm;
SET search_path TO iacrm, public, extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 2. TENANTS (empresas que usam o CRM)
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  email_admin TEXT NOT NULL,
  plano TEXT NOT NULL DEFAULT 'free' CHECK (plano IN ('free','starter','pro','enterprise')),
  plano_status TEXT DEFAULT 'trial' CHECK (plano_status IN ('trial','ativo','suspenso','cancelado')),
  trial_fim TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
  -- WhatsApp Config
  whatsapp_phone_id TEXT,
  whatsapp_token TEXT,
  whatsapp_waba_id TEXT,
  whatsapp_webhook_token TEXT DEFAULT encode(gen_random_bytes(16), 'hex'),
  -- IA Config
  gemini_api_key TEXT,
  -- Email Config
  resend_api_key TEXT,
  email_remetente TEXT,
  -- Branding
  logo_url TEXT,
  cor_primaria TEXT DEFAULT '#066807',
  cor_secundaria TEXT DEFAULT '#e7ab25',
  -- API
  api_key TEXT UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  api_rate_limit INT DEFAULT 1000,
  -- Webhooks
  webhook_url TEXT,
  webhook_secret TEXT DEFAULT encode(gen_random_bytes(16), 'hex'),
  webhook_eventos TEXT[] DEFAULT '{}',
  -- Limites do plano
  limite_contatos INT DEFAULT 100,
  limite_conteudo_mes INT DEFAULT 10,
  limite_usuarios INT DEFAULT 1,
  -- Meta
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'ativo'
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_api_key ON tenants(api_key);

-- 3. USUÁRIOS DO CRM (admins/operadores de cada tenant)
CREATE TABLE IF NOT EXISTS crm_usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  senha_hash TEXT NOT NULL,
  nome TEXT NOT NULL,
  papel TEXT DEFAULT 'admin' CHECK (papel IN ('admin','operador','viewer')),
  avatar_url TEXT,
  ultimo_acesso TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'ativo',
  UNIQUE(tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_crm_usuarios_tenant ON crm_usuarios(tenant_id);
CREATE INDEX IF NOT EXISTS idx_crm_usuarios_email ON crm_usuarios(email);

-- 4. LEADS
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome_empresa TEXT NOT NULL,
  email TEXT,
  whatsapp TEXT,
  telefone TEXT,
  cidade TEXT,
  uf TEXT,
  segmento TEXT,
  origem TEXT DEFAULT 'manual',
  score_comportamento INT DEFAULT 0,
  status TEXT DEFAULT 'novo' CHECK (status IN ('novo','contatado','qualificado','convertido','perdido')),
  responsavel_id UUID REFERENCES crm_usuarios(id),
  tags TEXT[] DEFAULT '{}',
  notas TEXT,
  dados_extra JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(tenant_id, created_at DESC);

-- 5. CLIENTES
CREATE TABLE IF NOT EXISTS clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id),
  nome_empresa TEXT NOT NULL,
  email TEXT,
  whatsapp TEXT,
  telefone TEXT,
  cnpj TEXT,
  cidade TEXT,
  uf TEXT,
  plano TEXT,
  valor_mensal DECIMAL(12,2) DEFAULT 0,
  status TEXT DEFAULT 'ativo' CHECK (status IN ('ativo','inativo','inadimplente','cancelado')),
  data_inicio TIMESTAMPTZ DEFAULT NOW(),
  responsavel_id UUID REFERENCES crm_usuarios(id),
  tags TEXT[] DEFAULT '{}',
  notas TEXT,
  dados_extra JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clientes_tenant ON clientes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_clientes_status ON clientes(tenant_id, status);

-- 6. PIPELINE
CREATE TABLE IF NOT EXISTS pipeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id),
  cliente_id UUID REFERENCES clientes(id),
  titulo TEXT NOT NULL,
  descricao TEXT,
  valor DECIMAL(12,2) DEFAULT 0,
  etapa TEXT DEFAULT 'prospeccao' CHECK (etapa IN ('prospeccao','qualificacao','proposta','negociacao','fechado_ganho','fechado_perdido')),
  probabilidade INT DEFAULT 0,
  responsavel_id UUID REFERENCES crm_usuarios(id),
  data_previsao TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_tenant ON pipeline(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_etapa ON pipeline(tenant_id, etapa);

-- 7. WHATSAPP CONTATOS
CREATE TABLE IF NOT EXISTS whatsapp_contatos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  telefone TEXT NOT NULL,
  nome TEXT DEFAULT '',
  empresa TEXT DEFAULT '',
  etiqueta TEXT DEFAULT 'novo' CHECK (etiqueta IN ('novo','lead','cliente','vip','bloqueado')),
  notas TEXT DEFAULT '',
  nao_lidas INT DEFAULT 0,
  ultima_msg TIMESTAMPTZ DEFAULT NOW(),
  ultima_msg_texto TEXT DEFAULT '',
  lead_id UUID REFERENCES leads(id),
  cliente_id UUID REFERENCES clientes(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, telefone)
);

CREATE INDEX IF NOT EXISTS idx_wa_contatos_tenant ON whatsapp_contatos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wa_contatos_telefone ON whatsapp_contatos(tenant_id, telefone);
CREATE INDEX IF NOT EXISTS idx_wa_contatos_ultima ON whatsapp_contatos(tenant_id, ultima_msg DESC);

-- 8. WHATSAPP MENSAGENS
CREATE TABLE IF NOT EXISTS whatsapp_mensagens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contato_id UUID NOT NULL REFERENCES whatsapp_contatos(id) ON DELETE CASCADE,
  direcao TEXT NOT NULL CHECK (direcao IN ('enviada','recebida')),
  tipo TEXT DEFAULT 'texto',
  conteudo TEXT DEFAULT '',
  template_nome TEXT,
  wamid TEXT,
  status TEXT DEFAULT 'enviada',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_msgs_contato ON whatsapp_mensagens(contato_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wa_msgs_tenant ON whatsapp_mensagens(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_msgs_wamid ON whatsapp_mensagens(wamid);

-- 9. CONTEÚDO IA
CREATE TABLE IF NOT EXISTS conteudo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plataforma TEXT NOT NULL CHECK (plataforma IN ('instagram','linkedin','blog','email','twitter','facebook','tiktok')),
  tipo TEXT DEFAULT 'post',
  titulo TEXT,
  corpo TEXT NOT NULL,
  hashtags TEXT,
  imagem_url TEXT,
  imagem_prompt TEXT,
  tom TEXT DEFAULT 'profissional',
  status TEXT DEFAULT 'rascunho' CHECK (status IN ('rascunho','agendado','publicado','arquivado')),
  agendado_para TIMESTAMPTZ,
  publicado_em TIMESTAMPTZ,
  metricas JSONB DEFAULT '{}',
  criado_por UUID REFERENCES crm_usuarios(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conteudo_tenant ON conteudo(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conteudo_status ON conteudo(tenant_id, status);

-- 10. JORNADAS CRM
CREATE TABLE IF NOT EXISTS crm_jornadas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  nome TEXT,
  lead_id UUID REFERENCES leads(id),
  cliente_id UUID REFERENCES clientes(id),
  email TEXT,
  whatsapp TEXT,
  status TEXT DEFAULT 'ativa' CHECK (status IN ('ativa','pausada','concluida','cancelada')),
  dia_atual INT DEFAULT 0,
  proximo_disparo TIMESTAMPTZ,
  passos JSONB DEFAULT '[]',
  historico JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jornadas_tenant ON crm_jornadas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_jornadas_status ON crm_jornadas(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_jornadas_proximo ON crm_jornadas(proximo_disparo) WHERE status = 'ativa';

-- 11. CAMPANHAS
CREATE TABLE IF NOT EXISTS campanhas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  tipo TEXT DEFAULT 'email' CHECK (tipo IN ('email','whatsapp','sms','multi')),
  status TEXT DEFAULT 'rascunho' CHECK (status IN ('rascunho','agendada','enviando','concluida','cancelada')),
  segmento JSONB DEFAULT '{}',
  template_id TEXT,
  conteudo TEXT,
  agendado_para TIMESTAMPTZ,
  total_destinatarios INT DEFAULT 0,
  total_enviados INT DEFAULT 0,
  total_abertos INT DEFAULT 0,
  total_clicados INT DEFAULT 0,
  criado_por UUID REFERENCES crm_usuarios(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campanhas_tenant ON campanhas(tenant_id);

-- 12. AUTOMAÇÕES
CREATE TABLE IF NOT EXISTS automacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id),
  nome_empresa TEXT,
  cidade TEXT,
  whatsapp TEXT,
  status TEXT DEFAULT 'ativa' CHECK (status IN ('ativa','pausada','concluida')),
  dia_atual INT DEFAULT 0,
  proximo_disparo TIMESTAMPTZ,
  regua JSONB DEFAULT '[]',
  historico JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automacoes_tenant ON automacoes(tenant_id);

-- 13. NPS
CREATE TABLE IF NOT EXISTS nps_campanhas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  pergunta TEXT DEFAULT 'De 0 a 10, quanto você recomendaria nosso serviço?',
  status TEXT DEFAULT 'ativa',
  total_respostas INT DEFAULT 0,
  nps_score DECIMAL(5,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nps_respostas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campanha_id UUID REFERENCES nps_campanhas(id) ON DELETE CASCADE,
  cliente_id UUID REFERENCES clientes(id),
  nome TEXT,
  email TEXT,
  nota INT CHECK (nota >= 0 AND nota <= 10),
  comentario TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nps_campanhas_tenant ON nps_campanhas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_nps_respostas_tenant ON nps_respostas(tenant_id);

-- 14. PUSH NOTIFICATIONS
CREATE TABLE IF NOT EXISTS push_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  tipo TEXT DEFAULT 'info',
  destinatarios JSONB DEFAULT '[]',
  enviado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 15. INTEGRAÇÕES
CREATE TABLE IF NOT EXISTS integracoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plataforma TEXT NOT NULL,
  nome TEXT,
  icone TEXT,
  config JSONB DEFAULT '{}',
  status TEXT DEFAULT 'desconectado',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integracoes_tenant ON integracoes(tenant_id);

-- 16. CALENDÁRIO
CREATE TABLE IF NOT EXISTS calendario (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  descricao TEXT,
  data_inicio TIMESTAMPTZ NOT NULL,
  data_fim TIMESTAMPTZ,
  tipo TEXT DEFAULT 'tarefa',
  lead_id UUID REFERENCES leads(id),
  cliente_id UUID REFERENCES clientes(id),
  responsavel_id UUID REFERENCES crm_usuarios(id),
  status TEXT DEFAULT 'pendente',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendario_tenant ON calendario(tenant_id);

-- 17. WEBHOOK LOGS
CREATE TABLE IF NOT EXISTS webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  evento TEXT NOT NULL,
  payload JSONB,
  status_code INT,
  response TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_tenant ON webhook_logs(tenant_id, created_at DESC);

-- 18. API KEYS (múltiplas por tenant)
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  chave TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  scopes TEXT[] DEFAULT '{read,write}',
  ultimo_uso TIMESTAMPTZ,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_chave ON api_keys(chave) WHERE ativo = true;

-- 19. PAGAMENTOS DO CRM
CREATE TABLE IF NOT EXISTS crm_pagamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plano TEXT NOT NULL,
  valor DECIMAL(12,2) NOT NULL,
  status TEXT DEFAULT 'pendente' CHECK (status IN ('pendente','confirmado','cancelado')),
  metodo TEXT DEFAULT 'pix',
  pix_copia_cola TEXT,
  confirmado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_pagamentos_tenant ON crm_pagamentos(tenant_id);


-- ═══ Tabelas e colunas que o código usa e faltavam no schema original ═══
ALTER TABLE crm_usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT;
ALTER TABLE crm_usuarios ADD COLUMN IF NOT EXISTS reset_token_expira TIMESTAMPTZ;
ALTER TABLE crm_usuarios ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE crm_jornadas ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS visitor_id TEXT;
ALTER TABLE whatsapp_contatos ADD COLUMN IF NOT EXISTS status_atendimento TEXT DEFAULT 'aguardando';
CREATE UNIQUE INDEX IF NOT EXISTS integracoes_tenant_plataforma_uk ON integracoes(tenant_id, plataforma);

CREATE TABLE IF NOT EXISTS jornada_execucoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  jornada_id UUID REFERENCES crm_jornadas(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'ativa',
  etapa_atual INTEGER DEFAULT 0,
  iniciado_em TIMESTAMPTZ DEFAULT NOW(),
  proximo_disparo TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jornada_exec_disparo ON jornada_execucoes(status, proximo_disparo);
CREATE TABLE IF NOT EXISTS sdk_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id TEXT, evento TEXT, props JSONB DEFAULT '{}', behavior JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sdk_eventos_tenant ON sdk_eventos(tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS sdk_pageviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id TEXT, pagina TEXT, titulo TEXT, behavior JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sdk_pageviews_tenant ON sdk_pageviews(tenant_id, created_at DESC);

-- ═══ Segurança ═══
-- RLS ligado e SEM políticas: só a chave service_role (usada pela API na Vercel) acessa.
-- (O schema original criava políticas "USING (true)", que deixavam qualquer um ler e alterar
--  os dados de todas as empresas pela chave pública do Supabase.)
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'iacrm' LOOP
    EXECUTE format('ALTER TABLE iacrm.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
REVOKE ALL ON SCHEMA iacrm FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA iacrm FROM anon, authenticated;
GRANT USAGE ON SCHEMA iacrm TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA iacrm TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA iacrm TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA iacrm GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA iacrm GRANT ALL ON SEQUENCES TO service_role;
