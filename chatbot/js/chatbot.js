// ============================================================
//  CPCON CHATBOT — Camile (site France / fr-FR)
//  Flux piloté par le backend. Vouvoiement.
//  Dépendances : config.js, ui.js, api.js (déjà chargés avant)
//
//  Différence vs version BR : pas de WhatsApp. Le lead est capturé
//  dès le formulaire initial (/api/leads/chatbot). Le « handoff »
//  se limite à confirmer la prise de contact (un conseiller
//  recontactera par e-mail), avec un repli mailto:contact@.
// ============================================================

// ── État ───────────────────────────────────────────────────
const CRM_PROXY_URL = '/api/leads';
const CHAT_URL = '/api/chat';


// 17/10/2026 (form infalível): quem mexeu num formulário da página nos últimos
// 60 s não perde o foco para a Camile.
var cpconPageFormAt = 0;
document.addEventListener('focusin', function (e) {
  var t = e.target;
  if (t && t.form && !(t.closest && t.closest('#cpcon-inline-form'))) cpconPageFormAt = Date.now();
}, true);
function cpconPageFormBusy() {
  var a = document.activeElement;
  var inPage = a && a.form && !(a.closest && a.closest('#cpcon-inline-form'));
  return !!inPage || Date.now() - cpconPageFormAt < 60000;
}

async function cpconFetchFormToken() {
  const res = await fetch('/api/leads/form-token', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('form-token HTTP ' + res.status);
  const data = await res.json().catch(function () { return null; });
  if (!data || !data.form_token) throw new Error('form-token missing');
  return data.form_token;
}

const cpconState = {
  isOpen: false,
  started: false,
  sessionId: null,
  sessionToken: '',
  stage: 'idle',
  transferred: false,
  history: [],            // [{role, content, sig?}] — sig = assinatura HMAC da fala do bot (chat-guard)
  busy: false,
  userName: '',
  userEmail: '',
  userPhone: '',
  userPhoneCountry: 'FR',
  userEmpresa: '',
  leadId: null,
  lastActivityAt: 0,
  handoffOffered: false,
  conversationEnded: false,
  lastSegment: null,
  lastTema: null,
  turns: 0,
  _transferFired: false,
};

// ── Validations du formulaire initial ──────────────────────
const BLOCKED_NAMES = /^(bonjour|salut|coucou|hey|hi|hello|oui|non|ok|test|teste|asdf|aaa|xxx|haha|hehe|cc)$/i;
const VOWEL_RE = /[aeiouyàâäéèêëîïôöùûü]/i;
function validarNome(n) {
  const t = (n || '').trim();
  if (t.length < 2 || !VOWEL_RE.test(t) || BLOCKED_NAMES.test(t)) return null;
  // Nome COMPLETO — split(' ')[0] cortava o sobrenome de todo lead do chat.
  return t.replace(/\s+/g, ' ');
}
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const DISPOSABLE = /^(tempmail|mailinator|guerrillamail|10minutemail|throwaway|yopmail|jetable|fakeinbox|trashmail|sharklasers)\./i;
function validarEmail(e) {
  const t = (e || '').trim().toLowerCase();
  if (!EMAIL_RE.test(t)) return null;
  if (DISPOSABLE.test(t.split('@')[1])) return null;
  return t;
}
function cpconPhoneApi() {
  return window.cpconPhone || null;
}
function cpconTrapValue(id) {
  return (document.getElementById(id) || {}).value || '';
}
function cpconReadTraps() {
  return {
    cpcon_hp_a: cpconTrapValue('cpcon_hp_a'),
    cpcon_hp_b: cpconTrapValue('cpcon_hp_b'),
    cpcon_hp_c: cpconTrapValue('cpcon_hp_c'),
    cpcon_hp_d: cpconTrapValue('cpcon_hp_d'),
  };
}
function validarEmpresa(e) {
  const t = (e || '').trim();
  if (t.length < 2) return null;
  return t;
}

// Captura contato digitado em TEXTO LIVRE no chat (email/telefone/nome) para
// não perder lead quando o cliente escreve os dados em prosa em vez do fluxo
// estruturado. Só preenche o que falta; email/telefone passam pela validação
// existente; nome só quando já há email (exige inicial maiúscula, evita pegar
// cargo/verbo como nome). Paridade com o fix do widget BR.
function cpconExtractContact(text) {
  var s = String(text || '');
  if (!s) return;
  if (!cpconState.userEmail) {
    var em = (s.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i) || [])[0];
    var ev = em ? validarEmail(em) : null;
    if (ev) cpconState.userEmail = ev;
  }
  if (!cpconState.userPhone && window.cpconPhone) {
    var pm = s.match(/\(?\+?\d[\d\s().\-]{6,}\d/);
    var pv = pm ? window.cpconPhone.toE164(window.cpconPhone.defaultCountry, pm[0]) : null;
    if (pv) {
      cpconState.userPhone = pv;
      cpconState.userPhoneCountry = window.cpconPhone.defaultCountry;
    }
  }
  if (!cpconState.userName && cpconState.userEmail) {
    var nm = '';
    var mn = s.match(/(?:[Jj]e m'appelle|[Mm]on nom est|[Jj]e suis|[Nn]om[:\-])\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+){0,2})/);
    if (mn && mn[1]) nm = mn[1].trim();
    if (nm.length < 2) {
      var head = s.split(/[a-z0-9._%+\-]+@/i)[0];
      var cap = (head.match(/[A-ZÀ-Ý][a-zà-ÿ'\-]{1,}(?:\s+[A-ZÀ-Ý][a-zà-ÿ'\-]{1,}){0,2}/) || [''])[0]
        .replace(/^(Bonjour|Salut|Bonsoir|Cher|Chère|Je|Mon|Monsieur|Madame)\s+/i, '').trim();
      if (cap.length >= 2) nm = cap;
    }
    if (nm.length < 2) nm = cpconState.userEmail.split('@')[0].replace(/[._\-]+/g, ' ').trim();
    if (nm.length >= 2) cpconState.userName = nm.slice(0, 120);
  }
}


// ── Toggle + accueil ───────────────────────────────────────

function cpconToggle() {
  const chat = document.getElementById('cpcon-chat');
  const isCurrentlyOpen = chat.classList.contains('open');
  const willOpen = !isCurrentlyOpen;

  if (willOpen) {
    window.__cpconStickyClicked = false;
    const sticky = document.getElementById('cpcon-sticky');
    if (sticky) sticky.style.display = 'none';
  } else {
    const sticky = document.getElementById('cpcon-sticky');
    if (sticky) sticky.style.display = '';
  }

  if (isCurrentlyOpen && !cpconState.started) {
    document.getElementById('cpcon-msgs').innerHTML = '';
    cpconState.isOpen = true;
    cpconState.started = true;
    setTimeout(cpconFlowGreeting, 300);
    return;
  }
  cpconState.isOpen = willOpen;
  chat.classList.toggle('open', cpconState.isOpen);
  // 02/11/2026: hora de abertura (proteção contra clique-fantasma, ver cpconCaptureGuard).
  if (cpconState.isOpen) cpconState.openedAt = Date.now();
  const badge = document.getElementById('cpcon-badge');
  if (badge) badge.style.display = 'none';
  if (cpconState.isOpen && !cpconState.started) {
    cpconState.started = true;
    setTimeout(cpconFlowGreeting, 500);
  }
}

function cpconFlowGreeting() {
  // Avis discret sur la protection des données
  cpconAppendNotice('Ne partagez pas de mots de passe ni de données bancaires ici.');
  cpconSay(
    'Bonjour. Je suis ' + (window.CPCON_CONFIG && window.CPCON_CONFIG.agentName ? window.CPCON_CONFIG.agentName : 'Camile') + ', conseillère commerciale chez CPCON. Afin de mieux vous accompagner, pourriez-vous me communiquer vos coordonnées ?',
    function () {
      cpconState.stage = 'form';
      cpconDisableInput();
      cpconShowInlineForm();
    }
  );
}

function cpconAppendNotice(text) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const n = document.createElement('div');
  n.className = 'cpcon-notice';
  n.textContent = text;
  container.appendChild(n);
  cpconScrollDown();
}

// ── Telemetria da captura (16/10/2026) ─────────────────────
// Funil da captura da Camile: capture_shown → capture_submitted, ou
// capture_rejected{reason: robot_box|phone|country|other}. Vai para o mesmo
// /api/form-telemetry dos formulários. Só códigos e nomes de campo: nada do
// que a pessoa digitou (sem nome, e-mail, empresa ou telefone).
var CPCON_TELEMETRY_URL = '/api/form-telemetry';
function cpconCaptureTelemetry(event, extra) {
  try {
    var body = { event: event, page: window.location.pathname.slice(0, 200), form: 'camile' };
    if (extra && extra.reason) body.reason = extra.reason;
    if (extra && extra.fields && extra.fields.length) body.fields = extra.fields.slice(0, 12);
    if (extra && extra.errors && extra.errors.length) body.errors = extra.errors.slice(0, 12);
    if (extra && /^[A-Z]{2}$/.test(extra.phone_country || '')) body.phone_country = extra.phone_country;
    var json = JSON.stringify(body);
    if (navigator.sendBeacon && navigator.sendBeacon(CPCON_TELEMETRY_URL, new Blob([json], { type: 'application/json' }))) return;
    fetch(CPCON_TELEMETRY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true, credentials: 'same-origin' }).catch(function () {});
  } catch (e) { /* telemetria nunca quebra o chat */ }
}

