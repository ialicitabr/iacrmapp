# ARQUITETURA — Separação CRM SaaS

## 1. Visão Geral

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ANTES (Monolito)                              │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    login.js (3500+ linhas)                     │  │
│  │  IA LICITA + CRM + WhatsApp + Conteúdo + Jornadas + Pipeline  │  │
│  │         Tudo junto em 1 arquivo, 1 banco, 1 deploy            │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                        DEPOIS (Separado)                             │
│                                                                      │
│  ┌─────────────────────┐    API REST     ┌───────────────────────┐  │
│  │     IA LICITA        │◄──────────────►│      CRM SaaS          │  │
│  │  (Licitações)        │   + Webhooks   │  (Produto Standalone)  │  │
│  │                      │                │                        │  │
│  │  • Radar PNCP        │                │  • Pipeline            │  │
│  │  • Análise IA        │                │  • WhatsApp CRM        │  │
│  │  • Chat Edital       │                │  • Conteúdo IA         │  │
│  │  • Proposta IA       │                │  • Jornadas CRM        │  │
│  │  • Score Preditivo   │                │  • Inteligência        │  │
│  │  • Módulo Gov        │                │  • NPS                 │  │
│  │                      │                │  • Automações          │  │
│  │  Banco: Supabase A   │                │  • Leads/Clientes      │  │
│  │  URL: ialicitaapp.   │                │  Banco: Supabase B     │  │
│  │       com.br         │                │  URL: zapcrm.com.br    │  │
│  └─────────────────────┘                └───────────────────────┘  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                  Outros Clientes Futuros                      │    │
│  │  Clínicas, Agências, Lojas, Consultorias, Imobiliárias...    │    │
│  │  Todos usam o mesmo CRM SaaS via frontend próprio ou API     │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

## 2. Classificação de Rotas

### Rotas que VÃO para o CRM SaaS (62 rotas)

| Módulo | Rotas | Descrição |
|--------|-------|-----------|
| **Auth CRM** | crm.login, crm.logout, crm.me, crm.criarUsuario, crm.atualizarUsuario, crm.listarUsuarios, crm.removerUsuario | Autenticação do painel admin |
| **Leads** | crm.capturarLead, crm.listarLeads, crm.atualizarLead, crm.estatisticas, crm.insights | Gestão de leads |
| **Clientes** | crm.listarClientes, crm.salvarCliente, crm.removerCliente, clientes.estatisticas | Gestão de clientes |
| **Pipeline** | pipeline.listar, pipeline.adicionar, pipeline.mover, pipeline.remover | Funil de vendas |
| **WhatsApp** | whatsapp.* (14 rotas) | Inbox, templates, envio, webhook, disparo |
| **Conteúdo IA** | conteudo.gerarIA, conteudo.gerarLote, conteudo.salvar, conteudo.remover, conteudo.agendar, conteudo.dashboard, conteudo.sugerirTema, crm.listarConteudo | Geração de conteúdo |
| **Jornadas** | crm.iniciarJornada, crm.executarJornada, crm.listarJornadas, crm.jornadasDisponiveis, crm.criarCampanha, crm.listarCampanhas, crm.regenerarMensagem | Automação de jornadas |
| **Automações** | auto.listar, auto.ativar, auto.pausar, auto.gerarMsg, auto.regua | Réguas de automação |
| **NPS** | nps.criar, nps.listar, nps.registrar, nps.dashboard, nps.remover, nps.enviarTodos | Pesquisa de satisfação |
| **Push** | push.criar, push.listar, push.remover | Notificações push |
| **Integrações** | integracoes.salvar, crm.listarIntegracoes | Conectores externos |
| **Calendário** | calendario.listar, calendario.salvar, calendario.sugerir | Agenda |
| **Ads** | ad.listar, ad.distribuir | Distribuição de anúncios |

### Rotas que FICAM no IA LICITA (70 rotas)

