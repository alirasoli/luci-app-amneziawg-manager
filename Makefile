include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI AmneziaWG Manager - store, edit and switch AmneziaWG configs per tunnel
LUCI_DEPENDS:=+luci-base +luci-proto-amneziawg +amneziawg-tools
LUCI_PKGARCH:=all

PKG_LICENSE:=MIT
PKG_MAINTAINER:=

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