function cpconSetFieldError(input, errEl, msg) {
  if (errEl) errEl.textContent = msg || '';
  if (input) {
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    if (errEl && errEl.id) input.setAttribute('aria-describedby', errEl.id);
  }
}

function cpconShowInlineForm() {
  const container = document.getElementById('cpcon-msgs');
  const formRow = document.createElement('div');
  formRow.className = 'cpcon-row';
  formRow.id = 'cpcon-inline-form';
  formRow.innerHTML =
    '<div class="cpcon-av"><img src="/cpcon-previa-fr-gsc-20261123/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div>' +
    '<div class="cpcon-bbl cpcon-form-bbl">' +
    '  <div class="cpcon-form-group"><input type="text" id="cpcon-form-nome" placeholder="Nom *" maxlength="100" autocomplete="name"/><div id="cpcon-form-nome-err" class="cpcon-form-err"></div></div>' +
    '  <div class="cpcon-form-group"><input type="email" id="cpcon-form-email" placeholder="E-mail professionnel *" maxlength="200" autocomplete="email"/><div id="cpcon-form-email-err" class="cpcon-form-err"></div></div>' +
    '  <div class="cpcon-form-group"><input type="text" id="cpcon-form-empresa" placeholder="Entreprise *" maxlength="120" autocomplete="organization"/><div id="cpcon-form-empresa-err" class="cpcon-form-err"></div></div>' +
    '  <div class="cpcon-form-group">' +
    '    <label for="cpcon-form-tel">Téléphone *</label>' +
    '    <div class="cpcon-phone">' +
    '      <button type="button" id="cpcon-phone-cc" aria-haspopup="listbox" aria-expanded="false" aria-controls="cpcon-phone-list"></button>' +
    '      <input type="tel" id="cpcon-form-tel" name="telephone" placeholder="Téléphone *" maxlength="32" autocomplete="tel" inputmode="tel"/>' +
    '    </div>' +
    '    <div id="cpcon-phone-pop" class="cpcon-phone-pop" hidden>' +
    '      <input type="search" id="cpcon-phone-search" aria-label="Rechercher un pays" placeholder="Rechercher un pays" autocomplete="off"/>' +
    '      <ul id="cpcon-phone-list" role="listbox" aria-label="Pays"></ul>' +
    '    </div>' +
    '    <div id="cpcon-form-tel-err" class="cpcon-form-err" role="alert"></div>' +
    '  </div>' +
    '  <div class="cpcon-form-actions">' +
    '    <label class="cpcon-robot" for="cpcon-robot"><input type="checkbox" id="cpcon-robot" aria-describedby="cpcon-robot-err"/> Je ne suis pas un robot</label>' +
    '    <button id="cpcon-form-btn" onclick="cpconSubmitForm()">Continuer</button>' +
    '  </div>' +
    '  <div id="cpcon-robot-err" class="cpcon-form-err" role="alert"></div>' +
    '  <div class="cpcon-hp" aria-hidden="true">' +
    '    <input type="text" id="cpcon_hp_a" name="cpcon_hp_a" tabindex="-1" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true"/>' +
    '    <input type="text" id="cpcon_hp_b" name="cpcon_hp_b" tabindex="-1" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true"/>' +
    '    <input type="text" id="cpcon_hp_c" name="cpcon_hp_c" tabindex="-1" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true"/>' +
    '    <input type="text" id="cpcon_hp_d" name="cpcon_hp_d" tabindex="-1" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true"/>' +
    '  </div>' +
    '</div>';
  container.appendChild(formRow);
  cpconScrollDown();
  cpconCaptureTelemetry('capture_shown');
  cpconState.formShownAt = Date.now();
  document.getElementById('cpcon-robot').addEventListener('change', function (e) {
    if (e.target.checked) cpconSetFieldError(e.target, document.getElementById('cpcon-robot-err'), '');
  });
  const nome = document.getElementById('cpcon-form-nome');
  const email = document.getElementById('cpcon-form-email');
  const empresa = document.getElementById('cpcon-form-empresa');
  const tel = document.getElementById('cpcon-form-tel');
  const ccBtn = document.getElementById('cpcon-phone-cc');
  const search = document.getElementById('cpcon-phone-search');
  cpconState.userPhoneCountry = (cpconPhoneApi() && cpconPhoneApi().defaultCountry) || 'FR';
  cpconApplyPhoneCountry(cpconState.userPhoneCountry);
  cpconFillPhoneList('');
  tel.addEventListener('input', cpconOnPhoneInput);
  // 16/11/2026: teclado que compõe (Samsung etc.): máscara só quando a composição termina.
  tel.addEventListener('compositionend', function (e) { cpconOnPhoneInput({ target: e.target }); });
  ccBtn.addEventListener('click', cpconTogglePhoneList);
  search.addEventListener('input', function () { cpconFillPhoneList(search.value); });
  search.addEventListener('keydown', cpconPhoneSearchKey);
  nome.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); email.focus(); } });
  email.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); empresa.focus(); } });
  empresa.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tel.focus(); } });
  tel.addEventListener('keydown', cpconPhoneEnter);
  if (!window.__cpconPhoneDoc) {
    window.__cpconPhoneDoc = true;
    document.addEventListener('click', cpconPhoneDocClick);
  }
  // 17/10/2026 (form infalível): a Camile não rouba o foco de quem está
  // preenchendo um formulário da página (abertura automática).
  if (!cpconPageFormBusy()) nome.focus();
}