| Módulo | Rotas |
|--------|-------|
| **Auth Empresa** | auth.login, auth.signup, auth.logout, auth.me, auth.esqueciSenha, auth.resetPassword |
| **Empresa** | empresa.dados, empresa.atualizar |
| **PNCP/Radar** | pncp.buscarOportunidades, lookup.segmentos, lookup.categoriasPncp |
| **IA Licitação** | ia.analisarEdital, ia.gerarProposta, ia.propostaPDF, ia.chatClear, ia.teste |
| **Score** | score.preditivo, score.estatisticas |
| **Documentos** | docs.list, docs.upsert, docs.delete, docs.analisar, docs.iaContador |
| **Resultados** | resultado.registrar |
| **Tokens** | tokens.saldo, tokens.historico, tokens.recarregar |
| **Planos/Pagamentos** | planos.listar, planos.alterar, pagamento.confirmar, pagamento.listar, pagamento.verificar |
| **Equipe** | equipe.* (5 rotas) |
| **Financeiro Admin** | admin.financeiro |
| **Afiliados** | afiliado.* (8 rotas) |
| **Governo** | gov.* (12 rotas) |

## 3. Stack Técnica do CRM SaaS

```
┌──────────────────────────────────────────────────┐
│                  CRM SaaS Stack                   │
├──────────────────────────────────────────────────┤
│  Frontend:  admin.html (painel) + app.html (embed)│
│  Framework: Alpine.js + Tailwind (manter padrão)  │
│  Backend:   api/crm.js (Vercel Serverless)        │
│  Database:  Supabase (PostgreSQL) — NOVO projeto  │
│  IA:        Google Gemini 2.5 Flash               │
│  WhatsApp:  Meta Cloud API v25.0                  │
│  Email:     Resend                                │
│  Hosting:   Vercel Pro (maxDuration: 60s)         │
│  Domínio:   zapcrm.com.br (ou escolha do dono)    │
│  Auth:      JWT próprio (multi-tenant)            │
└──────────────────────────────────────────────────┘
```

## 4. Banco de Dados — Multi-Tenant

O CRM SaaS usa uma arquitetura **multi-tenant com coluna `tenant_id`** em todas as tabelas.
Cada empresa que usa o CRM tem um `tenant_id` único.

```sql
-- Tenants (empresas clientes do CRM)
tenants
  ├── id UUID PK
  ├── nome TEXT
  ├── slug TEXT UNIQUE (subdomínio)
  ├── plano TEXT (free/starter/pro/enterprise)
  ├── whatsapp_phone_id TEXT
  ├── whatsapp_token TEXT (encriptado)
  ├── whatsapp_waba_id TEXT
  ├── gemini_api_key TEXT (ou usa a do SaaS)
  ├── resend_api_key TEXT
  ├── logo_url TEXT
  ├── cor_primaria TEXT
  ├── config JSONB
  ├── created_at TIMESTAMPTZ
  └── status TEXT (ativo/suspenso/trial)

-- Usuários do CRM (admins de cada tenant)
crm_usuarios
  ├── id UUID PK
  ├── tenant_id UUID FK → tenants
  ├── email TEXT
  ├── senha_hash TEXT
  ├── nome TEXT
  ├── papel TEXT (admin/operador/viewer)
  ├── ultimo_acesso TIMESTAMPTZ
  └── status TEXT

-- Leads
leads
  ├── id UUID PK
  ├── tenant_id UUID FK → tenants
  ├── nome_empresa TEXT
  ├── email TEXT
  ├── whatsapp TEXT
  ├── cidade TEXT
  ├── uf TEXT
  ├── score_comportamento INT
  ├── status TEXT (novo/contatado/qualificado/convertido/perdido)
  ├── origem TEXT
  ├── notas TEXT
  └── created_at TIMESTAMPTZ

-- Clientes
clientes
  ├── id UUID PK
  ├── tenant_id UUID FK → tenants
  ├── nome_empresa TEXT
  ├── email TEXT
  ├── whatsapp TEXT
  ├── plano TEXT
  ├── status TEXT
  ├── valor_mensal DECIMAL
  └── created_at TIMESTAMPTZ

-- Pipeline
pipeline
  ├── id UUID PK
  ├── tenant_id UUID FK → tenants
  ├── lead_id UUID FK
  ├── titulo TEXT
  ├── valor DECIMAL
  ├── etapa TEXT (prospeccao/qualificacao/proposta/negociacao/fechado)
  ├── responsavel_id UUID FK
  └── created_at TIMESTAMPTZ

-- WhatsApp Contatos
whatsapp_contatos
  ├── id UUID PK
  ├── tenant_id UUID FK → tenants
  ├── telefone TEXT
  ├── nome TEXT
  ├── empresa TEXT
  ├── etiqueta TEXT
  ├── notas TEXT
  ├── nao_lidas INT
  ├── ultima_msg TIMESTAMPTZ
  └── ultima_msg_texto TEXT

-- WhatsApp Mensagens
whatsapp_mensagens
  ├── id UUID PK
  ├── tenant_id UUID FK → tenants
  ├── contato_id UUID FK
  ├── direcao TEXT (enviada/recebida)
  ├── tipo TEXT
  ├── conteudo TEXT
  ├── template_nome TEXT
  ├── wamid TEXT
  ├── status TEXT
  └── created_at TIMESTAMPTZ

-- Conteúdo IA
conteudo
  ├── id UUID PK
  ├── tenant_id UUID FK → tenants
  ├── plataforma TEXT (instagram/linkedin/blog/email)
  ├── tipo TEXT (post/story/artigo/newsletter)
  ├── titulo TEXT
  ├── corpo TEXT
  ├── hashtags TEXT
  ├── imagem_url TEXT
  ├── status TEXT (rascunho/agendado/publicado)
  ├── agendado_para TIMESTAMPTZ
  └── created_at TIMESTAMPTZ

-- Jornadas CRM
crm_jornadas
  ├── id UUID PK
  ├── tenant_id UUID FK → tenants
  ├── tipo TEXT
  ├── cliente_id UUID
  ├── email TEXT
  ├── whatsapp TEXT
  ├── status TEXT
  ├── dia_atual INT
  ├── passos JSONB
  └── created_at TIMESTAMPTZ

-- NPS
nps_campanhas / nps_respostas (com tenant_id)

-- Automações
automacoes (com tenant_id)

-- Integrações por tenant
integracoes
  ├── id UUID PK
  ├── tenant_id UUID FK
  ├── plataforma TEXT
  ├── config JSONB (tokens, IDs)
  ├── status TEXT
  └── created_at TIMESTAMPTZ
```

