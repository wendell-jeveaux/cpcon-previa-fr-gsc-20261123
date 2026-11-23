// ============================================================
//  CPCON CHATBOT — Configuration (site France / fr-FR)
//  Modifiez ici pour personnaliser sans toucher à la logique
// ============================================================

const CPCON_CONFIG = {

  // ── Identité de la conseillère ───────────────────────────
  agentName:    'Camile',
  agentInitials:'CA',
  companyName:  'CPCON',

  // ── WhatsApp ─────────────────────────────────────────────
  // Le site France n'utilise PAS WhatsApp. Laissé vide volontairement :
  // le CTA de handoff devient « laisser ses coordonnées » / e-mail.
  whatsappNumber: '',

  // ── Contact (utilisé par le CTA de handoff) ──────────────
  contactEmail: 'contact@cpcongroup.com',

  // ── Liens ────────────────────────────────────────────────
  privacyUrl: 'https://cpcongroup.fr/politique-de-confidentialite',
  siteUrl:    'https://cpcongroup.fr',

  // ── Mots-clés qui déclenchent un contact immédiat ────────
  // Vouvoiement : le client demande à parler à un humain / commercial / conseiller.
  contactKeywords: /parler [àa]|humain|commercial|conseiller|appeler|téléphoner|telephoner|rappel|contact|urgent|assistance|joindre|me rappeler|un agent|une personne/i,

  // ── API LLM ──────────────────────────────────────────────
  // Le modèle et la clé sont gérés par le backend (/api/chat).
  // Ne jamais exposer la clé côté frontend.
  aiMaxTokens: 200,
};