function cpconFold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function cpconApplyPhoneCountry(iso) {
  var api = cpconPhoneApi();
  if (!api) return;
  var found = null;
  for (var i = 0; i < api.countries.length; i++) {
    if (api.countries[i].iso === iso) { found = api.countries[i]; break; }
  }
  if (!found) return;
  cpconState.userPhoneCountry = found.iso;
  var btn = document.getElementById('cpcon-phone-cc');
  var tel = document.getElementById('cpcon-form-tel');
  if (btn) {
    btn.textContent = '';
    var flag = document.createElement('span');
    flag.setAttribute('aria-hidden', 'true');
    flag.textContent = found.flag + ' ';
    btn.appendChild(flag);
    btn.appendChild(document.createTextNode(found.name + ' +' + found.dial));
    btn.setAttribute('aria-label', 'Pays du téléphone : ' + found.name + ', +' + found.dial);
  }
  if (tel) {
    tel.placeholder = api.placeholder(found.iso);
    if (tel.value) tel.value = api.format(found.iso, tel.value);
  }
}

function cpconFillPhoneList(q) {
  var api = cpconPhoneApi();
  var list = document.getElementById('cpcon-phone-list');
  if (!api || !list) return;
  var query = cpconFold(q).replace(/^\+/, '');
  list.textContent = '';
  for (var i = 0; i < api.countries.length; i++) {
    var c = api.countries[i];
    var name = cpconFold(c.name);
    if (query && name.indexOf(query) === -1 && c.iso.toLowerCase().indexOf(query) === -1 && String(c.dial).indexOf(query) !== 0) continue;
    var li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.id = 'cpcon-phone-opt-' + c.iso;
    li.setAttribute('aria-selected', c.iso === cpconState.userPhoneCountry ? 'true' : 'false');
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cpcon-phone-opt';
    b.dataset.iso = c.iso;
    b.textContent = c.flag + '  ' + c.name + '  +' + c.dial;
    b.addEventListener('click', cpconPickPhoneCountry);
    li.appendChild(b);
    list.appendChild(li);
  }
  if (!list.firstChild) {
    var empty = document.createElement('li');
    empty.className = 'cpcon-phone-empty';
    empty.textContent = 'Aucun pays';
    list.appendChild(empty);
  }
}

function cpconTogglePhoneList() {
  var pop = document.getElementById('cpcon-phone-pop');
  var btn = document.getElementById('cpcon-phone-cc');
  if (!pop || !btn) return;
  var open = pop.hidden;
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    var search = document.getElementById('cpcon-phone-search');
    if (search) { search.value = ''; search.focus(); }
    cpconFillPhoneList('');
  }
}