**Índice em TODAS as tabelas:** `CREATE INDEX idx_{tabela}_tenant ON {tabela}(tenant_id);`

## 5. API de Integração (como IA LICITA se conecta)

O CRM SaaS expõe uma API REST pública com autenticação via API Key.

```
Base URL: https://api.zapcrm.com.br/v1

Headers obrigatórios:
  Authorization: Bearer {API_KEY}
  X-Tenant-ID: {TENANT_ID}
  Content-Type: application/json
```

### Endpoints Principais

```
POST /v1/leads              → Criar lead
GET  /v1/leads              → Listar leads
PUT  /v1/leads/:id          → Atualizar lead
POST /v1/pipeline           → Adicionar ao pipeline
GET  /v1/pipeline            → Listar pipeline
POST /v1/whatsapp/send      → Enviar mensagem
POST /v1/whatsapp/template  → Enviar template
GET  /v1/whatsapp/contacts  → Listar contatos
POST /v1/jornadas/iniciar   → Iniciar jornada
POST /v1/conteudo/gerar     → Gerar conteúdo IA
GET  /v1/dashboard           → KPIs do CRM
POST /v1/webhooks           → Registrar webhook
```

### Webhooks (CRM → IA LICITA)

O CRM notifica o IA LICITA via webhook quando:

```json
{
  "evento": "lead.novo",
  "dados": { "id": "...", "nome": "...", "email": "..." },
  "timestamp": "2026-04-14T10:00:00Z"
}
```

Eventos disponíveis:
- lead.novo, lead.atualizado, lead.convertido
- whatsapp.mensagem_recebida
- pipeline.movido, pipeline.fechado
- jornada.concluida
- nps.respondido

### Exemplo: IA LICITA usando o CRM

```javascript
// No IA LICITA, quando uma empresa analisa um edital:
async function sincronizarComCRM(empresa, edital) {
  await fetch('https://api.zapcrm.com.br/v1/pipeline', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + empresa.crm_api_key,
      'X-Tenant-ID': empresa.crm_tenant_id,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      titulo: edital.objeto,
      valor: edital.valor,
      etapa: 'prospeccao',
      metadata: { edital_id: edital.id, pncp: edital.numeroPncp }
    })
  });
}
```

## 6. Estrutura de Arquivos do CRM SaaS

