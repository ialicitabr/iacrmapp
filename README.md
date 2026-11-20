# iacrmappv2

CRM SaaS multiempresa com WhatsApp, IA e automações. Vercel (função `api/crm.js`) + Supabase.

## Variáveis na Vercel (projeto `iacrm-app`)
| Variável | Obrigatória | Observação |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | sim | projeto Supabase onde está o schema do iaCRM (se o projeto estiver pausado, o cadastro mostra "sistema indisponível") |
| `SUPABASE_SCHEMA` | sim, se usar um projeto compartilhado | `iacrm` (padrão: `public`) |
| `JWT_SECRET` | **sim** | `openssl rand -hex 32`, no mínimo 32 caracteres. Sem ela, login e cadastro ficam bloqueados de propósito |
| `JWT_SECRET_ANTIGO` | só se você trocar o `JWT_SECRET` | o valor anterior, para quem ainda não entrou depois da troca conseguir logar uma vez |
| `GEMINI_API_KEY`, `RESEND_API_KEY`, `APP_URL`, `CRON_SECRET`, `WA_VERIFY_TOKEN` | conforme uso | |

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