function cpconClosePhoneList() {
  var pop = document.getElementById('cpcon-phone-pop');
  var btn = document.getElementById('cpcon-phone-cc');
  if (pop) pop.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function cpconPhoneDocClick(e) {
  var pop = document.getElementById('cpcon-phone-pop');
  var btn = document.getElementById('cpcon-phone-cc');
  if (!pop || pop.hidden) return;
  if (pop.contains(e.target) || (btn && btn.contains(e.target))) return;
  cpconClosePhoneList();
}

function cpconPickPhoneCountry(e) {
  var iso = e.currentTarget && e.currentTarget.dataset.iso;
  if (iso) cpconApplyPhoneCountry(iso);
  cpconClosePhoneList();
  var tel = document.getElementById('cpcon-form-tel');
  if (tel) tel.focus();
}

function cpconPhoneSearchKey(e) {
  var list = document.getElementById('cpcon-phone-list');
  if (!list) return;
  var opts = list.querySelectorAll('.cpcon-phone-opt');
  if (e.key === 'Escape') { e.preventDefault(); cpconClosePhoneList(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  e.preventDefault();
  var current = list.querySelector('.cpcon-phone-opt.is-active');
  var idx = 0;
  for (var i = 0; i < opts.length; i++) { if (opts[i] === current) idx = i; }
  if (e.key === 'ArrowDown') idx = Math.min(idx + (current ? 1 : 0), opts.length - 1);
  if (e.key === 'ArrowUp') idx = Math.max(idx - 1, 0);
  if (e.key === 'Enter' && opts[idx]) { opts[idx].click(); return; }
  for (var j = 0; j < opts.length; j++) opts[j].classList.toggle('is-active', j === idx);
  if (opts[idx]) opts[idx].scrollIntoView({ block: 'nearest' });
}

// 16/11/2026 — causa raiz das recusas telefono:phone_invalid em Android (ES 16/11,
// Samsung Galaxy no navegador do TikTok): teclados que digitam por "composição"
// (teclado Samsung com texto preditivo e outros IME) mandam cada dígito como
// texto em composição. Reescrever o campo (máscara) no meio da composição faz o
// teclado reinserir a "palavra" inteira: o número saía com dígitos repetidos
// (número errado ou inválido). Padrão CPCON (igual nos 6 sites): durante a
// composição o campo fica como a pessoa digitou; a máscara entra no fim da
// composição (compositionend). A validação do envio continua igual.
function cpconImeComposing(e) {
  return !!(e && (e.isComposing || e.inputType === 'insertCompositionText'));
}

// 16/11/2026: Enter/"Ir" do teclado no telefone com a caixa "Je ne suis pas un
// robot" desmarcada não envia às cegas (com o teclado aberto a caixa e o botão
// ficam fora da tela): fecha o teclado, leva a pessoa até a caixa e mostra o aviso.
function cpconPhoneEnter(e) {
  if (e.key !== 'Enter' || cpconImeComposing(e)) return;
  e.preventDefault();
  var robot = document.getElementById('cpcon-robot');
  if (robot && !robot.checked) {
    cpconSetFieldError(robot, document.getElementById('cpcon-robot-err'), 'Cochez la case « Je ne suis pas un robot » à côté du bouton pour envoyer.');
    cpconCaptureTelemetry('capture_rejected', { reason: 'robot_box', fields: ['robot_ok'], errors: ['robot_ok:robot_box'], phone_country: cpconState.userPhoneCountry });
    try { e.target.blur(); robot.focus(); robot.scrollIntoView({ block: 'center' }); } catch (err) { /* ok */ }
    return;
  }
  cpconSubmitForm();
}

function cpconOnPhoneInput(e) {
  if (cpconImeComposing(e)) return;
  var api = cpconPhoneApi();
  if (!api) return;
  var iso = cpconState.userPhoneCountry || api.defaultCountry;
  if (typeof api.type !== 'function') { e.target.value = api.format(iso, e.target.value); return; }
  // 16/10/2026 : « +351… » change le drapeau tout seul ; le « + » reste pendant la saisie.
  var t = api.type(iso, e.target.value);
  if (t.detected && t.country !== iso) {
    e.target.value = '';
    cpconApplyPhoneCountry(t.country);
  }
  e.target.value = t.display;
}

// 02/11/2026 — causa raiz das recusas "todos os campos inválidos" (MX 01-02/11):
// o painel abre sozinho (ou é aberto) e o toque/clique que a pessoa ia dar na
// página cai no botão de envio 0-4 s depois, com o formulário VAZIO. Nada ia
// ao servidor, mas a pessoa via 4-5 erros vermelhos e ia embora.
// Padrão CPCON (igual nos 6 sites):
//  - clique < CPCON_GHOST_MS após abrir o painel/mostrar o formulário = clique-fantasma:
//    não valida nem pinta erro; só registra form:ghost_click.
//  - formulário todo vazio = uma mensagem clara no 1º campo + foco; registra form:empty.
// Nunca envia ao servidor nesses casos. Validação normal segue igual.
var CPCON_GHOST_MS = 800;
var CPCON_EMPTY_MSG = 'Veuillez renseigner nom, email, entreprise et téléphone pour commencer la conversation.';
function cpconCaptureGuard() {
  var since = Date.now() - Math.max(cpconState.openedAt || 0, cpconState.formShownAt || 0);
  if (since < CPCON_GHOST_MS) {
    cpconCaptureTelemetry('capture_rejected', { reason: 'other', fields: ['form'], errors: ['form:ghost_click'] });
    return false;
  }
  var ids = ['cpcon-form-nome', 'cpcon-form-email', 'cpcon-form-empresa', 'cpcon-form-tel'];
  var empty = ids.every(function (id) { var el = document.getElementById(id); return !el || !String(el.value || '').trim(); });
  if (empty) {
    var n = document.getElementById('cpcon-form-nome');
    cpconSetFieldError(n, document.getElementById('cpcon-form-nome-err'), CPCON_EMPTY_MSG);
    cpconCaptureTelemetry('capture_rejected', { reason: 'other', fields: ['form'], errors: ['form:empty'] });
    if (n && n.focus) { try { n.focus(); n.scrollIntoView({ block: 'center' }); } catch (e) { /* ok */ } }
    return false;
  }
  return true;
}

async function cpconSubmitForm() {
  if (!cpconCaptureGuard()) return;
  const nomeInp = document.getElementById('cpcon-form-nome');
  const emailInp = document.getElementById('cpcon-form-email');
  const empresaInp = document.getElementById('cpcon-form-empresa');
  const telInp = document.getElementById('cpcon-form-tel');
  const nomeErr = document.getElementById('cpcon-form-nome-err');
  const emailErr = document.getElementById('cpcon-form-email-err');
  const empresaErr = document.getElementById('cpcon-form-empresa-err');
  const telErr = document.getElementById('cpcon-form-tel-err');
  const robotInp = document.getElementById('cpcon-robot');
  const robotErr = document.getElementById('cpcon-robot-err');
  cpconSetFieldError(nomeInp, nomeErr, ''); cpconSetFieldError(emailInp, emailErr, '');
  cpconSetFieldError(empresaInp, empresaErr, ''); cpconSetFieldError(telInp, telErr, '');
  cpconSetFieldError(robotInp, robotErr, '');
  const nome = validarNome(nomeInp.value);
  const email = validarEmail(emailInp.value);
  const empresa = validarEmpresa(empresaInp.value);
  const api = cpconPhoneApi();
  const selected = cpconState.userPhoneCountry || (api && api.defaultCountry) || 'FR';
  // 16/10/2026 : pays par l'indicatif tapé (+351…) ; sans indicatif = drapeau ; sans pays = FR.
  const phone = !api ? { ok: false, reason: 'other' }
    : (typeof api.resolve === 'function' ? api.resolve(selected, telInp.value)
      : (function () { var e = api.toE164(selected, telInp.value); return e ? { ok: true, e164: e, country: selected } : { ok: false, reason: 'phone' }; })());
  const tel = phone.ok ? phone.e164 : null;
  const iso = phone.ok ? phone.country : selected;
  const failed = []; // [champ, clé, élément] dans l'ordre de l'écran
  if (!nome) { cpconSetFieldError(nomeInp, nomeErr, 'Nom valide (min. 2 lettres)'); failed.push(['nome', 'name_invalid', nomeInp]); }
  if (!email) { cpconSetFieldError(emailInp, emailErr, 'E-mail professionnel valide'); failed.push(['email', 'email_invalid', emailInp]); }
  if (!empresa) { cpconSetFieldError(empresaInp, empresaErr, 'Entreprise valide (min. 2 lettres)'); failed.push(['empresa', 'company_invalid', empresaInp]); }
  if (!api) { cpconSetFieldError(telInp, telErr, 'Le champ téléphone n’est pas disponible. Rechargez la page.'); failed.push(['telephone', 'phone_api_missing', telInp]); }
  // 17/10/2026: campo vazio = obrigatório (não "inválido").
  else if (!String(telInp.value || '').replace(/[^0-9\u0660-\u0669\u06F0-\u06F9]/g, '')) { cpconSetFieldError(telInp, telErr, 'Le numéro de téléphone est obligatoire.'); failed.push(['telephone', 'phone_invalid', telInp]); }
  else if (!phone.ok && phone.reason === 'country') { cpconSetFieldError(telInp, telErr, 'Indicatif international non reconnu. Vérifiez le numéro ou choisissez le pays dans la liste.'); failed.push(['telephone', 'phone_country', telInp]); }
  else if (!phone.ok) { cpconSetFieldError(telInp, telErr, 'Indiquez un numéro de téléphone valide. Autre pays ? Tapez-le avec + et l’indicatif, ex. +351…'); failed.push(['telephone', 'phone_invalid', telInp]); }
  if (!robotInp || !robotInp.checked) {
    cpconSetFieldError(robotInp, robotErr, 'Cochez la case « Je ne suis pas un robot » à côté du bouton pour envoyer.');
    failed.push(['robot_ok', 'robot_box', robotInp]);
  }
  if (failed.length) {
    const keys = failed.map(function (f) { return f[1]; });
    const reason = keys.indexOf('robot_box') !== -1 ? 'robot_box'
      : keys.indexOf('phone_country') !== -1 ? 'country'
      : (keys.indexOf('phone_invalid') !== -1 || keys.indexOf('phone_api_missing') !== -1) ? 'phone' : 'other';
    cpconCaptureTelemetry('capture_rejected', {
      reason: reason,
      fields: failed.map(function (f) { return f[0]; }),
      errors: failed.map(function (f) { return f[0] + ':' + f[1]; }),
      phone_country: cpconState.userPhoneCountry,
    });
    const first = failed[0][2];
    if (first && first.focus) { try { first.focus(); first.scrollIntoView({ block: 'center' }); } catch (e) { /* ok */ } }
    return;
  }

  const hp = cpconReadTraps();
  cpconState.userName = nome;
  cpconState.userEmail = email;
  cpconState.userEmpresa = empresa;
  cpconState.userPhone = tel;
  cpconState.userPhoneCountry = iso;
  cpconCaptureTelemetry('capture_submitted', { phone_country: iso });

  document.getElementById('cpcon-inline-form')?.remove();
  cpconMeMsg(nome + ' — ' + email + ' — ' + empresa + ' — ' + tel);

  // Crée le lead initial dans le CRM (fire-and-forget — ne bloque pas le chat).
  // Token HMAC (GET /api/leads/form-token) + rate limit + honeypot + Zod.
  // Origin allowlist sozinho NÃO autentica.
  try {
    const leadFields = Object.assign({
        nome: nome,
        email: email,
        telefone: tel,
        telefone_pais: iso,
        robot_ok: true,
        empresa: empresa,
        origem: 'chatbot-fr',
        pagina_origem: window.location.href,
        _render_elapsed_ms: 5000,
      }, hp);
    const postLead = async function () {
      const form_token = await cpconFetchFormToken();
      return fetch(CRM_PROXY_URL + '/cpcon-previa-fr-gsc-20261123/chatbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(Object.assign({}, leadFields, { form_token: form_token })),
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (body) {
          return { status: r.status, body: body };
        });
      }).catch(function () { return null; });
    };
    // O lead é criado AQUI, antes de qualquer conversa. Retry só em falha de
    // rede ou 5xx — uma recusa honesta (4xx, ok:false) não é reenviada.
    let resp = await postLead();
    if (!resp || resp.status >= 500) {
      await new Promise(function (r) { setTimeout(r, 1500); });
      resp = await postLead();
    }
    var body = resp && resp.body;
    if (!body || body.ok !== true) cpconCaptureTelemetry('capture_rejected', { reason: 'other', errors: [resp ? 'server:rejected' : 'server:network'] });
    if (body && body.lead_id) cpconState.leadId = body.lead_id;
    if (body && body.session_token) cpconState.sessionToken = body.session_token;
    if (body && body.session_id) cpconState.sessionId = body.session_id;
    if (body && body.ok === true) {
      // dataLayer : generate_lead só quando o lead foi aceito de verdade.
      try {
        (window.dataLayer = window.dataLayer || []).push({
          event: 'generate_lead',
          form_name: 'chatbot_camile',
          lead_source: 'chatbot_camile',
          page_path: window.location.pathname,
        });
      } catch (e) { /* analytics optionnel */ }
    } else {
      var refused = (body && typeof body.error === 'string' && body.error)
        || "Nous n'avons pas pu enregistrer vos coordonnées. Écrivez-nous à contact@cpcongroup.com.";
      cpconAppendNotice(refused);
    }
  } catch (e) {}

  // Ouvre la conversation en appelant /api/chat avec un message vide (le backend répond E1)
  cpconState.stage = 'chat';
  cpconCallChat('');
}

// ── Appel à /api/chat ──────────────────────────────────────

async function cpconCallChat(userText, extra) {
  if (cpconState.busy) return;
  if (cpconState.transferred) {
    cpconSay('Vos coordonnées sont enregistrées. Un conseiller CPCON vous recontactera très prochainement.');
    return;
  }
  cpconState.busy = true;
  cpconDisableInput();
  cpconShowTyping();

  if (userText) cpconState.history.push({ role: 'user', content: userText });
  if (userText) cpconExtractContact(userText);

  let messages = cpconState.history.slice(-10);
  if (messages.length === 0) {
    messages = [{ role: 'user', content: '[début]' }];
  }

  const payload = {
    messages: messages,
    userContext: {
      nome: cpconState.userName,
      email: cpconState.userEmail,
      telefone: cpconState.userPhone,
      empresa: cpconState.userEmpresa || undefined,
    },
    cpcon_hp_a: cpconTrapValue('cpcon_hp_a'),
    cpcon_hp_b: cpconTrapValue('cpcon_hp_b'),
    cpcon_hp_c: cpconTrapValue('cpcon_hp_c'),
    cpcon_hp_d: cpconTrapValue('cpcon_hp_d'),
  };
  if (cpconState.sessionId) payload.session_id = cpconState.sessionId;
  if (cpconState.sessionToken) payload.session_token = cpconState.sessionToken;
  if (extra && extra.segment_choice) payload.segment_choice = extra.segment_choice;
  if (extra && extra.handoff_response) payload.handoff_response = extra.handoff_response;

  let data = null;
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(function () { return null; });
    if (!res.ok) {
      cpconHideTyping();
      cpconState.busy = false;
      cpconSay('J’ai rencontré un petit souci technique. Pas d’inquiétude, vos coordonnées sont enregistrées et notre équipe vous recontactera.', function () {
        cpconFireTransfer('erreur-backend');
      });
      return;
    }
  } catch (e) {
    cpconHideTyping();
    cpconState.busy = false;
    cpconSay('J’ai rencontré un souci de connexion. Vos coordonnées sont enregistrées et notre équipe vous recontactera.', function () {
      cpconFireTransfer('erreur-reseau');
    });
    return;
  }

  cpconHideTyping();
  cpconState.busy = false;
  cpconState.sessionId = data.session_id || cpconState.sessionId;
  cpconState.stage = data.stage || cpconState.stage;
  cpconState.lastActivityAt = Date.now();

  if (data.reply) {
    // chat-guard : on garde la signature serveur de la réponse ; sans elle,
    // le serveur ne renverra pas cette réplique au modèle.
    var turn = { role: 'assistant', content: data.reply };
    if (typeof data.reply_sig === 'string' && data.reply_sig) turn.sig = data.reply_sig;
    cpconState.history.push(turn);
    if (typeof data.turn_count === 'number') cpconState.turns = data.turn_count;
    if (typeof data.handoff_offered === 'boolean') cpconState.handoffOffered = data.handoff_offered;
    if (typeof data.conversation_ended === 'boolean') cpconState.conversationEnded = data.conversation_ended;
    if (data.tags) {
      cpconState.lastSegment = (data.tags.find && data.tags.find(function (t) { return /^segmento-/.test(t); }) || '').replace('segmento-', '') || cpconState.lastSegment || null;
      cpconState.lastTema = (data.tags.find && data.tags.find(function (t) { return /^tema-/.test(t); }) || '').replace('tema-', '') || cpconState.lastTema || null;
    }

    cpconSay(data.reply, function () {
      // Ordre de priorité :
      // 1. conversation_ended (refus enregistré côté backend)
      // 2. handoff_immediate (déclencheur T1-T5 ou repli LLM)
      // 3. transferred (legacy)
      // 4. showSegmentButtons (E2.5)
      // 5. offer_handoff_button (6e échange — propose Oui/Non)
      // 6. défaut — saisie réactivée pour le tour suivant
      if (data.conversation_ended) {
        cpconShowConversationEnded(data);
      } else if (data.handoff_immediate) {
        cpconHandleImmediateHandoff(data);
      } else if (data.transferred) {
        cpconState.transferred = true;
        cpconFireTransfer(data.tags || []);
      } else if (data.showSegmentButtons) {
        cpconShowSegmentButtons();
      } else if (data.offer_handoff_button) {
        cpconShowHandoffOffer(data);
      } else {
        cpconEnableInput();
      }
    });
  } else {
    cpconEnableInput();
  }
}

