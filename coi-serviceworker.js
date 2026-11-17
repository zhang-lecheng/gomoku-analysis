/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Cross-origin isolation for local static assets on hosts without COOP/COEP headers. */
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', event => {
    if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
    event.respondWith(fetch(event.request).then(response => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Embedder-Policy','require-corp');
      headers.set('Cross-Origin-Opener-Policy','same-origin');
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    }));
  });
} else if (!window.crossOriginIsolated && window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./coi-serviceworker.js').then(registration => {
    if (registration.active && !navigator.serviceWorker.controller) location.reload();
    else navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {once:true});
  }).catch(error => console.warn('Cross-origin isolation unavailable:',error));
}
