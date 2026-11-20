# GUIA DE MIGRAÇÃO — Passo a Passo

## PRÉ-REQUISITOS
- [ ] Escolher nome do CRM (ex: ZapCRM, FluxCRM, VendaCRM)
- [ ] Registrar domínio (ex: zapcrm.com.br)
- [ ] Criar conta Vercel separada (ou novo projeto no mesmo)
- [ ] Criar projeto Supabase separado

## FASE 1: SETUP INICIAL (Dia 1)

### 1.1 Criar projeto Supabase
```
1. Acesse https://supabase.com → New Project
2. Nome: zapcrm-prod
3. Região: South America (São Paulo)
4. Copie: SUPABASE_URL e SUPABASE_SERVICE_KEY
```

### 1.2 Executar SQL
```
1. No Supabase → SQL Editor
2. Cole o conteúdo de sql/schema_completo.sql
3. Execute
4. Verifique se todas as tabelas foram criadas
```

### 1.3 Criar projeto Vercel
```bash
mkdir zapcrm && cd zapcrm
# Copie os arquivos da pasta zapcrm/ entregue
npm install
npx vercel
# Siga o wizard, selecione novo projeto
```

### 1.4 Configurar variáveis de ambiente no Vercel
```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
GEMINI_API_KEY=AIza...
RESEND_API_KEY=re_...
JWT_SECRET=(gere um: openssl rand -hex 32)
```

### 1.5 Deploy inicial
```bash
npx vercel --prod
```

## FASE 2: BACKEND CRM (Dias 2-5)

### 2.1 O que já está pronto
- [x] api/v1/index.js — API pública REST
- [x] api/webhook/whatsapp.js — Webhook WhatsApp
- [ ] api/crm.js — Backend principal (extrair do login.js)

### 2.2 Extrair rotas do login.js
Copie as 62 rotas listadas na ARQUITETURA para api/crm.js,
adicionando `tenant_id` em TODAS as queries:

```javascript
// ANTES (login.js do IA LICITA):
const { data } = await sb.from('leads').select('*');

// DEPOIS (crm.js do CRM SaaS):
const { data } = await sb.from('leads').select('*')
  .eq('tenant_id', tenantId);
```

### 2.3 Adaptar autenticação
```javascript
// O JWT agora inclui tenant_id:
const token = jwt.sign({
  userId: user.id,
  tenantId: user.tenant_id,
  papel: user.papel
}, JWT_SECRET, { expiresIn: '7d' });

// Toda rota extrai o tenantId do JWT:
const decoded = jwt.verify(token, JWT_SECRET);
const tenantId = decoded.tenantId;
```

## FASE 3: FRONTEND (Dias 6-8)

### 3.1 Adaptar admin.html
- Remover abas específicas do IA LICITA (Radar, Análise IA, etc)
- Manter: Leads, Clientes, Pipeline, WhatsApp, Conteúdo, Jornadas, NPS, Financeiro
- Adicionar: tela de Settings do tenant (WhatsApp config, API Keys, Branding)
- Substituir cores/logo fixos por variáveis do tenant

### 3.2 Criar landing page
- Apresentar o CRM SaaS
- Planos e preços
- CTA para teste grátis

### 3.3 Criar onboarding
- Cadastro do tenant (nome, email, senha)
- Wizard de configuração (WhatsApp, logo, segmento)
- Tour guiado pela plataforma

## FASE 4: API DE INTEGRAÇÃO (Dias 9-10)

### 4.1 Documentação
- Criar docs.html com todos os endpoints
- Exemplos em cURL, JavaScript e Python
- Seção de autenticação e webhooks

### 4.2 Testar integração
```javascript
// Teste básico via console:
const resp = await fetch('https://zapcrm.com.br/api/v1/leads', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer SUA_API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    nome_empresa: 'Teste Corp',
    email: 'teste@teste.com',
    whatsapp: '79999290865'
  })
});
console.log(await resp.json());
```

## FASE 5: INTEGRAR IA LICITA (Dias 11-12)

### 5.1 Adicionar campos na tabela empresas (Supabase do IA LICITA)
```sql
ALTER TABLE empresas 
  ADD COLUMN crm_tenant_id UUID,
  ADD COLUMN crm_api_key TEXT;
```

### 5.2 Criar tela "Conectar CRM" no app.html
Permitir que a empresa do IA LICITA informe sua API Key do CRM

### 5.3 Substituir chamadas diretas
```javascript
// ANTES: chamava direto o banco
const { data } = await sb.from('pipeline').insert({...});

// DEPOIS: chama API do CRM
await fetch('https://zapcrm.com.br/api/v1/pipeline', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + empresa.crm_api_key },
  body: JSON.stringify({ titulo: edital.objeto, valor: edital.valor })
});
```

## CHECKLIST FINAL
- [ ] CRM SaaS funciona standalone (sem IA LICITA)
- [ ] Multi-tenant: dados isolados por tenant
- [ ] API REST funcionando com autenticação
- [ ] Webhooks disparando para URLs configuradas
- [ ] IA LICITA conecta ao CRM via API
- [ ] WhatsApp recebendo e enviando mensagens
- [ ] Templates criados e aprovados no Meta
- [ ] Conteúdo IA gerando em todas as plataformas
- [ ] Jornadas CRM executando automaticamente
- [ ] Landing page publicada
- [ ] Domínio configurado
- [ ] SSL ativo
- [ ] Primeiro tenant de teste criado