function cpconShowSegmentButtons() {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cpcon-seg-btns';
  const buttons = [
    { label: 'PME', value: 'pme' },
    { label: 'Grandes entreprises', value: 'grande' },
    { label: 'Secteur public', value: 'gobierno' },
    { label: 'Secteur associatif', value: 'terceiro-setor' },
  ];
  buttons.forEach(function (b) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = 'cpcon-seg-btn';
    btn.onclick = function () {
      row.remove();
      cpconMeMsg(b.label);
      cpconCallChat(b.label, { segment_choice: b.value });
    };
    row.appendChild(btn);
  });
  container.appendChild(row);
  cpconScrollDown();
  cpconDisableInput();
}

// ── Handoff (sans WhatsApp) ─────────────────────────────────
// Le lead étant déjà capturé au formulaire, le « handoff » confirme la
// prise de contact et propose un repli e-mail (mailto). Aucune redirection
// WhatsApp (le site France n'en a pas).

function cpconContactEmail() {
  return (window.CPCON_CONFIG && window.CPCON_CONFIG.contactEmail) || 'contact@cpcongroup.com';
}

function cpconBuildMailtoUrl() {
  const email = cpconContactEmail();
  const sujet = 'Demande via le site cpcongroup.fr';
  const corps = cpconBuildResumeConversation();
  return 'mailto:' + email + '?subject=' + encodeURIComponent(sujet) + '&body=' + encodeURIComponent(corps);
}

