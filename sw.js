/* DriverFlow offline-first application shell. Never cache Google Apps Script responses. */
const CACHE='driverflow-shell-2026-10-v2.1-transport';
const ASSETS=['./','./index.html','./styles.css','./client.js','./transport.js',
              './push.js','./firebase-config.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('driverflow-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const req=event.request, url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin)return;
  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(res=>{
      if(res.ok){const saved=res.clone();caches.open(CACHE).then(cache=>cache.put('./index.html',saved)).catch(()=>{})}
      return res;
    }).catch(()=>caches.match('./index.html')));return;
  }
  event.respondWith(caches.match(req).then(cached=>cached||fetch(req)));
});
self.addEventListener('push',event=>{
  let raw={};try{raw=event.data?event.data.json():{}}catch(e){}
  const data=raw.data||raw.notification||raw;
  const title=String(data.title||'DriverFlow');
  const body=String(data.body||'Новое уведомление о задаче');
  const url=new URL('./',self.registration.scope).href;
  event.waitUntil(self.registration.showNotification(title,{
    body,icon:'./icon-192.png',badge:'./icon-192.png',tag:'driverflow-'+(data.taskId||Date.now()),
    data:{url,taskId:data.taskId||''}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();const target=event.notification.data?.url||new URL('./',self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{
    const current=clients.find(c=>c.url.startsWith(self.registration.scope));
    if(current)return current.focus();return self.clients.openWindow(target);
  }));
});
