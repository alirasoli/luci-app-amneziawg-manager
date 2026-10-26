# luci-app-amneziawg-manager

A LuCI app for OpenWrt to manage [AmneziaWG](https://docs.amnezia.org/documentation/amnezia-wg/) configs the way
`luci-app-openvpn` manages `.ovpn` files: paste a plain config, edit it later, delete it,
and pick which config each tunnel (`awg0`, `awg1`, …) should use.

Find it under **VPN → AmneziaWG Manager**.

## Features

- Paste (or load from file) plain AmneziaWG `.conf` text; add, edit, rename and delete configs.
- Configs are stored as `/etc/amneziawg/configs/<name>.conf` (mode `0600`, directory `0700`).
- **Tunnels table**: every network interface with `proto amneziawg`, with status, endpoint,
  last handshake, RX/TX, Start/Stop, and a config dropdown + **Apply**.
- **Add tunnel**: create a new interface (`awg2`, …) from a stored config, optionally adding it to a firewall zone.
- **Delete tunnel**: removes the interface, its peers and its firewall zone membership.
- Shows which config is currently active on which tunnel (matched by private key + peer public key).
- Editing a config that is active offers to re-apply it to those tunnels.
- Supports AmneziaWG 1.x and 2.x parameters: `Jc Jmin Jmax S1–S4 H1–H4 I1–I5` and the other
  options supported by `luci-proto-amneziawg`.
- Pure LuCI JavaScript + ACLs. No custom daemon, no architecture-specific code (`PKGARCH:=all`).

## Requirements

OpenWrt with the LuCI JS stack (tested on 24.10.8), plus:

```sh
opkg install kmod-amneziawg amneziawg-tools luci-proto-amneziawg
```

These come from an AmneziaWG OpenWrt feed/build or your firmware.

## Install

### Prebuilt package

```sh
scripts/build-ipk.sh 1.0.0-r1            # produces dist/luci-app-amneziawg-manager_1.0.0-r1_all.ipk
scp -O dist/*.ipk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'opkg install /tmp/luci-app-amneziawg-manager_*.ipk'
```

### Quick install straight from the source tree

```sh
scripts/install.sh 192.168.1.1
```

This copies the files and restarts `rpcd` (you will be logged out of LuCI once).

### Build in the OpenWrt buildroot

Put this directory in your `luci` feed (or `package/`), then
`make package/luci-app-amneziawg-manager/compile`.

## Usage

1. **Add config** → name it (e.g. `config1`), paste the plain config, **Save**.
   Required: `[Interface] PrivateKey` and a `[Peer]` with `PublicKey`.
2. In **Tunnels**, choose the config in the tunnel's dropdown and press **Apply**.
   The same can be done from the **Configs** table with **Use on**.
3. **Add tunnel** to create more tunnels; pick the config and (optionally) a firewall zone.

### Route Allowed IPs

When applying, you choose whether to tick **Route Allowed IPs** (`route_allowed_ips`).
A config with `AllowedIPs = 0.0.0.0/0` and this ticked becomes the router's default route.
Leave it off if you route traffic with policy-based routing (e.g. `pbr`); the existing value of the
tunnel is pre-selected so re-applying a config does not change your routing.

### What Apply changes

For the chosen interface it rewrites: `proto`, `private_key`, `addresses`, `dns`, `listen_port`, `mtu`,
all `awg_*` options, and replaces its `amneziawg_<iface>` peer sections. Other options
(firewall zone, `ip4table`, `nohostroute`, …) are left alone. `PreUp/PostUp` and similar
wg-quick directives are ignored. Changes are committed and the network is reloaded.

## Security notes

- Configs hold private keys. They are stored root-only (`0600`) and are readable through LuCI only by
  users granted the `luci-app-amneziawg-manager` ACL (root by default).
- Set a root password on the router; LuCI warns you if there is none.

## Layout

```
htdocs/luci-static/resources/view/amneziawg-manager/manager.js   the UI
root/usr/share/luci/menu.d/…json                                  menu entry
root/usr/share/rpcd/acl.d/…json                                   rpcd/ACL permissions
root/etc/uci-defaults/90-amneziawg-manager                        creates the config dir
scripts/                                                          install.sh, build-ipk.sh
Makefile                                                          OpenWrt package definition
```

## License

MIT
