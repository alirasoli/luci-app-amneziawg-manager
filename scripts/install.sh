#!/bin/sh
# Usage: scripts/install.sh [router-ip]   (default 192.168.1.1)
set -e
R="${1:-192.168.1.1}"
D="$(cd "$(dirname "$0")/.." && pwd)"
tar -C "$D/htdocs" -cf - . | ssh root@"$R" 'tar -C /www -xf -'
tar -C "$D/root" -cf - . | ssh root@"$R" 'tar -C / -xf -'
ssh root@"$R" '/etc/uci-defaults/90-amneziawg-manager; rm -f /tmp/luci-indexcache*; rm -rf /tmp/luci-modulecache; /etc/init.d/rpcd restart'
echo "Installed. Open LuCI -> VPN -> AmneziaWG Manager (re-login if the menu is missing)."
