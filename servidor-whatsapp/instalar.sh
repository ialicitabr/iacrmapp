#!/usr/bin/env bash
# Servidor do WhatsApp por QR code do iaCRM (Evolution API v2) + HTTPS automático.
# Arquivo único: gera a configuração sozinho e se ajusta à memória da máquina
# (Google Cloud e2-micro com 1 GB, Oracle, VPS…).
#
# Uso (dentro da máquina Ubuntu/Debian):   bash instalar.sh wa.iacrmapp.com.br
# Rodar de novo é seguro: mantém as senhas e as sessões do WhatsApp.
set -euo pipefail
DOMINIO="${1:-}"
if [ -z "$DOMINIO" ]; then echo "Uso: bash instalar.sh SEU_SUBDOMINIO   (ex.: bash instalar.sh wa.iacrmapp.com.br)"; exit 1; fi
DIR="$HOME/servidor-whatsapp"; mkdir -p "$DIR"; cd "$DIR"

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
echo "==> Memória da máquina: ${MEM_MB} MB"

# 1) memória de troca (swap): numa máquina de 1 GB evita que o sistema mate o servidor
if [ "$MEM_MB" -lt 2048 ] && ! swapon --show | grep -q '/swapfile'; then
  echo "==> Criando 2 GB de swap"
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-iacrm.conf >/dev/null && sudo sysctl -q -p /etc/sysctl.d/99-iacrm.conf || true
fi

# 2) Docker
if ! command -v docker >/dev/null; then
  echo "==> Instalando o Docker"
  curl -fsSL https://get.docker.com | sudo sh
fi

# 3) firewall interno (imagens Ubuntu da Oracle bloqueiam 80/443; no Google não faz diferença)
if command -v iptables >/dev/null && sudo iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  for p in 80 443; do sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT; done
  command -v netfilter-persistent >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null
  sudo netfilter-persistent save >/dev/null || true
fi

# 4) senhas (geradas uma vez e mantidas)
if [ ! -f .env ]; then
  { echo "DOMINIO=$DOMINIO"; echo "EVOLUTION_API_KEY=$(openssl rand -hex 32)"; echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"; } > .env
  chmod 600 .env
else
  sed -i "s/^DOMINIO=.*/DOMINIO=$DOMINIO/" .env
fi

# 5) perfil conforme a memória: até 2 GB → sem Redis, Postgres econômico e Node limitado
if [ "$MEM_MB" -lt 2048 ]; then
  REDIS_SVC=""; DEPENDE="[postgres]"
  CACHE="      CACHE_REDIS_ENABLED: \"false\"
      CACHE_LOCAL_ENABLED: \"true\""
  NODE_MEM="      NODE_OPTIONS: --max-old-space-size=384"
  PG_CMD='    command: ["postgres", "-c", "shared_buffers=32MB", "-c", "max_connections=40", "-c", "work_mem=2MB", "-c", "maintenance_work_mem=16MB", "-c", "effective_cache_size=128MB"]'
else
  REDIS_SVC="
  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data"
  DEPENDE="[postgres, redis]"
  CACHE="      CACHE_REDIS_ENABLED: \"true\"
      CACHE_REDIS_URI: redis://redis:6379/6
      CACHE_REDIS_PREFIX_KEY: evolution
      CACHE_LOCAL_ENABLED: \"false\""
  NODE_MEM=""
  PG_CMD=""
fi

cat > docker-compose.yml <<EOF
# Gerado por instalar.sh — não edite à mão (rode o instalar.sh de novo)
services:
  evolution:
    image: evoapicloud/evolution-api:v2.3.7
    restart: always
    depends_on: $DEPENDE
    environment:
      SERVER_TYPE: http
      SERVER_PORT: 8080
      SERVER_URL: https://\${DOMINIO}
      AUTHENTICATION_API_KEY: \${EVOLUTION_API_KEY}
      AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: "false"
      DATABASE_PROVIDER: postgresql
      DATABASE_CONNECTION_URI: postgresql://evolution:\${POSTGRES_PASSWORD}@postgres:5432/evolution?schema=public
      DATABASE_CONNECTION_CLIENT_NAME: iacrm
      DATABASE_SAVE_DATA_INSTANCE: "true"
      DATABASE_SAVE_DATA_NEW_MESSAGE: "true"
      DATABASE_SAVE_MESSAGE_UPDATE: "false"
      DATABASE_SAVE_DATA_CONTACTS: "false"
      DATABASE_SAVE_DATA_CHATS: "false"
      DATABASE_SAVE_DATA_HISTORIC: "false"
$CACHE
$NODE_MEM
      CONFIG_SESSION_PHONE_CLIENT: iaCRM
      CONFIG_SESSION_PHONE_NAME: Chrome
      QRCODE_LIMIT: "30"
      DEL_INSTANCE: "false"
      WEBHOOK_GLOBAL_ENABLED: "false"
      LANGUAGE: pt-BR
      LOG_LEVEL: ERROR,WARN
      LOG_BAILEYS: error
    volumes:
      - evolution_instances:/evolution/instances
    expose: ["8080"]

  postgres:
    image: postgres:15-alpine
    restart: always
$PG_CMD
    environment:
      POSTGRES_USER: evolution
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: evolution
    volumes:
      - postgres_data:/var/lib/postgresql/data
$REDIS_SVC

  # HTTPS automático (Let's Encrypt) para o domínio em DOMINIO
  caddy:
    image: caddy:2-alpine
    restart: always
    depends_on: [evolution]
    ports: ["80:80", "443:443"]
    environment:
      DOMINIO: \${DOMINIO}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  evolution_instances:
  postgres_data:
  redis_data:
  caddy_data:
  caddy_config:
EOF
# remove linhas vazias deixadas pelas variáveis não usadas
sed -i '/^$/N;/^\n$/D' docker-compose.yml

cat > Caddyfile <<'EOF'
{$DOMINIO} {
	encode gzip
	reverse_proxy evolution:8080
}
EOF

echo "==> Subindo os serviços (o primeiro download leva alguns minutos)"
sudo docker compose up -d --remove-orphans
sleep 25
sudo docker compose ps

IP=$(curl -fsS -4 https://ifconfig.me 2>/dev/null || echo "?")
echo
echo "============================================================"
echo " Pronto. IP público desta máquina: $IP"
echo " O registro DNS  $DOMINIO  precisa apontar (tipo A) para esse IP."
echo
echo " Cadastre na Vercel (iacrm-app → Environment Variables → Production):"
echo "   EVOLUTION_URL     = https://$DOMINIO"
echo "   EVOLUTION_API_KEY = (mostre com:  grep EVOLUTION_API_KEY $DIR/.env )"
echo "   APP_URL           = https://iacrmapp.com.br"
echo
echo " Teste (depois que o DNS propagar):  curl -s https://$DOMINIO/"
echo "============================================================"
