# iacrmappv

CRM SaaS multiempresa com WhatsApp, IA e automações. Vercel (função `api/crm.js`) + Supabase.

## Variáveis na Vercel (projeto `iacrm-app`)
| Variável | Obrigatória | Observação |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | sim | projeto Supabase onde está o schema do iaCRM (se o projeto estiver pausado, o cadastro mostra "sistema indisponível") |
| `SUPABASE_SCHEMA` | sim, se usar um projeto compartilhado | `iacrm` (padrão: `public`) |
| `JWT_SECRET` | **sim** | `openssl rand -hex 32`, no mínimo 32 caracteres. Sem ela, login e cadastro ficam bloqueados de propósito |
| `JWT_SECRET_ANTIGO` | só se você trocar o `JWT_SECRET` | o valor anterior, para quem ainda não entrou depois da troca conseguir logar uma vez |
| `EVOLUTION_URL`, `EVOLUTION_API_KEY` | para o WhatsApp por QR code | servidor da pasta `servidor-whatsapp/` (ex.: `https://wa.iacrmapp.com.br`) |
| `APP_URL` | recomendada | `https://iacrmapp.com.br` (monta a URL dos webhooks do WhatsApp) |
| `WA_VERIFY_TOKEN` | opcional | token de verificação do webhook da API oficial; sem ele, cada empresa usa o próprio `whatsapp_webhook_token` |
| `GEMINI_API_KEY`, `RESEND_API_KEY`, `CRON_SECRET` | conforme uso | |

## Senhas
Senhas novas usam scrypt com sal próprio (`scrypt$sal$hash`). As contas antigas (HMAC com o `JWT_SECRET`) continuam entrando e são convertidas automaticamente no próximo login.

## Deploy
`npx vercel --prod` nesta pasta, ou conecte este repositório em Vercel → iacrm-app → Settings → Git.

## Banco sem custo extra (projeto Supabase compartilhado)
O plano grátis do Supabase permite 2 projetos ativos. O iaCRM pode morar dentro de um projeto que já existe (ex.: Plano Certo ou IA Licita), num schema próprio:
1. No projeto escolhido: SQL Editor → cole e rode `schema.sql`. Ele cria tudo no schema `iacrm`, não mexe no `public` e pode ser rodado de novo sem problema.
2. Project Settings → **Data API** → *Exposed schemas* → adicione `iacrm` → Save.
3. Vercel → iacrm-app → Environment Variables (Production): `SUPABASE_URL` e `SUPABASE_SERVICE_KEY` **desse projeto** + `SUPABASE_SCHEMA=iacrm` → Redeploy.
Como o projeto compartilhado recebe acesso todos os dias, ele não é pausado por inatividade.
Segurança: as tabelas têm RLS ligado e nenhuma política, e o papel público (`anon`) não tem acesso ao schema. Só a chave service_role, usada pela API, lê e grava.

## WhatsApp
Cada empresa escolhe em **Integrações → WhatsApp**:
- **QR code (padrão, mais fácil):** o celular lê um QR, como no WhatsApp Web. Usa a Evolution API num servidor sempre ligado. Veja `servidor-whatsapp/README.md` (VM grátis da Oracle Cloud). O painel mostra um aviso de risco de bloqueio, e o aceite fica registrado em `tenants.whatsapp_qr_aceite_em`.
- **API oficial da Meta:** Configurações → WhatsApp (phone_id + token). Depois de salvar, o painel mostra a URL do webhook e o token de verificação.

As mensagens recebidas pelos dois caminhos entram na mesma caixa de entrada, e a ARIA responde (dá para desligar). Ela para de responder quando a conversa é passada para a equipe.
