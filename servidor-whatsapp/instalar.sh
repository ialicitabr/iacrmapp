#!/usr/bin/env bash
# Instala o servidor do WhatsApp do iaCRM numa VM Ubuntu (Oracle Cloud Always Free ou outra).
# Uso:  bash instalar.sh wa.iacrmapp.com.br
set -euo pipefail
DOMINIO="${1:-}"
if [ -z "$DOMINIO" ]; then echo "Uso: bash instalar.sh SEU_SUBDOMINIO (ex.: wa.iacrmapp.com.br)"; exit 1; fi
cd "$(dirname "$0")"

echo "==> Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi

echo "==> Liberando as portas 80 e 443 no firewall interno da VM (imagens Ubuntu da Oracle bloqueiam por padrão)"
if command -v iptables >/dev/null; then
  for p in 80 443; do
    sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save; else sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null && sudo netfilter-persistent save; fi
fi

echo "==> Configuração"
if [ ! -f .env ]; then
  echo "DOMINIO=$DOMINIO" > .env
  echo "EVOLUTION_API_KEY=$(openssl rand -hex 32)" >> .env
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
  chmod 600 .env
fi

echo "==> Subindo os serviços"
sudo docker compose up -d
sleep 20
sudo docker compose ps

KEY=$(grep '^EVOLUTION_API_KEY=' .env | cut -d= -f2)
echo
echo "Pronto. Cadastre na Vercel (projeto iacrm-app → Environment Variables → Production):"
echo "  EVOLUTION_URL     = https://$DOMINIO"
echo "  EVOLUTION_API_KEY = (veja com: grep EVOLUTION_API_KEY $(pwd)/.env)"
echo
echo "Teste: curl -s https://$DOMINIO/ -H \"apikey: \$EVOLUTION_API_KEY\""
echo "(o primeiro acesso pode levar 1 minuto enquanto o certificado HTTPS é emitido)"
