/**
 * IA CRM SDK — v1.0
 * Snippet universal de integração
 * Uso: <script src="https://iacrmapp.com.br/sdk.js" data-key="sk_live_..."></script>
 */
(function(window, document) {
  'use strict';

  // ── Configuração via data-key no script tag ──
  var scriptTag = document.currentScript || (function() {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var API_KEY    = scriptTag.getAttribute('data-key') || '';
  var API_URL    = scriptTag.getAttribute('data-url') || 'https://iacrmapp.com.br';
  var DEBUG      = scriptTag.getAttribute('data-debug') === 'true';
  var AUTO_FORMS = scriptTag.getAttribute('data-forms') !== 'false'; // default true
  var AUTO_TRACK = scriptTag.getAttribute('data-track') !== 'false'; // default true

  if (!API_KEY) { console.warn('[IACRM SDK] data-key não configurado.'); return; }

  function log() { if (DEBUG) console.log.apply(console, ['[IACRM SDK]'].concat(Array.prototype.slice.call(arguments))); }

  // ── API helper ──
  function apiFetch(path, body, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', API_URL + '/api/crm' + path, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', 'Bearer ' + API_KEY);
    xhr.onload = function() {
      try { var d = JSON.parse(xhr.responseText); cb(null, d); }
      catch(e) { cb(e, null); }
    };
    xhr.onerror = function() { cb(new Error('network'), null); };
    xhr.send(JSON.stringify(body));
  }

  // ── Session & Visitor ──
  function getCookie(n) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(n, v, days) {
    var exp = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = n + '=' + encodeURIComponent(v) + '; expires=' + exp + '; path=/; SameSite=Lax';
  }

  var VISITOR_ID = getCookie('_iacrm_vid') || ('v_' + Math.random().toString(36).substr(2, 12));
  setCookie('_iacrm_vid', VISITOR_ID, 365);

  var SESSION_ID = 's_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  var PAGE_START = Date.now();
  var IS_RETURNING = !!getCookie('_iacrm_seen');
  setCookie('_iacrm_seen', '1', 180);

  // ── Behavior tracking ──
  var behavior = {
    visitorId:     VISITOR_ID,
    sessionId:     SESSION_ID,
    visitante:     IS_RETURNING ? 'recorrente' : 'novo',
    pagina:        window.location.pathname,
    titulo:        document.title,
    referrer:      document.referrer,
    utmSource:     new URLSearchParams(window.location.search).get('utm_source') || '',
    utmMedium:     new URLSearchParams(window.location.search).get('utm_medium') || '',
    utmCampaign:   new URLSearchParams(window.location.search).get('utm_campaign') || '',
    dispositivo:   /Mobile|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
    largura:       window.innerWidth,
    scrollMaximo:  0,
    tempoNaPagina: 0,
    eventos:       []
  };

  if (AUTO_TRACK) {
    // Scroll
    window.addEventListener('scroll', function() {
      var pct = Math.round((window.scrollY / Math.max(1, document.body.scrollHeight - window.innerHeight)) * 100);
      if (pct > behavior.scrollMaximo) behavior.scrollMaximo = pct;
    });
    // Tempo
    setInterval(function() {
      behavior.tempoNaPagina = Math.round((Date.now() - PAGE_START) / 1000);
    }, 5000);
    // Cliques em CTAs
    document.addEventListener('click', function(e) {
      var btn = e.target.closest('a[href], button');
      if (!btn) return;
      var label = (btn.textContent || '').trim().substring(0, 40);
      if (label) behavior.eventos.push({ tipo: 'clique', label: label, t: Date.now() });
    });
  }

  // ── Identificar usuário manualmente ──
  window.IACRM = window.IACRM || {};

  window.IACRM.identify = function(dados) {
    // dados: { email, nome, whatsapp, ... }
    log('identify', dados);
    apiFetch('/sdk/identify', { visitor_id: VISITOR_ID, session_id: SESSION_ID, behavior: behavior, dados: dados }, function(err, res) {
      if (!err && res && res.ok) log('identified:', res.data);
    });
  };

  window.IACRM.track = function(evento, props) {
    log('track', evento, props);
    apiFetch('/sdk/evento', { visitor_id: VISITOR_ID, session_id: SESSION_ID, evento: evento, props: props || {}, behavior: behavior }, function() {});
  };

  window.IACRM.capturarLead = function(dados, cb) {
    log('capturarLead', dados);
    apiFetch('/sdk/lead', {
      visitor_id:    VISITOR_ID,
      session_id:    SESSION_ID,
      behavior:      behavior,
      nome_empresa:  dados.nome_empresa || dados.nome || '',
      email:         dados.email || '',
      whatsapp:      dados.whatsapp || dados.telefone || '',
      cidade:        dados.cidade || '',
      uf:            dados.uf || '',
      origem:        dados.origem || window.location.pathname,
      dados_extra:   dados
    }, function(err, res) {
      if (cb) cb(err, res);
      if (!err && res && res.ok) log('lead capturado:', res.data);
    });
  };

  window.IACRM.pageview = function(pagina) {
    apiFetch('/sdk/pageview', { visitor_id: VISITOR_ID, pagina: pagina || window.location.pathname, titulo: document.title, behavior: behavior }, function() {});
  };

  // ── Auto-captura de formulários ──
  if (AUTO_FORMS) {
    function setupForm(form) {
      if (form._iacrm_setup) return;
      form._iacrm_setup = true;
      form.addEventListener('submit', function(e) {
        var data = {};
        var inputs = form.querySelectorAll('input, select, textarea');
        inputs.forEach(function(input) {
          var name = input.name || input.id || input.type;
          var val  = input.value;
          if (!val || input.type === 'password') return;
          // Detectar campos por tipo/nome
          var n = name.toLowerCase();
          if (n.includes('email') || input.type === 'email') data.email = val;
          else if (n.includes('whatsapp') || n.includes('fone') || n.includes('telefone') || input.type === 'tel') data.whatsapp = val;
          else if (n.includes('nome') || n.includes('empresa') || n.includes('name')) data.nome_empresa = val;
          else if (n.includes('cidade') || n.includes('city')) data.cidade = val;
          else data[name] = val;
        });
        if (data.email || data.whatsapp) {
          data.origem = 'formulario_automatico';
          window.IACRM.capturarLead(data);
          log('form capturado:', data);
        }
      });
    }

    // Setup forms existentes
    document.querySelectorAll('form').forEach(setupForm);

    // Observar novos forms (SPAs)
    var mutObs = new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        m.addedNodes.forEach(function(node) {
          if (node.nodeType === 1) {
            if (node.tagName === 'FORM') setupForm(node);
            node.querySelectorAll && node.querySelectorAll('form').forEach(setupForm);
          }
        });
      });
    });
    mutObs.observe(document.body, { childList: true, subtree: true });
  }

  // ── Pageview automático ──
  if (AUTO_TRACK) {
    window.IACRM.pageview();
    // SPA: pushState
    var _pushState = history.pushState;
    history.pushState = function() {
      _pushState.apply(history, arguments);
      setTimeout(function() { window.IACRM.pageview(); }, 100);
    };
  }

  log('SDK inicializado. Key:', API_KEY.substring(0, 12) + '...');

})(window, document);
