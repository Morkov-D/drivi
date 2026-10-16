/* DriverFlow GitHub Pages <-> GAS transport. No cookies, no readable cross-origin fetch. */
'use strict';
const GAS_ENDPOINT_KEY='df_gas_endpoint_v2';
function gasEndpoint(){try{return localStorage.getItem(GAS_ENDPOINT_KEY)||''}catch(e){return ''}}
function isValidGasUrl(input){return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/i.test(String(input||'').trim())}
function apiScopeId(){const parts=gasEndpoint().split('/');return parts[5]||'unconfigured'}
function markNetworkError(error){error.networkError=true;return error}
function strongId(){
  if(!self.crypto||!crypto.getRandomValues)throw Error('Безопасный генератор идентификаторов недоступен.');
  const bytes=new Uint8Array(20);crypto.getRandomValues(bytes);
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
function jsonpPoll(id,part=0){
  return new Promise((resolve,reject)=>{
    const cb='__df_cb_'+strongId().slice(0,28);
    const script=document.createElement('script');
    let finished=false;
    const clean=()=>{script.remove();delete window[cb];clearTimeout(timeout)};
    const done=(err,val)=>{if(finished)return;finished=true;clean();err?reject(err):resolve(val)};
    const timeout=setTimeout(()=>done(markNetworkError(Error('Тайм-аут проверки ответа Apps Script'))),12000);
    window[cb]=(data)=>done(null,data);
    script.onerror=()=>done(markNetworkError(Error('Ответ сервера недоступен (проверьте публикацию /exec).')));
    const url=new URL(gasEndpoint());
    url.searchParams.set('poll','1');url.searchParams.set('rid',id);
    url.searchParams.set('part',String(part));url.searchParams.set('prefix',cb);
    url.searchParams.set('nonce',strongId());
    script.src=url.toString();script.async=true;
    document.head.appendChild(script);
  });
}
async function callApi(fn,...args){
  const url=gasEndpoint();
  if(!isValidGasUrl(url))throw Error('Сначала укажите ссылку Google Apps Script /exec в настройках.');
  if(!navigator.onLine)throw markNetworkError(Error('Нет подключения к сети.'));
  const id=strongId();
  const encoded=new URLSearchParams({payload:JSON.stringify({id,fn,args})});
  try{
    // Simple form POST doesn't trigger a CORS preflight. Response is opaque; poll separately.
    await fetch(url,{method:'POST',mode:'no-cors',redirect:'follow',credentials:'omit',
      cache:'no-store',referrerPolicy:'no-referrer',body:encoded});
  }catch(e){throw markNetworkError(Error('Не удалось отправить запрос в Apps Script: '+e.message))}
  const until=Date.now()+65000;
  let first;
  while(Date.now()<until){
    first=await jsonpPoll(id,0);
    if(first&&first.ready)break;
    await new Promise(r=>setTimeout(r,1400));
  }
  if(!first||!first.ready)throw markNetworkError(Error('Сервер не подтвердил запрос. Повторите синхронизацию.'));
  const chunks=[first.chunk];
  for(let part=1;part<first.total;part++){
    let val=await jsonpPoll(id,part);
    if(!val||!val.ready||val.part!==part)throw markNetworkError(Error('Потеряна часть ответа сервера.'));
    chunks.push(val.chunk);
  }
  let data;
  try{data=JSON.parse(chunks.join(''))}catch(e){throw markNetworkError(Error('Ответ Apps Script повреждён.'))}
  if(!data.ok){const err=Error(data.error||'Ошибка сервера');err.networkError=false;throw err}
  return data.value;
}
function showApiSetup(){
  const setup=document.getElementById('apiSetup'), login=document.getElementById('login'), shell=document.getElementById('shell');
  setup.classList.remove('hidden');login.classList.add('hidden');shell.classList.add('hidden');
  document.getElementById('apiUrl').value=gasEndpoint();
  document.getElementById('apiCancel').classList.toggle('hidden', !gasEndpoint());
}
function hideApiSetup(){document.getElementById('apiSetup').classList.add('hidden')}
document.addEventListener('click',e=>{
  if(e.target.id!=='apiCancel')return;
  hideApiSetup();
  if(typeof state!=='undefined' && state.user) switchView(true);
  else document.getElementById('login').classList.remove('hidden');
});
document.addEventListener('submit',async e=>{
  if(e.target.id!=='apiSetupForm')return;
  e.preventDefault();e.stopImmediatePropagation();
  const url=document.getElementById('apiUrl').value.trim().replace(/\/$/,'');
  const feedback=document.getElementById('apiFeedback');
  if(!isValidGasUrl(url)){feedback.textContent='Введите ссылку вида https://script.google.com/macros/s/.../exec';return}
  if(typeof state!=='undefined'&&state.queue?.length&&gasEndpoint()!==url){feedback.textContent='Сначала отправьте все локальные действия перед сменой сервера.';return}
  const prev=gasEndpoint(),button=document.getElementById('apiSave');button.disabled=true;button.textContent='Проверяем соединение…';feedback.textContent='';
  try{
    localStorage.setItem(GAS_ENDPOINT_KEY,url);
    const result=await callApi('apiHealth');
    if(!result||result.app!=='DriverFlow')throw Error('Указанный адрес не является API DriverFlow.');
    if(prev!==url){localStorage.removeItem('df_token');localStorage.removeItem('df_user');}
    hideApiSetup();location.reload();
  }catch(err){
    if(prev)localStorage.setItem(GAS_ENDPOINT_KEY,prev);else localStorage.removeItem(GAS_ENDPOINT_KEY);
    feedback.textContent='Не удалось подключиться: '+err.message;
  }finally{button.disabled=false;button.textContent='Подключить сервер'}
},true);
