'use strict';
'require view';
'require rpc';
'require ui';
'require uci';
'require fs';

/*
 * AmneziaWG Manager for LuCI.
 * Stores plain AmneziaWG .conf files in /etc/amneziawg/configs and applies them
 * to AmneziaWG network interfaces (UCI proto "amneziawg").
 */

var CONF_DIR = '/etc/amneziawg/configs';

var callWriteFile = rpc.declare({
	object: 'file',
	method: 'write',
	params: [ 'path', 'data', 'mode' ]
});

var callCommit = rpc.declare({
	object: 'uci',
	method: 'commit',
	params: [ 'config' ]
});

var callRevert = rpc.declare({
	object: 'uci',
	method: 'revert',
	params: [ 'config' ]
});

var callNetReload = rpc.declare({
	object: 'network',
	method: 'reload'
});

var callIfaceDump = rpc.declare({
	object: 'network.interface',
	method: 'dump',
	expect: { 'interface': [] }
});

/* [Interface] key (lowercase) -> uci option on the network interface */
var IFACE_MAP = {
	privatekey: 'private_key',
	listenport: 'listen_port',
	mtu: 'mtu',
	jc: 'awg_jc', jmin: 'awg_jmin', jmax: 'awg_jmax',
	s1: 'awg_s1', s2: 'awg_s2', s3: 'awg_s3', s4: 'awg_s4',
	h1: 'awg_h1', h2: 'awg_h2', h3: 'awg_h3', h4: 'awg_h4',
	i1: 'awg_i1', i2: 'awg_i2', i3: 'awg_i3', i4: 'awg_i4', i5: 'awg_i5',
	headerprotectionkey: 'awg_header_protection_key',
	contentpaddingaddition: 'awg_content_padding_addition',
	rekeyaftertime: 'awg_rekey_after_time',
	rekeytimeout: 'awg_rekey_timeout',
	rejectaftertime: 'awg_reject_after_time',
	keepalivetimeout: 'awg_keepalive_timeout',
	maxhandshakeattempts: 'awg_max_handshake_attempts'
};

var IFACE_FLAGS = {
	randomtrailers: 'awg_random_trailers',
	disablecookies: 'awg_disable_cookies'
};

/* every interface option this app owns and rewrites on apply */
var MANAGED_OPTS = [ 'addresses', 'dns' ]
	.concat(Object.keys(IFACE_MAP).map(function(k) { return IFACE_MAP[k]; }))
	.concat(Object.keys(IFACE_FLAGS).map(function(k) { return IFACE_FLAGS[k]; }));

function parseConf(text) {
	var res = { iface: {}, peers: [] }, cur = null;

	String(text || '').split(/\r?\n/).forEach(function(line) {
		line = line.trim();
		if (!line || line[0] == '#' || line[0] == ';')
			return;

		var m = line.match(/^\[(.+)\]$/);
		if (m) {
			var sec = m[1].trim().toLowerCase();
			if (sec == 'interface')
				cur = res.iface;
			else if (sec == 'peer')
				res.peers.push(cur = {});
			else
				cur = null;
			return;
		}

		var i = line.indexOf('=');
		if (i < 0 || !cur)
			return;

		var k = line.substring(0, i).trim().toLowerCase(),
		    v = line.substring(i + 1).trim();

		cur[k] = (k in cur) ? cur[k] + ',' + v : v;
	});

	return res;
}

function validateConf(text) {
	var c = parseConf(text);

	if (!c.iface.privatekey)
		return _('Missing [Interface] PrivateKey.');
	if (!c.peers.length)
		return _('Missing [Peer] section.');
	if (!c.peers[0].publickey)
		return _('Missing [Peer] PublicKey.');
	return null;
}

function splitList(v) {
	return String(v || '').split(/[,\s]+/).filter(function(s) { return s.length; });
}

function parseEndpoint(ep) {
	var m = String(ep || '').match(/^\[(.+)\]:(\d+)$/) || String(ep || '').match(/^(.+):(\d+)$/);
	return m ? { host: m[1], port: m[2] } : null;
}

function truthy(v) {
	return /^(1|true|yes|on)$/i.test(String(v));
}

function validName(n) {
	return /^[A-Za-z0-9_.-]{1,40}$/.test(n);
}

function validIfname(n) {
	return /^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(n);
}

