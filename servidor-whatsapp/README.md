# Servidor do WhatsApp por QR code (Evolution API)

O WhatsApp por QR code precisa de um servidor **sempre ligado**: ele mantém aberta uma sessão do WhatsApp Web para cada empresa.
A Vercel não serve para isso, porque as funções dela desligam a cada requisição. Este guia sobe o servidor numa **VM grátis da Oracle Cloud (Always Free)**.

> **Aviso importante (repasse ao cliente):** a conexão por QR code usa o protocolo do WhatsApp Web, **não é a API oficial da Meta**.
> O WhatsApp pode **banir o número**, principalmente com disparos em massa ou mensagens para quem não salvou o contato.
> Use para atendimento e conversas iniciadas pelo cliente. Para volume alto, use a API oficial (também disponível no iaCRM).

## 1. Criar a VM grátis (Oracle Cloud)
1. Crie a conta em <https://signup.cloud.oracle.com>. Escolha a região **Brazil East (São Paulo)**. O cartão é só para verificação: os recursos "Always Free" não são cobrados.
2. Menu → **Compute → Instances → Create instance**:
   - **Image:** Canonical **Ubuntu 24.04**.
   - **Shape:** *Ampere* → **VM.Standard.A1.Flex** com **1 OCPU e 6 GB** (dentro do Always Free).
   - **Networking:** deixe criar a VCN e marque **Assign a public IPv4 address**.
   - **SSH keys:** "Generate a key pair" → **baixe a chave privada** (você vai precisar dela).
   - **Create**. Se aparecer "Out of capacity", tente outro *Availability domain* ou repita mais tarde.
3. Abra as portas 80 e 443: na instância → **Subnet** → **Default Security List** → **Add Ingress Rules**:
   - Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination port `80`.
   - Repita para a porta `443`.
4. Copie o **Public IP address** da instância.

## 2. Apontar um subdomínio
No painel onde está o domínio `iacrmapp.com.br` (Registro.br, Cloudflare…), crie um registro **A**:
- Nome `wa`, Valor = o IP público da VM. Se usar Cloudflare, deixe a **nuvem cinza** (sem proxy).

O resultado é `wa.iacrmapp.com.br` apontando para a VM.

## 3. Instalar (5 minutos)
No seu computador, com a chave baixada (no Windows, use o PowerShell):
```bash
ssh -i caminho/da/chave.key ubuntu@IP_DA_VM
```
Já dentro da VM:
```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/ialicitabr/iacrmapp.git
cd iacrmapp/servidor-whatsapp
bash instalar.sh wa.iacrmapp.com.br
```
> O repositório é privado. Se o `git clone` pedir login, use seu usuário do GitHub e um *token* (GitHub → Settings → Developer settings → Personal access tokens), ou copie só esta pasta para a VM com `scp`.

Ao final, o script mostra o que cadastrar na Vercel. Para ver a chave gerada:
```bash
grep EVOLUTION_API_KEY ~/iacrmapp/servidor-whatsapp/.env
```

## 4. Ligar ao iaCRM (Vercel)
Vercel → projeto **iacrm-app** → Settings → **Environment Variables** (Production):
| Variável | Valor |
|---|---|
| `EVOLUTION_URL` | `https://wa.iacrmapp.com.br` |
| `EVOLUTION_API_KEY` | a chave do `.env` da VM |

Depois faça um deploy novo (um commit seu no GitHub). No painel do iaCRM: **Integrações → WhatsApp → Conectar com QR code**.

## Manutenção
- Ver se está rodando: `cd ~/iacrmapp/servidor-whatsapp && sudo docker compose ps`
- Logs: `sudo docker compose logs -f evolution`
- Atualizar a Evolution: troque a versão da imagem em `docker-compose.yml` e rode `sudo docker compose up -d`
- As sessões do WhatsApp ficam no volume `evolution_instances`. Se a VM for apagada, os clientes precisam ler o QR de novo.
- A chave `EVOLUTION_API_KEY` dá controle total sobre todas as sessões: guarde-a só na VM e na Vercel.
