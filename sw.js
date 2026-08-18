/* Service worker de Registro de Rutas
   - deja la app disponible sin señal
   - dispara la alarma de llegada aunque la app esté cerrada        */
const V = 'rr-v9';
const APP = './registro-rutas_1.html';
const SHELL = [
  './', APP, './manifest.webmanifest', './NOTIFICACION.mp3',
  './favicon.ico', './favicon.svg', './apple-touch-icon.png',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Poppins:wght@400;500;600;700;800&display=swap'
];
// las direcciones, rutas, tiles y el envío a Google Sheets siempre van a la red
const SIEMPRE_RED = /nominatim\.openstreetmap\.org|router\.project-osrm\.org|tile\.openstreetmap\.org|basemaps\.cartocdn\.com|script\.google(usercontent)?\.com/;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    // uno por uno: si un CDN falla, la instalación no se cae
    await Promise.all(SHELL.map(u => c.add(new Request(u, {cache:'reload'})).catch(()=>{})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) try { await self.registration.navigationPreload.disable(); } catch(err){}
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (SIEMPRE_RED.test(url.host + url.pathname)) return;

  // La app (HTML) va primero a la red: así una versión nueva llega sin tener que
  // desinstalar nada, y si no hay señal se usa la copia guardada.
  const esApp = req.mode === 'navigate' || /\.html?$/.test(url.pathname) || url.pathname === '/';
  if (esApp && url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(V);
      try {
        const r = await fetch(req, {cache:'no-store'});
        if (r && r.ok) c.put(req, r.clone());
        return r;
      } catch (err) {
        return (await c.match(req, {ignoreSearch:true})) || (await c.match(APP)) ||
               new Response('Sin conexión', {status:503, headers:{'Content-Type':'text/plain'}});
      }
    })());
    return;
  }

  // El resto (iconos, sonido, mapa, librerías) sí desde caché: es lo que no cambia.
  e.respondWith((async () => {
    const c = await caches.open(V);
    const hit = await c.match(req, {ignoreSearch:true});
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r && r.ok && (url.origin === location.origin)) c.put(req, r.clone());
      return r;
    } catch (err) {
      return hit || new Response('Sin conexión', {status:503, headers:{'Content-Type':'text/plain'}});
    }
  })());
});

/* ---------- viaje pendiente: se guarda en el Cache API para sobrevivir
   a que el navegador descargue el service worker ---------- */
const CLAVE = new Request('./__viaje_pendiente');
async function guardarViaje(v){
  const c = await caches.open(V);
  await c.put(CLAVE, new Response(JSON.stringify(v || null), {headers:{'Content-Type':'application/json'}}));
}
async function leerViaje(){
  try{
    const c = await caches.open(V);
    const r = await c.match(CLAVE);
    return r ? await r.json() : null;
  }catch(e){ return null; }
}

function opciones(v){
  return {
    body: v ? ('De '+corta(v.a)+' a '+corta(v.b)+' · '+v.km+' km · salida '+v.hsal)
            : 'Toca para registrar tu llegada y la hora de retorno.',
    tag: 'llegada',
    icon: './icon-192.png',
    badge: './icon-192.png',
    requireInteraction: true,
    vibrate: [300,140,300,140,500],
    data: {url: APP + '?llegada=1'},
    actions: [{action:'llegue', title:'✔ Registrar llegada'}]
  };
}
const corta = t => String(t||'').split(',')[0];

async function programar(v){
  await cerrarNotis();
  if(!v || !v.eta) return;
  const opts = opciones(v);
  if('showTrigger' in Notification.prototype && typeof TimestampTrigger !== 'undefined'){
    // alarma real: el sistema la muestra a la hora exacta, con la app cerrada
    opts.showTrigger = new TimestampTrigger(v.eta);
    await self.registration.showNotification('¿Ya llegaste?', opts);
  } else if(Date.now() >= v.eta){
    await self.registration.showNotification('¿Ya llegaste?', opts);
  }
}
async function cerrarNotis(){
  try{
    const ns = await self.registration.getNotifications({tag:'llegada', includeTriggered:true});
    ns.forEach(n => n.close());
  }catch(e){
    try{ (await self.registration.getNotifications({tag:'llegada'})).forEach(n=>n.close()); }catch(err){}
  }
}
async function revisar(){
  const v = await leerViaje();
  if(!v || !v.eta || v.avisado) return;
  if(Date.now() >= v.eta){
    await self.registration.showNotification('¿Ya llegaste?', opciones(v));
    await guardarViaje({...v, avisado:true});
  }
}

self.addEventListener('message', e => {
  const d = e.data || {};
  e.waitUntil((async () => {
    if(d.type === 'programar'){ await guardarViaje(d.viaje); await programar(d.viaje); }
    if(d.type === 'cancelar'){ await guardarViaje(null); await cerrarNotis(); }
    if(d.type === 'revisar'){ await revisar(); }
  })());
});

self.addEventListener('periodicsync', e => { if(e.tag === 'llegada') e.waitUntil(revisar()); });
self.addEventListener('sync',         e => { if(e.tag === 'llegada') e.waitUntil(revisar()); });

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || (APP + '?llegada=1');
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    for(const c of cs){
      if('focus' in c){ c.postMessage({type:'llegada'}); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