// Bouton CTA persistant « Laisser mes coordonnées / écrire un e-mail ».
function cpconAppendCtaButton(mode) {
  mode = mode || 'default';
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;

  const existing = document.getElementById('cpcon-cta-btn');
  if (existing && existing.parentElement) existing.parentElement.remove();

  const row = document.createElement('div');
  row.id = 'cpcon-cta-btn-row';
  row.style.cssText = 'padding:10px 12px;display:flex;justify-content:center;';

  const link = document.createElement('a');
  link.id = 'cpcon-cta-btn';
  link.href = cpconBuildMailtoUrl();
  link.className = 'cpcon-cta-btn' + (mode === 'highlighted' ? ' cpcon-cta-btn-highlight' : '');
  link.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
    '<path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5z"/>' +
    '</svg>' +
    '<span class="cpcon-cta-btn-text">' +
      '<span class="cpcon-cta-btn-main">Nous écrire un e-mail</span>' +
      '<span class="cpcon-cta-btn-sub">' + cpconContactEmail() + '</span>' +
    '</span>';
  link.onclick = function () {
    try {
      (window.dataLayer = window.dataLayer || []).push({
        event: 'click_email',
        source: 'chatbot_camile',
        page_path: window.location.pathname,
      });
    } catch (e) { /* analytics optionnel */ }
  };

  row.appendChild(link);
  container.appendChild(row);
  cpconScrollDown();
}

