'use strict';
let driverFirebasePromise=null;
async function ensureFirebase(){
  const cfg=self.DRIVERFLOW_FIREBASE_CONFIG;
  if(!cfg||!self.DRIVERFLOW_VAPID_KEY)throw Error('Push пока не настроен. Заполните public/firebase-config.js перед публикацией.');
  if(driverFirebasePromise)return driverFirebasePromise;
  driverFirebasePromise=(async()=>{
    async function load(src){
      return new Promise((resolve,reject)=>{
        const s=document.createElement('script');s.src=src;s.async=true;
        s.onload=resolve;s.onerror=()=>reject(Error('Не удалось загрузить Firebase SDK'));
        document.head.appendChild(s);
      });
    }
    if(!self.firebase){
      await load('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
      await load('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
    }
    if(!firebase.apps.length)firebase.initializeApp(cfg);
    const supported=await firebase.messaging.isSupported();
    if(!supported)throw Error('Push не поддерживается данным браузером. На iPhone установите приложение на экран «Домой».');
    return firebase.messaging();
  })().catch(e=>{driverFirebasePromise=null;throw e});
  return driverFirebasePromise;
}
function pushDeviceId(){
  const key='df_device_v2_'+apiScopeId();
  let value=localStorage.getItem(key);
  if(!value){value=strongId();localStorage.setItem(key,value)}
  return value;
}
async function enableDriverPush(){
  try{
    if(!state.token)throw Error('Сначала войдите в приложение.');
    if(!navigator.onLine)throw Error('Для первого включения уведомлений нужен интернет.');
    if(!('Notification' in self))throw Error('Уведомления не поддерживаются браузером.');
    // Called synchronously as the user clicks the button, before network awaits.
    const permission=await Notification.requestPermission();
    if(permission!=='granted')throw Error('Разрешение на уведомления не предоставлено.');
    if(!('serviceWorker' in navigator))throw Error('Service Worker не поддерживается.');
    const registration=await navigator.serviceWorker.register('./sw.js');
    const messaging=await ensureFirebase();
    const fcmToken=await messaging.getToken({vapidKey:self.DRIVERFLOW_VAPID_KEY,serviceWorkerRegistration:registration});
    if(!fcmToken)throw Error('Firebase не выдал токен устройства.');
    const reply=await callApi('apiPush',state.token,'register',{deviceId:pushDeviceId(),fcmToken});
    if(!reply.ok)throw Error('Не удалось сохранить регистрацию.');
    toast('Уведомления включены для этого устройства');
  }catch(e){toast('Push: '+e.message,'error')}
}
async function testDriverPush(){
  try{
    if(!state.token)throw Error('Сначала войдите.');
    const result=await callApi('apiPush',state.token,'test',{deviceId:pushDeviceId()});
    toast(result.message||'Тест отправлен',result.ok?'ok':'error');
  }catch(e){toast('Проверка уведомления: '+e.message,'error')}
}

async function disableDriverPush(){
  try{
    if(!state.token)throw Error('Сначала войдите.');
    await callApi('apiPush',state.token,'unregister',{deviceId:pushDeviceId()});
    toast('Уведомления на этом устройстве выключены');
  }catch(e){toast('Отключение Push: '+e.message,'error')}
}