```
zapcrm/
├── vercel.json
├── package.json
├── api/
│   ├── crm.js                  ← Backend principal (serverless)
│   ├── webhook/
│   │   └── whatsapp.js         ← Webhook WhatsApp (endpoint separado)
│   └── v1/
│       └── index.js            ← API pública REST (para integrações)
├── admin.html                   ← Painel CRM (admin)
├── app.html                     ← Painel CRM (embed/cliente)
├── login.html                   ← Tela de login
├── landing.html                 ← Landing page do produto
├── docs.html                    ← Documentação da API
├── sql/
│   ├── 001_tenants.sql
│   ├── 002_leads_clientes.sql
│   ├── 003_pipeline.sql
│   ├── 004_whatsapp.sql
│   ├── 005_conteudo.sql
│   ├── 006_jornadas.sql
│   ├── 007_nps.sql
│   └── 008_integrações.sql
└── public/
    ├── logo.svg
    └── favicon.svg
```

## 7. Plano de Migração — 5 Fases

### Fase 1: Setup (1-2 dias)
- [ ] Escolher nome e domínio do CRM
- [ ] Criar novo projeto Vercel
- [ ] Criar novo projeto Supabase
- [ ] Configurar variáveis de ambiente
- [ ] Executar SQL de criação das tabelas

### Fase 2: Backend CRM (3-5 dias)
- [ ] Criar `api/crm.js` com todas as 62 rotas do CRM
- [ ] Adicionar `tenant_id` em todas as queries
- [ ] Criar sistema de auth multi-tenant (JWT com tenant_id)
- [ ] Criar middleware de API Key para integrações
- [ ] Migrar helpers: sendWhatsApp, sendEmail, callGemini, emailTemplate
- [ ] Criar rota de webhook WhatsApp separada
- [ ] Testar cada módulo isoladamente

### Fase 3: Frontend CRM (2-3 dias)
- [ ] Criar `admin.html` standalone (extrair de IA LICITA)
- [ ] Adaptar para multi-tenant (logo, cores, nome dinâmicos)
- [ ] Criar landing page do produto
- [ ] Criar tela de onboarding (cadastro tenant)
- [ ] Criar página de documentação da API

### Fase 4: API de Integração (2-3 dias)
- [ ] Criar `api/v1/index.js` — API REST pública
- [ ] Implementar autenticação via API Key
- [ ] Implementar rate limiting
- [ ] Implementar sistema de webhooks
- [ ] Documentar todos os endpoints
- [ ] Criar SDK JavaScript simples

### Fase 5: Integrar IA LICITA (1-2 dias)
- [ ] Adicionar campo `crm_tenant_id` e `crm_api_key` na tabela `empresas`
- [ ] Criar tela "Conectar CRM" no IA LICITA
- [ ] Substituir chamadas diretas por chamadas à API do CRM
- [ ] Pipeline do IA LICITA → usa API do CRM
- [ ] Jornadas do IA LICITA → usa API do CRM
- [ ] Testar integração end-to-end

### Timeline Total: ~10-15 dias

```
Semana 1: Fases 1 + 2 (Setup + Backend)
Semana 2: Fases 3 + 4 (Frontend + API)
Semana 3: Fase 5 (Integração) + Testes + Deploy
```

## 8. Modelo de Negócio do CRM SaaS

### Planos Sugeridos

| Plano | Preço | Contatos | WhatsApp | Conteúdo IA | Usuários |
|-------|-------|----------|----------|-------------|----------|
| Free | R$ 0 | 100 | Não | 10/mês | 1 |
| Starter | R$ 97 | 1.000 | Sim | 50/mês | 3 |
| Pro | R$ 197 | 5.000 | Sim | 200/mês | 10 |
| Enterprise | R$ 497 | Ilimitado | Sim | 1.000/mês | Ilimitado |

### Diferenciais Competitivos
- WhatsApp nativo (não precisa de terceiro como Twilio)
- IA generativa para conteúdo e jornadas
- Setup em 5 minutos (sem código)
- Preço acessível para PMEs brasileiras
- API aberta para integrações
- Feito para o mercado brasileiro

## 9. Segurança Multi-Tenant

```javascript
// TODA query no CRM SaaS DEVE ter tenant_id
// Middleware obrigatório:
function getTenantId(token) {
  const decoded = verifyJWT(token);
  return decoded.tenant_id; // NUNCA aceitar tenant_id do body
}

// Exemplo de query segura:
const { data } = await sb
  .from('leads')
  .select('*')
  .eq('tenant_id', tenantId)  // SEMPRE filtrar
  .order('created_at', { ascending: false });
```

Regras:
1. tenant_id NUNCA vem do request body — sempre do JWT
2. Toda tabela tem RLS com policy por tenant_id
3. API Keys são únicas por tenant e com scope definido
4. Dados de um tenant JAMAIS são visíveis por outro
5. Backups separados por tenant (fase futura)