// Propose la prise de contact (Oui/Non) au 6e échange.
function cpconShowHandoffOffer(data) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  cpconState.handoffOffered = true;

  if (document.getElementById('cpcon-handoff-offer')) {
    cpconEnableInput();
    return;
  }

  const wrap = document.createElement('div');
  wrap.id = 'cpcon-handoff-offer';
  wrap.className = 'cpcon-handoff-offer';
  wrap.innerHTML =
    '<div class="cpcon-handoff-question">Souhaitez-vous qu’un conseiller CPCON vous recontacte pour approfondir votre projet ?</div>' +
    '<div class="cpcon-handoff-actions">' +
    '<button type="button" class="cpcon-handoff-yes-btn" id="cpcon-handoff-yes">Oui, être recontacté(e)</button>' +
    '<button type="button" class="cpcon-handoff-no-btn" id="cpcon-handoff-no">Non, merci</button>' +
    '</div>';
  container.appendChild(wrap);
  cpconScrollDown();
  cpconDisableInput();

  document.getElementById('cpcon-handoff-yes').onclick = function () { cpconAcceptHandoffButton(); };
  document.getElementById('cpcon-handoff-no').onclick = function () { cpconDeclineHandoffButton(); };
}

async function cpconAcceptHandoffButton() {
  const offer = document.getElementById('cpcon-handoff-offer');
  const yesBtn = document.getElementById('cpcon-handoff-yes');
  const noBtn = document.getElementById('cpcon-handoff-no');
  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;

  await cpconPostLeadResume({ accepted_handoff: true }).catch(function (err) {
    console.error('[Camile] accept POST failed', err);
  });

  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'camile_handoff',
      trigger_type: 'button_6th_turn_yes',
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics optionnel */ }

  if (offer) offer.remove();
  cpconState.transferred = true;
  cpconDisableInput();
  cpconSay('Parfait. Vos coordonnées sont enregistrées et un conseiller CPCON vous recontactera très prochainement. Vous pouvez aussi nous écrire directement :', function () {
    cpconAppendCtaButton('highlighted');
  });
}

async function cpconDeclineHandoffButton() {
  const offer = document.getElementById('cpcon-handoff-offer');
  const yesBtn = document.getElementById('cpcon-handoff-yes');
  const noBtn = document.getElementById('cpcon-handoff-no');
  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;

  await cpconPostLeadResume({ chat_completed_no_handoff: true }).catch(function (err) {
    console.error('[Camile] decline POST failed', err);
  });

  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'camile_chat_ended_no_handoff',
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics optionnel */ }

  if (offer) offer.remove();
  // Le backend marque conversation_ended et renvoie la phrase de clôture.
  cpconCallChat('Non, merci', { handoff_response: 'no' });
}

// Déclencheur T1-T5 ou repli LLM — le backend a déjà marqué transferred=true.
function cpconHandleImmediateHandoff(data) {
  cpconState.transferred = true;
  cpconDisableInput();

  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'camile_handoff',
      trigger_type: data.trigger_type || 'unknown',
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics optionnel */ }

  cpconPostLeadResume({ handoff_trigger_type: data.trigger_type || 'unknown' }).catch(function (err) {
    console.error('[Camile] immediate handoff POST failed', err);
  });
  cpconAppendCtaButton('highlighted');
}

// Conversation terminée (refus du client).
function cpconShowConversationEnded(_data) {
  cpconState.transferred = true;
  cpconState.conversationEnded = true;
  cpconDisableInput();

  const inp = document.getElementById('cpcon-inp');
  if (inp) inp.placeholder = 'Conversation terminée';

  if (!document.getElementById('cpcon-ended-badge')) {
    const container = document.getElementById('cpcon-msgs');
    if (container) {
      const badge = document.createElement('div');
      badge.id = 'cpcon-ended-badge';
      badge.className = 'cpcon-ended-badge';
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-live', 'polite');
      badge.textContent = 'Conversation terminée';
      container.appendChild(badge);
      cpconScrollDown();
    }
  }
}