function notify(msg, type) {
	ui.addNotification(null, E('p', msg), type || 'info');
}

function fail(err) {
	ui.hideModal();
	notify(_('Error: %s').format(err && err.message ? err.message : err), 'danger');
}

function sleep(ms) {
	return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function getTunnels() {
	return uci.sections('network', 'interface').filter(function(s) {
		return s.proto == 'amneziawg';
	});
}

function getPeers(tunnel) {
	return uci.sections('network', 'amneziawg_' + tunnel);
}

function asArray(v) {
	return Array.isArray(v) ? v : (v == null ? [] : [ v ]);
}

/* Which config (if any) currently matches the tunnel's key material. */
function matchConfig(tunnel, configs) {
	var priv = tunnel.private_key,
	    peers = getPeers(tunnel['.name']),
	    pub = peers.length ? peers[0].public_key : null;

	for (var i = 0; i < configs.length; i++) {
		var c = configs[i].parsed;
		if (c.iface.privatekey == priv && c.peers.length && c.peers[0].publickey == pub)
			return configs[i];
	}
	return null;
}

function mutateTunnel(name, conf, opts) {
	var existed = uci.get('network', name) != null,
	    route = opts.route ? '1' : '0';

	if (!existed) {
		uci.add('network', 'interface', name);
		uci.set('network', name, 'delegate', '0');
	}

	uci.set('network', name, 'proto', 'amneziawg');

	MANAGED_OPTS.forEach(function(o) { uci.unset('network', name, o); });

	var i = conf.iface;
	Object.keys(IFACE_MAP).forEach(function(k) {
		if (i[k] != null && i[k] !== '')
			uci.set('network', name, IFACE_MAP[k], i[k]);
	});
	Object.keys(IFACE_FLAGS).forEach(function(k) {
		if (i[k] != null)
			uci.set('network', name, IFACE_FLAGS[k], truthy(i[k]) ? '1' : '0');
	});
	if (i.address)
		uci.set('network', name, 'addresses', splitList(i.address));
	if (i.dns)
		uci.set('network', name, 'dns', splitList(i.dns).filter(function(s) { return /^[0-9a-fA-F:.]+$/.test(s); }));

	getPeers(name).forEach(function(p) { uci.remove('network', p['.name']); });

	conf.peers.forEach(function(p) {
		var sid = uci.add('network', 'amneziawg_' + name);
		uci.set('network', sid, 'description', opts.description || name);
		uci.set('network', sid, 'public_key', p.publickey);
		if (p.presharedkey)
			uci.set('network', sid, 'preshared_key', p.presharedkey);
		uci.set('network', sid, 'allowed_ips', splitList(p.allowedips || '0.0.0.0/0, ::/0'));
		uci.set('network', sid, 'route_allowed_ips', route);
		var ep = parseEndpoint(p.endpoint);
		if (ep) {
			uci.set('network', sid, 'endpoint_host', ep.host);
			uci.set('network', sid, 'endpoint_port', ep.port);
		}
		if (p.persistentkeepalive && !/^(off|0)$/i.test(p.persistentkeepalive))
			uci.set('network', sid, 'persistent_keepalive', p.persistentkeepalive);
	});

	if (opts.zone && !existed) {
		uci.sections('firewall', 'zone').forEach(function(z) {
			if (z.name != opts.zone)
				return;
			var nets = asArray(z.network);
			if (nets.indexOf(name) < 0)
				uci.set('firewall', z['.name'], 'network', nets.concat([ name ]));
			opts.fwChanged = true;
		});
	}
}

function reloadAll(fwChanged, ifnames) {
	return uci.save().then(function() {
		return runCommit(fwChanged, ifnames);
	});
}

/* commit staged changes; on failure drop them so nothing stays half-applied */
function runCommit(fwChanged, ifnames) {
	return Promise.resolve()
		.then(function() { return callCommit('network'); })
		.then(function() { return fwChanged ? callCommit('firewall') : null; })
		.then(function() { return callNetReload(); })
		.then(function() { return fwChanged ? L.resolveDefault(fs.exec('/etc/init.d/firewall', [ 'reload' ])) : null; })
		.then(function() { return sleep(2500); })
		.then(function() {
			return Promise.all((ifnames || []).map(function(n) {
				return L.resolveDefault(fs.exec('/sbin/ifup', [ n ]));
			}));
		}, function(err) {
			return Promise.all([ L.resolveDefault(callRevert('network')), L.resolveDefault(callRevert('firewall')) ])
				.then(function() { throw err; });
		});
}

function readStatus() {
	function table(what) {
		return L.resolveDefault(fs.exec('/usr/bin/awg', [ 'show', 'all', what ]), null).then(function(r) {
			var out = {};
			((r && r.stdout) || '').split('\n').forEach(function(l) {
				var f = l.split('\t');
				if (f.length >= 3 && !(f[0] in out))
					out[f[0]] = f.slice(2);
			});
			return out;
		});
	}

	return Promise.all([
		L.resolveDefault(callIfaceDump(), []),
		table('latest-handshakes'),
		table('transfer'),
		table('endpoints')
	]).then(function(r) {
		var st = {};
		r[0].forEach(function(i) { st[i.interface] = { up: !!i.up, device: i.l3_device || i.device }; });
		Object.keys(st).forEach(function(n) {
			var dev = st[n].device;
			if (!dev)
				return;
			if (r[1][dev]) st[n].handshake = +r[1][dev][0];
			if (r[2][dev]) { st[n].rx = +r[2][dev][0]; st[n].tx = +r[2][dev][1]; }
			if (r[3][dev]) st[n].endpoint = r[3][dev][0];
		});
		return st;
	});
}

function loadConfigs() {
	return L.resolveDefault(fs.list(CONF_DIR), null).then(function(list) {
		if (list == null)
			return fs.exec('/bin/mkdir', [ '-p', CONF_DIR ]).then(function() { return []; });
		return list;
	}).then(function(list) {
		var files = list.filter(function(f) { return f.type == 'file' && /\.conf$/.test(f.name); });
		return Promise.all(files.map(function(f) {
			return fs.read(CONF_DIR + '/' + f.name).then(function(text) {
				return { name: f.name.replace(/\.conf$/, ''), text: text, parsed: parseConf(text) };
			});
		}));
	}).then(function(arr) {
		return arr.sort(function(a, b) { return a.name < b.name ? -1 : 1; });
	});
}

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load: function() {
		uci.unload([ 'network', 'firewall' ]);
		return Promise.all([
			uci.load('network'),
			L.resolveDefault(uci.load('firewall')),
			loadConfigs(),
			readStatus()
		]);
	},

	render: function(data) {
		this.data = data;
		this.root = E('div');
		this.draw();
		return this.root;
	},

	refresh: function() {
		var self = this;
		return self.load().then(function(d) { self.data = d; self.draw(); });
	},

	draw: function() {
		var self = this,
		    configs = this.data[2],
		    status = this.data[3],
		    tunnels = getTunnels();

		/* ---- tunnels ---- */
		var trows = tunnels.map(function(t) {
			var name = t['.name'],
			    st = status[name] || {},
			    active = matchConfig(t, configs),
			    peers = getPeers(name),
			    sel = E('select', { 'class': 'cbi-input-select' },
				[ E('option', { value: '' }, _('— select config —')) ].concat(configs.map(function(c) {
					return E('option', { value: c.name, selected: active && active.name == c.name ? '' : null }, c.name);
				})));

			var hs = st.handshake ? _('%t ago').format(Math.max(0, Math.floor(Date.now() / 1000) - st.handshake)) : '—';

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, E('strong', name)),
				E('td', { 'class': 'td' }, E('span', {
					'class': 'ifacebadge',
					'style': 'background:' + (st.up ? '#4caf50;color:#fff' : '#9e9e9e;color:#fff')
				}, st.up ? _('Up') : _('Down'))),
				E('td', { 'class': 'td' }, [
					sel, ' ',
					E('button', {
						'class': 'cbi-button cbi-button-apply',
						'click': function() {
							if (!sel.value) return notify(_('Select a config first.'), 'warning');
							self.showApply(sel.value, name);
						}
					}, _('Apply')),
					active ? '' : E('div', { 'class': 'cbi-value-description' },
						peers.length ? _('Custom / unmanaged settings') : _('Not configured'))
				]),
				E('td', { 'class': 'td' }, st.endpoint || (peers[0] && peers[0].endpoint_host ? peers[0].endpoint_host + ':' + (peers[0].endpoint_port || '') : '—')),
				E('td', { 'class': 'td' }, hs),
				E('td', { 'class': 'td' }, st.rx != null ? '%.1024mB / %.1024mB'.format(st.rx, st.tx) : '—'),
				E('td', { 'class': 'td cbi-section-actions' }, E('div', [
					st.up
						? E('button', { 'class': 'cbi-button cbi-button-neutral', 'click': function() { self.ifaceCmd('/sbin/ifdown', name); } }, _('Stop'))
						: E('button', { 'class': 'cbi-button cbi-button-positive', 'click': function() { self.ifaceCmd('/sbin/ifup', name); } }, _('Start')),
					' ',
					E('button', { 'class': 'cbi-button cbi-button-remove', 'click': function() { self.deleteTunnel(name); } }, _('Delete'))
				]))
			]);
		});

		var ttable = E('table', { 'class': 'table cbi-section-table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Tunnel')),
				E('th', { 'class': 'th' }, _('Status')),
				E('th', { 'class': 'th' }, _('Config')),
				E('th', { 'class': 'th' }, _('Endpoint')),
				E('th', { 'class': 'th' }, _('Last handshake')),
				E('th', { 'class': 'th' }, _('RX / TX')),
				E('th', { 'class': 'th cbi-section-actions' }, '')
			])
		].concat(trows.length ? trows : [
			E('tr', { 'class': 'tr placeholder' }, E('td', { 'class': 'td', 'colspan': 7 }, E('em', _('No AmneziaWG tunnels yet.'))))
		]));

		/* ---- configs ---- */
		var crows = configs.map(function(c) {
			var users = tunnels.filter(function(t) { var m = matchConfig(t, configs); return m && m.name == c.name; })
				.map(function(t) { return t['.name']; }),
			    p0 = c.parsed.peers[0] || {},
			    tsel = E('select', { 'class': 'cbi-input-select' }, tunnels.map(function(t) {
				return E('option', { value: t['.name'] }, t['.name']);
			    }));

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, E('strong', c.name)),
				E('td', { 'class': 'td' }, p0.endpoint || '—'),
				E('td', { 'class': 'td' }, c.parsed.iface.address || '—'),
				E('td', { 'class': 'td' }, users.join(', ') || '—'),
				E('td', { 'class': 'td' }, tunnels.length ? [
					tsel, ' ',
					E('button', { 'class': 'cbi-button cbi-button-apply', 'click': function() { self.showApply(c.name, tsel.value); } }, _('Use on'))
				] : '—'),
				E('td', { 'class': 'td cbi-section-actions' }, E('div', [
					E('button', { 'class': 'cbi-button cbi-button-edit', 'click': function() { self.showEditor(c); } }, _('Edit')),
					' ',
					E('button', { 'class': 'cbi-button cbi-button-remove', 'click': function() { self.deleteConfig(c, users); } }, _('Delete'))
				]))
			]);
		});

		var ctable = E('table', { 'class': 'table cbi-section-table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Name')),
				E('th', { 'class': 'th' }, _('Endpoint')),
				E('th', { 'class': 'th' }, _('Address')),
				E('th', { 'class': 'th' }, _('Active on')),
				E('th', { 'class': 'th' }, _('Apply to tunnel')),
				E('th', { 'class': 'th cbi-section-actions' }, '')
			])
		].concat(crows.length ? crows : [
			E('tr', { 'class': 'tr placeholder' }, E('td', { 'class': 'td', 'colspan': 6 }, E('em', _('No configs yet. Add one by pasting a plain AmneziaWG config.'))))
		]));

		L.dom.content(this.root, [
			E('h2', _('AmneziaWG Manager')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Store plain AmneziaWG configs and switch which one each tunnel uses. Configs are kept in %s.').format(CONF_DIR)),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Tunnels')),
				ttable,
				E('div', { 'class': 'cbi-section-create' }, [
					E('button', { 'class': 'cbi-button cbi-button-add', 'click': function() { self.showNewTunnel(); } }, _('Add tunnel')),
					' ',
					E('button', { 'class': 'cbi-button cbi-button-neutral', 'click': function() { self.refresh(); } }, _('Refresh'))
				])
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Configs')),
				ctable,
				E('div', { 'class': 'cbi-section-create' },
					E('button', { 'class': 'cbi-button cbi-button-add', 'click': function() { self.showEditor(null); } }, _('Add config')))
			])
		]);
	},

	ifaceCmd: function(cmd, name) {
		var self = this;
		return fs.exec(cmd, [ name ]).then(function() { return sleep(1500); })
			.then(function() { return self.refresh(); }).catch(fail);
	},

	findConfig: function(name) {
		return this.data[2].filter(function(c) { return c.name == name; })[0];
	},

	/* modal: apply config to existing tunnel */
	showApply: function(cfgName, tunnelName) {
		var self = this,
		    cfg = this.findConfig(cfgName),
		    peers = getPeers(tunnelName),
		    route = E('input', { type: 'checkbox' });

		route.checked = peers.length ? peers[0].route_allowed_ips == '1' : false;

		ui.showModal(_('Apply config'), [
			E('p', _('Apply config “%s” to tunnel “%s”? Existing key, address and peer settings of the tunnel are replaced.').format(cfgName, tunnelName)),
			E('label', {}, [ route, ' ', _('Route Allowed IPs (a 0.0.0.0/0 config becomes the default route)') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button-positive important',
					'click': function() {
						ui.showModal(null, E('p', { 'class': 'spinning' }, _('Applying…')));
						var opts = { route: route.checked, description: cfgName };
						mutateTunnel(tunnelName, cfg.parsed, opts);
						reloadAll(opts.fwChanged, [])
							.then(function() { ui.hideModal(); return self.refresh(); })
							.catch(fail);
					}
				}, _('Apply'))
			])
		]);
	},

	showNewTunnel: function() {
		var self = this,
		    configs = this.data[2];

		if (!configs.length)
			return notify(_('Add a config first, then create a tunnel for it.'), 'warning');

		var name = E('input', { 'class': 'cbi-input-text', type: 'text', placeholder: 'awg2' }),
		    cfg = E('select', { 'class': 'cbi-input-select' }, configs.map(function(c) { return E('option', { value: c.name }, c.name); })),
		    zone = E('select', { 'class': 'cbi-input-select' }, [ E('option', { value: '' }, _('— none —')) ].concat(
			uci.sections('firewall', 'zone').map(function(z) { return E('option', { value: z.name }, z.name); }))),
		    route = E('input', { type: 'checkbox' });

		ui.showModal(_('Add tunnel'), [
			E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, _('Interface name')), E('div', { 'class': 'cbi-value-field' }, name) ]),
			E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, _('Config')), E('div', { 'class': 'cbi-value-field' }, cfg) ]),
			E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, _('Firewall zone')), E('div', { 'class': 'cbi-value-field' }, zone) ]),
			E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, _('Route Allowed IPs')), E('div', { 'class': 'cbi-value-field' }, route) ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button-positive important',
					'click': function() {
						var n = name.value.trim();
						if (!validIfname(n))
							return notify(_('Interface name: letters, digits, underscore; start with a letter; max 15 chars.'), 'warning');
						if (uci.get('network', n) != null)
							return notify(_('An interface named “%s” already exists.').format(n), 'warning');

						ui.showModal(null, E('p', { 'class': 'spinning' }, _('Creating tunnel…')));
						var opts = { route: route.checked, zone: zone.value, description: cfg.value };
						mutateTunnel(n, self.findConfig(cfg.value).parsed, opts);
						reloadAll(opts.fwChanged, [ n ])
							.then(function() { ui.hideModal(); return self.refresh(); })
							.catch(fail);
					}
				}, _('Create'))
			])
		]);
	},

	deleteTunnel: function(name) {
		var self = this;

		ui.showModal(_('Delete tunnel'), [
			E('p', _('Delete tunnel “%s”, its peers and its firewall zone membership? Stored configs are kept. Other rules (e.g. policy routing) that reference it are not changed.').format(name)),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button-negative important',
					'click': function() {
						ui.showModal(null, E('p', { 'class': 'spinning' }, _('Deleting…')));
						var fw = false;

						getPeers(name).forEach(function(p) { uci.remove('network', p['.name']); });
						uci.remove('network', name);
						uci.sections('firewall', 'zone').forEach(function(z) {
							var nets = asArray(z.network);
							if (nets.indexOf(name) >= 0) {
								uci.set('firewall', z['.name'], 'network', nets.filter(function(n) { return n != name; }));
								fw = true;
							}
						});

						L.resolveDefault(fs.exec('/sbin/ifdown', [ name ]))
							.then(function() { return reloadAll(fw, []); })
							.then(function() { ui.hideModal(); return self.refresh(); })
							.catch(fail);
					}
				}, _('Delete'))
			])
		]);
	},

	/* modal: create or edit a config (cfg == null → create) */
	showEditor: function(cfg) {
		var self = this,
		    name = E('input', { 'class': 'cbi-input-text', type: 'text', value: cfg ? cfg.name : '', placeholder: 'config1' }),
		    text = E('textarea', {
			'class': 'cbi-input-textarea',
			'style': 'width:100%;height:22em;font-family:monospace;white-space:pre;overflow:auto',
			'wrap': 'off',
			'spellcheck': 'false',
			'placeholder': '[Interface]\nPrivateKey = …\nAddress = 10.2.0.2/32\nJc = 4\n…\n\n[Peer]\nPublicKey = …\nAllowedIPs = 0.0.0.0/0\nEndpoint = host:51820'
		    }, cfg ? cfg.text : ''),
		    file = E('input', { type: 'file', accept: '.conf,.txt,text/plain' }),
		    users = cfg ? getTunnels().filter(function(t) { var m = matchConfig(t, self.data[2]); return m && m.name == cfg.name; }) : [],
		    reapply = E('input', { type: 'checkbox', checked: '' }),
		    oldRoute = {};

		users.forEach(function(t) {
			var p = getPeers(t['.name']);
			oldRoute[t['.name']] = p.length && p[0].route_allowed_ips == '1';
		});

		file.addEventListener('change', function() {
			var f = file.files[0];
			if (!f) return;
			var r = new FileReader();
			r.onload = function() {
				text.value = r.result;
				if (!name.value)
					name.value = f.name.replace(/\.(conf|txt)$/i, '').replace(/[^A-Za-z0-9_.-]/g, '_');
			};
			r.readAsText(f);
		});

		ui.showModal(cfg ? _('Edit config “%s”').format(cfg.name) : _('Add config'), [
			E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, _('Name')), E('div', { 'class': 'cbi-value-field' }, name) ]),
			E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, _('Load from file')), E('div', { 'class': 'cbi-value-field' }, file) ]),
			text,
			users.length ? E('label', {}, [ reapply, ' ', _('Re-apply to tunnel(s): %s').format(users.map(function(t) { return t['.name']; }).join(', ')) ]) : '',
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button-positive important',
					'click': function() {
						var n = name.value.trim(), body = text.value.replace(/\r\n/g, '\n');
						if (!validName(n))
							return notify(_('Name: letters, digits, dot, dash, underscore (max 40).'), 'warning');
						var err = validateConf(body);
						if (err)
							return notify(err, 'warning');
						if ((!cfg || cfg.name != n) && self.findConfig(n))
							return notify(_('A config named “%s” already exists.').format(n), 'warning');
						if (body.slice(-1) != '\n') body += '\n';

						ui.showModal(null, E('p', { 'class': 'spinning' }, _('Saving…')));
						callWriteFile(CONF_DIR + '/' + n + '.conf', body, 384)
							.then(function() {
								return (cfg && cfg.name != n) ? L.resolveDefault(fs.remove(CONF_DIR + '/' + cfg.name + '.conf')) : null;
							})
							.then(function() {
								if (!users.length || !reapply.checked)
									return;
								var parsed = parseConf(body), fw = false;
								users.forEach(function(t) {
									mutateTunnel(t['.name'], parsed, { route: oldRoute[t['.name']], description: n });
								});
								return reloadAll(fw, []);
							})
							.then(function() { ui.hideModal(); return self.refresh(); })
							.catch(fail);
					}
				}, _('Save'))
			])
		], 'cbi-modal');
	},

	deleteConfig: function(cfg, users) {
		var self = this;

		ui.showModal(_('Delete config'), [
			E('p', _('Delete config “%s”?').format(cfg.name)),
			users.length ? E('p', _('It is active on %s; that tunnel keeps running with its current settings.').format(users.join(', '))) : '',
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button-negative important',
					'click': function() {
						fs.remove(CONF_DIR + '/' + cfg.name + '.conf')
							.then(function() { ui.hideModal(); return self.refresh(); })
							.catch(fail);
					}
				}, _('Delete'))
			])
		]);
	}
});
