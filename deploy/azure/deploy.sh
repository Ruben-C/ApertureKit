#!/usr/bin/env bash
# Deploys ApertureKit to a new Azure VM with HTTPS, in one command.
#
#   deploy/azure/deploy.sh <name> [location]
#
# Needs the Azure CLI, signed in (`az login`). Creates a resource group
# <name>-rg holding one Ubuntu 24.04 VM, opens ports 22, 80 and 443, and
# serves the portal at https://<name>.<location>.cloudapp.azure.com with a
# Let's Encrypt certificate. Overrides, all optional:
#
#   DOMAIN=portal.example.com   use your own name (point its DNS at the VM's IP)
#   VM_SIZE=Standard_B1s        RESOURCE_GROUP=<name>-rg
#   REPO=<git url>              BRANCH=main
#
# Remove everything again with: az group delete -n <name>-rg
set -euo pipefail

NAME=${1:?usage: deploy/azure/deploy.sh <name> [location]}
LOCATION=${2:-eastus}
if [[ ! $NAME =~ ^[a-z][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
  echo "name must be 3-63 lowercase letters, digits and hyphens, starting with a letter" >&2
  exit 1
fi

RESOURCE_GROUP=${RESOURCE_GROUP:-$NAME-rg}
VM_SIZE=${VM_SIZE:-Standard_B1s}
REPO=${REPO:-https://github.com/Ruben-C/ApertureKit.git}
BRANCH=${BRANCH:-main}
DOMAIN=${DOMAIN:-$NAME.$LOCATION.cloudapp.azure.com}
ADMIN_USER=azureuser

here=$(cd "$(dirname "$0")" && pwd)
custom_data=$(mktemp)
trap 'rm -f "$custom_data"' EXIT
sed -e "s|__DOMAIN__|$DOMAIN|" -e "s|__REPO__|$REPO|" \
    -e "s|__BRANCH__|$BRANCH|" -e "s|__ADMIN_USER__|$ADMIN_USER|" \
    "$here/cloud-init.yaml" > "$custom_data"

echo "Creating resource group $RESOURCE_GROUP in $LOCATION"
az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none

echo "Creating VM $NAME ($VM_SIZE)"
ip=$(az vm create -g "$RESOURCE_GROUP" -n "$NAME" \
  --image Ubuntu2404 --size "$VM_SIZE" \
  --admin-username "$ADMIN_USER" --generate-ssh-keys \
  --public-ip-sku Standard --public-ip-address-dns-name "$NAME" \
  --custom-data "$custom_data" \
  --query publicIpAddress -o tsv)

# az vm create only opens SSH; Caddy needs 80 (ACME, redirect) and 443.
az vm open-port -g "$RESOURCE_GROUP" -n "$NAME" --port 80,443 --priority 1010 -o none

echo "VM is up at $ip; installing Docker and building the portal (about 5 minutes)"
ready=
for _ in $(seq 60); do
  if curl -fsS --max-time 5 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 10
done
if [[ -z $ready ]]; then
  echo "Not answering on https://$DOMAIN yet; check progress with:"
  echo "  ssh $ADMIN_USER@$ip 'cloud-init status; sudo docker compose -f /opt/aperturekit/docker-compose.yml logs'"
fi

cat <<MSG

ApertureKit:  https://$DOMAIN
SSH:          ssh $ADMIN_USER@$ip

Open the portal now and create the administrator account: until someone
does, the first visitor gets to.

Upgrade:  ssh $ADMIN_USER@$ip 'cd /opt/aperturekit && sudo git pull && sudo docker compose up -d --build'
Logs:     ssh $ADMIN_USER@$ip 'cd /opt/aperturekit && sudo docker compose logs -f'
Remove:   az group delete -n $RESOURCE_GROUP
MSG
if [[ $DOMAIN != *.cloudapp.azure.com ]]; then
  echo
  echo "Point $DOMAIN at $ip; the certificate is issued once DNS resolves."
fi
