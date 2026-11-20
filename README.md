# iacrmapp

CRM SaaS multiempresa com WhatsApp, IA e automações. Vercel (função `api/crm.js`) + Supabase.

## Variáveis na Vercel (projeto `iacrm-app`)
| Variável | Obrigatória | Observação |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | sim | projeto IACRM no Supabase (se ele estiver pausado, o cadastro dá "fetch failed") |
| `JWT_SECRET` | **sim** | `openssl rand -hex 32`, no mínimo 32 caracteres. Sem ela, login e cadastro ficam bloqueados de propósito |
| `JWT_SECRET_ANTIGO` | só se você trocar o `JWT_SECRET` | o valor anterior, para quem ainda não entrou depois da troca conseguir logar uma vez |
| `GEMINI_API_KEY`, `RESEND_API_KEY`, `APP_URL`, `CRON_SECRET`, `WA_VERIFY_TOKEN` | conforme uso | |

## Senhas
Senhas novas usam scrypt com sal próprio (`scrypt$sal$hash`). As contas antigas (HMAC com o `JWT_SECRET`) continuam entrando e são convertidas automaticamente no próximo login.

## Deploy
`npx vercel --prod` nesta pasta, ou conecte este repositório em Vercel → iacrm-app → Settings → Git.
