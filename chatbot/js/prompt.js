// ============================================================
//  CPCON CHATBOT — prompt.js (placeholder)
//
//  Le system prompt de l'IA vit côté backend (src/lib/camile.ts,
//  appelé par /api/chat). Ce fichier est conservé uniquement pour
//  préserver l'ordre de chargement du widget
//  (Camile.tsx → config → prompt → ui → api → chatbot) et éviter
//  un 404 pendant l'expiration des anciens caches navigateur/CDN.
//  Version de cache : voir CACHE_VERSION dans Camile.tsx.
// ============================================================

// Stub conservé pour la compatibilité d'éventuels appels existants.
function cpconGetSystemPrompt(_userName) {
  return '';
}
