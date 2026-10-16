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
// DriverFlow transport v2.1: keep late JSONP callbacks harmless.
function jsonpPoll(id,part=0){
  return new Promise((resolve,reject)=>{
    const cb='__df_cb_'+strongId().slice(0,28);
    const script=document.createElement('script');
    let finished=false;
    let timeout;
    const done=(err,val)=>{
      if(finished)return;
      finished=true;
      clearTimeout(timeout);
      // A delayed Apps Script response must not call an undefined function.
      // Names are unique for the lifetime of this page and never reused.
      window[cb]=function(){};
      script.remove();
      if(err)reject(err);else resolve(val);
    };
    window[cb]=data=>done(null,data);
    script.onerror=()=>done(markNetworkError(Error('Не удалось получить ответ Apps Script (возможен временный сбой сети).')));
    const url=new URL(gasEndpoint());
    url.searchParams.set('poll','1');url.searchParams.set('rid',id);
    url.searchParams.set('part',String(part));url.searchParams.set('prefix',cb);
    url.searchParams.set('nonce',strongId());
    script.src=url.toString();script.async=true;
    timeout=setTimeout(()=>done(markNetworkError(Error('Слишком долго ожидаем ответ Google Apps Script.'))),11000);
    try{document.head.appendChild(script)}catch(err){done(markNetworkError(Error('Не удалось запросить ответ: '+err.message)))}
  });
}
const dfDelay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function dfWaitForPart(id,part,deadline){
  let attempts=0;
  let lastError=null;
  while(Date.now()<deadline){
    try{
      const result=await jsonpPoll(id,part);
      if(result&&result.ready&&Number(result.part)===part)return result;
    }catch(error){lastError=error}
    attempts++;
    if(Date.now()>=deadline)break;
    await dfDelay(Math.min(2400,850+attempts*220));
  }
  const detail=lastError?' Последняя ошибка: '+lastError.message:'';
  throw markNetworkError(Error('Не удалось подтвердить ответ Google Apps Script. Проверьте интернет и доступность /exec.'+detail));
}
async function callApi(fn,...args){
  const url=gasEndpoint();
  if(!isValidGasUrl(url))throw Error('Сначала укажите ссылку Google Apps Script /exec в настройках.');
  if(!navigator.onLine)throw markNetworkError(Error('Нет подключения к сети.'));
  const id=strongId();
  const encoded=new URLSearchParams({payload:JSON.stringify({id,fn,args})});
  let postError=null;
  const controller=new AbortController();
  const postTimer=setTimeout(()=>controller.abort(),24000);
  try{
    // Submit only once: an ambiguous failure may have already reached Apps Script.
    await fetch(url,{method:'POST',mode:'no-cors',redirect:'follow',credentials:'omit',
      cache:'no-store',referrerPolicy:'no-referrer',body:encoded,signal:controller.signal});
  }catch(error){
    postError=error;
    // Before reporting failure, poll the original request id for the result.
  }finally{clearTimeout(postTimer)}
  const deadline=Date.now()+(postError?26000:78000);
  let first;
  try{first=await dfWaitForPart(id,0,deadline)}catch(error){
    if(postError)throw markNetworkError(Error('Не удалось подтвердить отправку в Apps Script: '+postError.message+'. '+error.message));
    throw error;
  }
  if(!Number.isInteger(first.total)||first.total<1||first.total>150){
    throw markNetworkError(Error('Некорректное количество частей ответа Apps Script.'));
  }
  const chunks=[first.chunk];
  for(let part=1;part<first.total;part++){
    const value=await dfWaitForPart(id,part,deadline);
    if(value.total!==first.total)throw markNetworkError(Error('Ответ сервера изменился во время загрузки.'));
    chunks.push(value.chunk);
  }
  let data;
  try{data=JSON.parse(chunks.join(''))}catch(error){throw markNetworkError(Error('Ответ Apps Script повреждён.'))}
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