// Résumé court de la conversation pour le lead / e-mail.
function cpconBuildResumeConversation() {
  const lines = ['Résumé de la conversation via Camile :'];
  if (cpconState.userName) lines.push('- Contact : ' + cpconState.userName);
  if (cpconState.userEmpresa) lines.push('- Entreprise : ' + cpconState.userEmpresa);
  if (cpconState.userEmail) lines.push('- E-mail : ' + cpconState.userEmail);
  if (cpconState.userPhone) lines.push('- Téléphone : ' + cpconState.userPhone);
  if (cpconState.lastSegment) lines.push('- Segment : ' + cpconState.lastSegment);
  if (cpconState.lastTema) lines.push('- Besoin : ' + cpconState.lastTema);
  lines.push('- Nombre d’échanges : ' + (cpconState.turns || cpconState.history.length));
  const derniere = (cpconState.history.filter(function (m) { return m.role === 'user'; }).slice(-1)[0] || {}).content;
  if (derniere) lines.push('- Dernier message : ' + String(derniere).slice(0, 200));
  return lines.join('\n');
}

// POST /api/leads/chatbot — enregistre le résumé de la conversation.
// Réutilise le même endpoint que la capture initiale (sendLeadToCRM côté serveur).
async function cpconPostLeadResume(opts) {
  opts = opts || {};
  const refus = !!opts.chat_completed_no_handoff;
  const tail = refus
    ? '\n\nLe client a décliné un rappel au 6e échange.'
    : '\n\nLe client souhaite être recontacté.';
  const payload = {
    nome: cpconState.userName,
    email: cpconState.userEmail,
    empresa: cpconState.userEmpresa || '',
    telefone: cpconState.userPhone,
    telefone_pais: cpconState.userPhoneCountry,
    robot_ok: true,
    mensagem: cpconBuildResumeConversation() + tail,
    origem: 'chatbot-fr',
    pagina_origem: window.location.href,
    segmento: cpconState.lastSegment || undefined,
    tema: cpconState.lastTema || undefined,
    cpcon_hp_a: cpconTrapValue('cpcon_hp_a'),
    cpcon_hp_b: cpconTrapValue('cpcon_hp_b'),
    cpcon_hp_c: cpconTrapValue('cpcon_hp_c'),
    cpcon_hp_d: cpconTrapValue('cpcon_hp_d'),
    _render_elapsed_ms: 5000,
  };
  if (cpconState.sessionId) payload.session_id = cpconState.sessionId;
  // chat-guard : le serveur construit le résumé du CRM à partir des répliques
  // (celles du bot vérifiées par signature). Plafond ~9 Ko (limite 16 Ko).
  payload.rappel = !refus;
  var turns = cpconState.history.slice(-40).map(function (m) {
    var t = { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) };
    if (m.role === 'assistant' && m.sig) t.sig = m.sig;
    return t;
  }).filter(function (t) { return t.content; });
  while (turns.length > 1 && JSON.stringify(turns).length > 9000) turns.shift();
  if (turns.length) payload.conversation_turns = turns;
  payload.form_token = await cpconFetchFormToken();
  const res = await fetch('/api/leads/chatbot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('POST /api/leads/chatbot HTTP ' + res.status);
  return res.json().catch(function () { return null; });
}

// ── Transfert (sans live panel) ─────────────────────────────
// Repli en cas d'erreur technique : enregistre le résumé et affiche le CTA e-mail.
async function cpconFireTransfer(_tagsOrReason) {
  if (cpconState._transferFired) return;
  cpconState._transferFired = true;
  cpconState.transferred = true;
  cpconDisableInput();

  await cpconPostLeadResume({ accepted_handoff: true }).catch(function () { /* déjà capturé au formulaire */ });

  setTimeout(function () {
    cpconAppendNotice('Vos coordonnées sont bien enregistrées.');
    cpconAppendCtaButton('highlighted');
  }, 300);
}

// ── Handler central ─────────────────────────────────────────

function cpconOnSend() {
  const inp = document.getElementById('cpcon-inp');
  if (!inp) return;
  const v = inp.value.trim();
  if (!v) return;
  if (v.length > 500) {
    cpconSay('Votre message est un peu long pour moi. Pourriez-vous le résumer en 500 caractères maximum ?');
    return;
  }
  inp.value = '';
  inp.style.height = 'auto';
  cpconMeMsg(v);
  cpconState.lastActivityAt = Date.now();
  if (cpconState.transferred) {
    cpconSay('Vos coordonnées sont enregistrées. Un conseiller CPCON vous recontactera très prochainement.');
    return;
  }
  cpconCallChat(v);
}

function cpconOnKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cpconOnSend(); }
}

// ── Utilitaires ─────────────────────────────────────────────

function cpconShowTyping() {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.id = 'cpcon-typing';
  row.className = 'cpcon-row';
  row.innerHTML = '<div class="cpcon-av"><img src="/cpcon-previa-fr-gsc-20261123/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div><div class="cpcon-bbl"><div class="cpcon-typing"><span></span><span></span><span></span></div></div>';
  container.appendChild(row);
  cpconScrollDown();
}
function cpconHideTyping() {
  const n = document.getElementById('cpcon-typing');
  if (n) n.remove();
}

function cpconEnableInput() {
  const inp = document.getElementById('cpcon-inp');
  const btn = document.getElementById('cpcon-send-btn');
  if (btn) btn.disabled = false;
  if (inp) {
    inp.disabled = false;
    inp.placeholder = 'Écrivez votre message';
    inp.focus();
  }
}

function cpconDisableInput() {
  const inp = document.getElementById('cpcon-inp');
  const btn = document.getElementById('cpcon-send-btn');
  if (btn) btn.disabled = true;
  if (inp) inp.disabled = true;
}

function cpconScrollDown() {
  const m = document.getElementById('cpcon-msgs');
  if (m) m.scrollTop = m.scrollHeight;
}

function cpconResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 80) + 'px';
}

function cpconEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cpconNl2br(s) { return s.replace(/\n/g, '<br>'); }

// À la fermeture de la page, clôture la session côté backend.
window.addEventListener('beforeunload', function () {
  if (cpconState.sessionId) {
    try {
      navigator.sendBeacon('/api/chat?session_id=' + encodeURIComponent(cpconState.sessionId));
    } catch (e) {}
  }
});
