# Servidor do WhatsApp por QR code (Evolution API)

O WhatsApp por QR code precisa de um servidor **sempre ligado**: ele mantém aberta uma sessão do WhatsApp Web para cada empresa.
A Vercel não serve para isso, porque as funções dela desligam a cada requisição. Tudo o que é preciso está num arquivo só: **`instalar.sh`**.

> **Aviso (repasse ao cliente):** a conexão por QR code usa o protocolo do WhatsApp Web, **não é a API oficial da Meta**. O WhatsApp pode **bloquear o número**, principalmente com envios em massa ou para quem não salvou o contato. O painel mostra esse aviso e registra o aceite.

## Google Cloud (máquina e2-micro do plano gratuito)
**Custo:** a máquina é grátis no plano "Always Free". O IP público custa cerca de **US$ 3,60/mês**, coberto pelos **US$ 300 de crédito dos primeiros 90 dias**. Quando o crédito acaba, o Google pede que você ative a cobrança; ele não cobra sozinho. Saída de dados: 1 GB/mês grátis (texto de WhatsApp gasta pouco).

### 1. Conta
1. Acesse <https://cloud.google.com/free> → **Comece gratuitamente**, com a conta Google que você usa para o iaCRM.
2. País **Brasil**, aceite os termos e informe o cartão. Ele faz só uma verificação: no período de teste não há cobrança.
3. Recomendado: **Faturamento → Orçamentos e alertas → Criar orçamento** de R$ 5, para ser avisado por e-mail de qualquer gasto.

### 2. Criar a máquina
Menu ☰ → **Compute Engine → Instâncias de VM** (na primeira vez, clique em **Ativar** a API e aguarde) → **Criar instância**:
| Campo | Valor |
|---|---|
| Nome | `whatsapp-iacrm` |
| Região | **us-east1 (Carolina do Sul)**. Só us-east1, us-central1 e us-west1 entram no plano grátis; us-east1 é a mais próxima do Brasil |
| Série / tipo de máquina | **E2** → **e2-micro** (2 vCPU, 1 GB) |
| Disco de inicialização → Alterar | **Ubuntu 24.04 LTS (x86/64)**, tipo **Disco permanente padrão**, **30 GB** |
| Rede / Firewall | marque **Permitir tráfego HTTP** e **Permitir tráfego HTTPS** |

Clique em **Criar** e aguarde 1 minuto.

### 3. Fixar o IP
Menu ☰ → **Rede VPC → Endereços IP** → na linha do IP externo da máquina → **⋮ → Promover para endereço IP estático** → nome `whatsapp-iacrm`.
Sem isso, o IP pode mudar quando a máquina reinicia. O preço é o mesmo do IP comum.
Anote o IP, por exemplo `34.123.45.67`.

### 4. Apontar o subdomínio
Onde está o DNS de `iacrmapp.com.br`, crie um registro **A**: nome **`wa`**, valor **o IP da máquina**.
- DNS na **Vercel**: Vercel → Domains → iacrmapp.com.br → DNS Records → Add → `wa`, A, IP.
- DNS no **Registro.br**: Domínio → DNS → Editar zona → Nova entrada → `wa`, A, IP.
- DNS na **Cloudflare**: DNS → Add record → `wa`, A, IP, **nuvem cinza** (sem proxy).

### 5. Instalar (cerca de 10 minutos)
1. No GitHub, abra `servidor-whatsapp/instalar.sh` → botão **Download raw file** (ícone de download) e salve no computador.
2. No Google Cloud, em **Instâncias de VM**, clique em **SSH** na linha da máquina. Abre um terminal no navegador.
3. No terminal, clique no ícone de **engrenagem/upload → Fazer upload de arquivo** e envie o `instalar.sh`.
4. Digite e tecle Enter:
   ```bash
   bash instalar.sh wa.iacrmapp.com.br
   ```
5. Ao final aparece o IP e o que cadastrar na Vercel. Para ver a chave:
   ```bash
   grep EVOLUTION_API_KEY ~/servidor-whatsapp/.env
   ```

### 6. Ligar ao iaCRM (Vercel)
Vercel → **iacrm-app** → Settings → **Environment Variables** (Production):
| Variável | Valor |
|---|---|
| `EVOLUTION_URL` | `https://wa.iacrmapp.com.br` |
| `EVOLUTION_API_KEY` | a chave do passo 5 |
| `APP_URL` | `https://iacrmapp.com.br` |

Publique (commit seu no GitHub) e conecte em **Integrações → WhatsApp → Conectar com QR code**.

## Outros servidores
O mesmo `instalar.sh` funciona em qualquer Ubuntu/Debian com IP público e portas 80/443 abertas, como Oracle Cloud ou uma VPS. Com 2 GB de memória ou mais, ele liga o Redis automaticamente.
Para migrar de servidor, instale no novo, troque o registro DNS `wa` e a `EVOLUTION_API_KEY` na Vercel, e peça aos clientes para ler o QR code de novo.

## Manutenção (no terminal SSH)
- Situação: `cd ~/servidor-whatsapp && sudo docker compose ps`
- Logs: `sudo docker compose logs -f --tail 100 evolution`
- Reiniciar: `sudo docker compose restart`
- Atualizar a Evolution: troque a versão da imagem em `instalar.sh` e rode-o de novo (as sessões e senhas são mantidas).
- A `EVOLUTION_API_KEY` dá controle total sobre todas as sessões: guarde-a só na máquina e na Vercel.
