#!/bin/sh
# Builds dist/luci-app-amneziawg-manager_<ver>_all.ipk without the OpenWrt SDK.
set -e
VER="${1:-1.0.0-r1}"
D="$(cd "$(dirname "$0")/.." && pwd)"
export COPYFILE_DISABLE=1
if tar --version 2>/dev/null | grep -qi gnu; then
	TAROPTS="--format=ustar --owner=0 --group=0"
else
	TAROPTS="--format ustar --uid 0 --gid 0"
fi
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/data/www" "$W/control" "$D/dist"
cp -R "$D/htdocs/." "$W/data/www/"
cp -R "$D/root/." "$W/data/"
cat > "$W/control/control" <<CTL
Package: luci-app-amneziawg-manager
Version: $VER
Depends: luci-base, luci-proto-amneziawg, amneziawg-tools
Section: luci
Architecture: all
Maintainer: 
Description: LuCI AmneziaWG Manager - store, edit and switch AmneziaWG configs per tunnel
CTL
cat > "$W/control/postinst" <<'CTL'
#!/bin/sh
[ -n "$IPKG_INSTROOT" ] || {
	mkdir -p /etc/amneziawg/configs
	chmod 700 /etc/amneziawg /etc/amneziawg/configs
	rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
	/etc/init.d/rpcd reload 2>/dev/null
}
exit 0
CTL
chmod +x "$W/control/postinst"
echo "2.0" > "$W/debian-binary"
( cd "$W/data" && tar $TAROPTS -czf "$W/data.tar.gz" . )
( cd "$W/control" && tar $TAROPTS -czf "$W/control.tar.gz" . )
OUT="$D/dist/luci-app-amneziawg-manager_${VER}_all.ipk"
rm -f "$OUT"
( cd "$W" && tar $TAROPTS -czf "$OUT" ./debian-binary ./data.tar.gz ./control.tar.gz )
echo "$OUT"
