// ============================================================
//  CPCON CHATBOT — UI / Rendu des messages (site France / fr-FR)
//  Dépendances : config.js
// ============================================================

// Ajoute un message du bot avec animation de saisie
function cpconSay(txt, cb) {
  const tid = 'cpcon-typ-' + Date.now();
  const container = document.getElementById('cpcon-msgs');

  const typingRow = document.createElement('div');
  typingRow.className = 'cpcon-row';
  typingRow.id = tid;
  typingRow.innerHTML = `
    <div class="cpcon-av"><img src="/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div>
    <div class="cpcon-bbl">
      <div class="cpcon-typing"><span></span><span></span><span></span></div>
    </div>`;
  container.appendChild(typingRow);
  cpconScrollDown();

  // Délai proportionnel à la longueur du texte (min 600ms, max 1800ms)
  const delay = Math.min(Math.max(txt.length * 20, 600), 1800);
  setTimeout(() => {
    document.getElementById(tid)?.remove();
    cpconAddBot(txt);
    if (cb) cb();
  }, delay);
}

// Message du bot (sans animation de saisie)
function cpconAddBot(txt) {
  const container = document.getElementById('cpcon-msgs');
  const row = document.createElement('div');
  row.className = 'cpcon-row';
  row.innerHTML = `
    <div class="cpcon-av"><img src="/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div>
    <div class="cpcon-bbl">${cpconNl2br(cpconEsc(txt))}</div>`;
  container.appendChild(row);
  cpconScrollDown();
}

// Message du client
function cpconMeMsg(txt) {
  const container = document.getElementById('cpcon-msgs');
  const row = document.createElement('div');
  row.className = 'cpcon-row me';
  row.innerHTML = `
    <div class="cpcon-av me"></div>
    <div class="cpcon-bbl">${cpconEsc(txt)}</div>`;
  container.appendChild(row);
  cpconScrollDown();
}
