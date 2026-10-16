'use strict';
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {
  token:'', user:null, tasks:[], serverTasks:[], cities:[], staff:[], versions:{}, page:'tasks',
  search:'', focus:'ALL', city:'ALL', syncPromise:null, lastSync:null,
  historyRows:[], historyPage:1, historyTotal:0, historyFilters:null,
  modalTaskId:null, ready:false, busy:false, queue:[], queueSyncing:false, offlineMode:false, networkFailed:false
};
const navItems = [
  {id:'tasks',icon:'▦',label:'Задачи'},
  {id:'mine',icon:'◉',label:'Мои задачи',driver:true},
  {id:'dashboard',icon:'▥',label:'Дашборд',manager:true},
  {id:'history',icon:'◷',label:'История',manager:true},
  {id:'settings',icon:'⚙',label:'Настройки',manager:true}
];
const isManager = () => state.user && state.user.role === 'MANAGER';
const activeStaff = () => state.staff.filter(s => s.active === 'TRUE' && s.role === 'DRIVER');
const isMine = t => !!(state.user && t.driverId === state.user.employeeId);
const priorityRank = {'Срочно':0,'Средний':1,'Обычный':2};
const statusRank = {IN_PROGRESS:0, ASSIGNED:1, NEW:2, DONE:3, CANCELLED:4};
const ageMinutes = iso => iso ? Math.max(0,Math.floor((Date.now()-new Date(iso).getTime())/60000)) : 0;
const ageLevel = iso => ageMinutes(iso)>=360?'critical':ageMinutes(iso)>=120?'warning':'fresh';
const ageText = iso => ({fresh:'Недавно',warning:'Больше 2 ч',critical:'Больше 6 ч'})[ageLevel(iso)];
const priorityClass = p => ({'Срочно':'urgent','Средний':'medium','Обычный':'normal'}[p] || 'normal');
const statusText = s => ({NEW:'Свободна',ASSIGNED:'Назначена',IN_PROGRESS:'В работе',DONE:'Завершена',CANCELLED:'Отменена'}[s] || s);
const fmtDate = iso => iso ? new Date(iso).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
const fmtFullDate = iso => iso ? new Date(iso).toLocaleString('ru-RU') : '—';
const elapsed = iso => {
  if (!iso) return '—';
  const min = Math.max(0,Math.floor((Date.now()-new Date(iso).getTime())/60000));
  if (min < 60) return min + ' мин';
  const hours = Math.floor(min/60);
  if (hours < 24) return hours + ' ч ' + (min%60) + ' мин';
  return Math.floor(hours/24) + ' д ' + (hours%24) + ' ч';
};
const nameInitial = value => String(value || '?').trim().slice(0,1).toUpperCase();
const requestId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2));
const cacheKey = () => 'df_snapshot_v2_' + apiScopeId() + '_' + (state.user ? state.user.employeeId : '');
const queueKey = () => 'df_offline_queue_v2_' + apiScopeId() + '_' + (state.user ? state.user.employeeId : '');
function storageGet(key){try{return localStorage.getItem(key)}catch(e){return null}}
function storageSet(key,val){try{localStorage.setItem(key,val)}catch(e){}}
function storageRemove(key){try{localStorage.removeItem(key)}catch(e){}}

// IndexedDB: одна запись на каждого сотрудника; fallback при запрете IDB браузером.
const localDb = {
  async open(){
    if (!window.indexedDB) throw Error('IndexedDB unavailable');
    return new Promise((resolve,reject)=>{
      const r=indexedDB.open('driverflow_local_v1',1);
      r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('snapshots'))r.result.createObjectStore('snapshots')};
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      r.onblocked=()=>reject(Error('Database blocked'));
    });
  },
  async get(key){
    try{
      const db=await this.open();
      return await new Promise((resolve,reject)=>{const t=db.transaction('snapshots','readonly'),r=t.objectStore('snapshots').get(key);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);t.oncomplete=()=>db.close()});
    }catch(e){try{return JSON.parse(storageGet('fallback_'+key)||'null')}catch(e2){return null}}
  },
  async set(key,obj){
    try{
      const db=await this.open();
      await new Promise((resolve,reject)=>{const t=db.transaction('snapshots','readwrite');t.objectStore('snapshots').put(obj,key);t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error)});
    }catch(e){
      try{localStorage.setItem('fallback_'+key,JSON.stringify(obj))}
      catch(err){throw new Error('Локальное хранилище недоступно или переполнено. Проверьте настройки браузера.')}
    }
  },
  async del(key){
    try{const db=await this.open();await new Promise((resolve,reject)=>{const t=db.transaction('snapshots','readwrite');t.objectStore('snapshots').delete(key);t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error)})}catch(e){}
    storageRemove('fallback_'+key);
  }
};
// Только Google Apps Script HTML Service. Без Cloudflare, Worker, fetch и внешнего API.
// Тайм-аут отвечает за UX при потере связи: при неизвестном результате
// водительская операция остаётся в локальной очереди с постоянным actionId.
function isOffline(){return !navigator.onLine||state.networkFailed}
function queueCount(){return state.queue.filter(x=>x.status!=='conflict').length}
async function loadQueue(){state.queue=await localDb.get(queueKey())||[];updateOfflineUi()}
async function storeQueue(){await localDb.set(queueKey(),state.queue);updateOfflineUi()}
function applyQueuedAction(t,entry){
  const user=state.user;
  if(!t||!user)return t;
  const task={...t};
  if(entry.action==='start'){
    task.status='IN_PROGRESS';task.driverId=user.employeeId;task.driverName=user.name;
    task.startedAt=entry.createdAt;task.assignedAt=task.assignedAt||entry.createdAt;
  }
  if(entry.action==='release'){
    task.status='NEW';task.driverId='';task.driverName='';task.startedAt='';task.assignedAt='';
    task.lastReason=entry.payload.reason||'';
  }
  if(entry.action==='complete'){task.status='DONE';task.finishedAt=entry.createdAt}
  task.revision=String(Number(task.revision||'0')+1);
  task._pending=true;
  return task;
}
function overlayQueue(serverTasks){
  let tasks=(serverTasks||[]).map(t=>({...t}));
  state.queue.filter(e=>e.status!=='conflict').forEach(e=>{
    const i=tasks.findIndex(t=>t.id===e.payload.taskId);
    if(i>=0){tasks[i]=applyQueuedAction(tasks[i],e)}
  });
  return tasks.filter(t=>!['DONE','CANCELLED'].includes(t.status) &&
    (isManager()||!t.driverId||t.driverId===state.user.employeeId));
}
function updateOfflineUi(){
  const pending=state.queue.length;
  const banner=$('#offlineBanner');
  if(banner){
    const offline=isOffline();
    banner.classList.toggle('hidden',!offline&&!pending);
    banner.innerHTML=offline?'◌ Нет связи с сервером. Можно просматривать сохранённые задания и отмечать выполнение. Изменения отправятся позже.':'';
    if(pending)banner.innerHTML+=(offline?' ':'')+`<button type="button" class="queue-open" data-action="view-queue">В очереди: ${pending} · посмотреть</button>`;
  }
  const status=$('#netStatus');
  if(status){
    status.className='net-status '+(isOffline()?'offline':'online');
    status.innerHTML='<span class="net-dot"></span> '+(isOffline()?'Без сети':pending?'Ожидает отправки: '+pending:'Обновлено');
  }
}
async function enqueueDriverAction(action,payload){
  if(isManager()||!['start','release','complete'].includes(action))throw Error('Офлайн-действие недоступно.');
  if(state.queue.length>=200)throw Error('Очередь достигла 200 действий. Подключитесь к сети и отправьте накопленные изменения.');
  const t=state.tasks.find(x=>x.id===payload.taskId);
  if(!t)throw Error('Нужно сначала открыть сохранённое задание.');
  const mine=isMine(t);
  if(action==='start'&&!(t.status==='NEW'||(mine&&t.status==='ASSIGNED')))throw Error('Эту задачу нельзя взять в работу.');
  if(action==='release'&&!(mine&&['ASSIGNED','IN_PROGRESS'].includes(t.status)))throw Error('Можно отказаться только от своего задания.');
  if(action==='complete'&&!(mine&&t.status==='IN_PROGRESS'))throw Error('Завершить можно только свою задачу в работе.');
  if(action==='release'&&!String(payload.reason||'').trim())throw Error('Укажите причину отказа.');
  const entry={id:requestId(),action,createdAt:new Date().toISOString(),
    payload:{...payload,actionId:payload.actionId||requestId(),performedAt:payload.performedAt||new Date().toISOString(),expectedRevision:t.revision},before:{...t},status:'pending',error:''};
  state.queue.push(entry);
  try{await storeQueue()}catch(err){state.queue.pop();throw Error('Не удалось сохранить действие на телефоне: '+err.message)}
  state.tasks=overlayQueue(state.serverTasks);
  // Очередь уже записана. Ошибка дополнительного кеша не отменяет действие.
  await saveCached().catch(e=>console.warn('Snapshot cache failed',e));
  closeModal();render();updateOfflineUi();
  toast('Сохранено на телефоне · отправится при появлении сети');
  if(navigator.onLine&&!state.networkFailed)flushQueue().catch(()=>{});
}
async function flushQueue(){
  if(state.queueSyncing||!state.token||!navigator.onLine)return;
  state.queueSyncing=true;
  try{
    while(state.queue.length){
      const entry=state.queue[0];
      if(!navigator.onLine||entry.status==='conflict')break;
      try{
        const result=await callApi('apiMutate',state.token,entry.action,entry.payload);
        state.networkFailed=false;
        if(result&&result.task){
          state.serverTasks=state.serverTasks.filter(t=>t.id!==result.task.id);
          if(!['DONE','CANCELLED'].includes(result.task.status)&&
            (isManager()||!result.task.driverId||result.task.driverId===state.user.employeeId))state.serverTasks.push(result.task);
        }
        // В первую очередь сохраняем факт подтверждения, чтобы после перезапуска
        // операция не выполнялась снова. Сервер дополнительно проверяет actionId.
        state.queue=state.queue.filter(q=>q.id!==entry.id);
        await storeQueue();
        state.tasks=overlayQueue(state.serverTasks);
        state.versions={}; // Следующая синхронизация потребует актуальный срез.
        await saveCached().catch(e=>console.warn('Snapshot cache failed',e));
        render();
      }catch(err){
        if(err.networkError||!navigator.onLine){state.networkFailed=true;break}
        if(/AUTH_REQUIRED/.test(err.message)){
          toast('Для отправки очереди нужно войти снова с тем же ID. Локальные действия сохраняются.','error');
          break;
        }
        entry.status='conflict';entry.error=err.message;
        await storeQueue();
        state.tasks=overlayQueue(state.serverTasks);
        await saveCached().catch(()=>{});
        render();
        toast('Нужно проверить действие: '+err.message,'error');
        break;
      }
    }
  }finally{state.queueSyncing=false;updateOfflineUi()}
}
function queueDialog(){
  const content=state.queue.length?state.queue.map(e=>{
    const task=state.tasks.find(t=>t.id===e.payload.taskId);
    const type=({start:'Взять в работу',release:'Отказ',complete:'Завершить'})[e.action];
    const index=state.queue.findIndex(q=>q.id===e.id);
    const dependent=state.queue.slice(index+1).some(q=>q.payload.taskId===e.payload.taskId);
    return `<div class="offline-queue-item"><strong>${escapeHtml(type)} · ${escapeHtml(task?.number||e.before?.number||e.payload.taskId)}</strong><span>${escapeHtml(fmtFullDate(e.createdAt))} · ${e.status==='conflict'?'Требует решения':'Ожидает отправки'}</span>${e.error?`<p>${escapeHtml(e.error)}</p>`:''}<button class="btn small light" data-action="discard-offline" data-id="${escapeHtml(e.id)}" ${dependent?'disabled title="Сначала удалите более поздние действия по этой задаче"':''}>Удалить из очереди</button></div>`;
  }).join(''):'<p class="muted">Очередь пуста.</p>';
  openModal(modalHeader('Офлайн-очередь','Действия хранятся на этом устройстве до подтверждения сервером')+content+
    `<div class="modal-actions"><button class="btn light" data-action="close-modal">Закрыть</button><button class="btn primary" data-action="flush-queue">Отправить сейчас</button></div>`);
}

function toast(message,type='ok'){
  const node=document.createElement('div');node.className='toast'+(type==='error'?' error':'');node.textContent=message;
  $('#toasts').appendChild(node);setTimeout(()=>node.remove(),4500);
}
function switchView(authenticated){
  $('#login').classList.toggle('hidden',authenticated);
  $('#shell').classList.toggle('hidden',!authenticated);
}
async function loadCached(){
  if(!state.user)return;
  const saved=await localDb.get(cacheKey());
  if(saved){
    // Совместимость с v1.5/v1.6: старый кеш не содержит serverTasks.
    state.serverTasks=saved.serverTasks||saved.tasks||[];
    if(!saved.serverTasks&&state.queue.length){
      // Миграция кеша v1.6: задачи могли быть сохранены уже с локальными изменениями.
      // Восстанавливаем серверную базу из состояния перед первым действием очереди.
      const firstByTask=new Map();
      state.queue.forEach(e=>{if(!firstByTask.has(e.payload.taskId)&&e.before)firstByTask.set(e.payload.taskId,e.before)});
      for(const [id,before] of firstByTask){
        state.serverTasks=state.serverTasks.filter(t=>t.id!==id);
        if(!['DONE','CANCELLED'].includes(before.status))state.serverTasks.push({...before,_pending:undefined});
      }
    }
    state.tasks=overlayQueue(state.serverTasks);
    state.cities=saved.cities||[];state.staff=saved.staff||[];
    state.versions=saved.versions||{};state.lastSync=saved.savedAt||null;
    state.ready=true;render();
  }
}
function saveCached(){
  if(!state.user)return;
  return localDb.set(cacheKey(),{tasks:state.tasks,serverTasks:state.serverTasks,cities:state.cities,staff:state.staff,
    versions:state.versions,savedAt:state.lastSync});
}
async function sync(force=false){
  if(!state.token)return;
  if(state.syncPromise){
    if(force){try{await state.syncPromise}catch(e){}return sync(true)}
    return state.syncPromise;
  }
  state.syncPromise=(async()=>{
    const statuses=$('#netStatus');if(statuses)statuses.innerHTML='<span class="net-dot"></span> Обновляем';
    document.querySelectorAll('.sync-button').forEach(b=>b.classList.add('is-spinning'));
    try{
      if(state.queue.length&&!state.queueSyncing)await flushQueue();
      const result=await callApi('apiSync',state.token,force?{}:state.versions);
      if(result.user.employeeId !== state.user.employeeId){throw Error('AUTH_REQUIRED: Изменён сотрудник')}
      state.user=result.user;storageSet('df_user',JSON.stringify(state.user));
      if(Array.isArray(result.tasks))state.serverTasks=result.tasks;
      state.tasks=overlayQueue(state.serverTasks);
      if(Array.isArray(result.cities))state.cities=result.cities;
      if(Array.isArray(result.staff))state.staff=result.staff;
      state.versions=result.versions;state.lastSync=new Date().toISOString();
      state.ready=true;state.networkFailed=false;
      await saveCached();
      render();updateOfflineUi();
      return result;
    }catch(e){
      if(String(e.message).includes('AUTH_REQUIRED')){
        toast('Срок входа истёк. Сохранённые задачи доступны; для отправки войдите снова под тем же ID.','error');
        const login=$('#loginId');if(login)login.value=state.user?.employeeId||'';
        switchView(false);
      }
      else{
        state.networkFailed=!!e.networkError||!navigator.onLine;
        updateOfflineUi();if(!state.ready)render();
        if(navigator.onLine)toast((state.networkFailed?'Нет ответа от сервера. ':'Ошибка обновления: ')+e.message,'error');
      }
      throw e;
    }finally{state.syncPromise=null;document.querySelectorAll('.sync-button').forEach(b=>b.classList.remove('is-spinning'))}
  })();
  return state.syncPromise;
}
function setNetStatus(mode){state.networkFailed=mode==='offline';updateOfflineUi()}

async function boot(){
  if(!gasEndpoint()){showApiSetup();return}
  const tok=storageGet('df_token'),userString=storageGet('df_user');
  if(tok&&userString){
    try{state.user=JSON.parse(userString);state.token=tok;switchView(true);await loadQueue();await loadCached();render();if(navigator.onLine)sync(false).catch(()=>{});else updateOfflineUi();}catch(e){console.error('Startup failed',e);switchView(false);toast('Не удалось загрузить локальные данные: '+e.message,'error')}
  }else{switchView(false)}
}
async function logOut(silent=false){
  if(!silent&&state.queue.length&&!confirm('Есть неотправленные действия ('+state.queue.length+'). При выходе они останутся на этом телефоне и отправятся только после входа под тем же ID. Выйти?'))return;
  const token=state.token,oldKey=state.user ? cacheKey() : null;
  state.token='';state.user=null;state.tasks=[];state.serverTasks=[];state.staff=[];state.cities=[];state.versions={};state.queue=[];
  storageRemove('df_token');storageRemove('df_user');
  // Сохраняем локальные задания и очередь для повторного входа этого сотрудника.
  switchView(false);closeModal();$('#loginPin').value='';
  if(!silent&&token)callApi('apiLogout',token).catch(()=>{});
}
function renderNavigation(){
  const items=navItems.filter(item=>(!item.manager||isManager())&&(!item.driver||!isManager()));
  const template=item=>`<button class="navitem ${state.page===item.id?'active':''}" data-action="navigate" data-page="${item.id}"><span class="navicon">${item.icon}</span>${item.label}</button>`;
  $('#sideNav').innerHTML=items.map(template).join('');
  $('#bottomNav').innerHTML=items.map(item=>`<button data-action="navigate" data-page="${item.id}" class="${state.page===item.id?'active':''}"><b>${item.icon}</b>${item.label}</button>`).join('');
  $('#sideName').textContent=state.user.name;
  $('#sideRole').textContent=isManager()?'Руководитель':'Водитель';
  $('#sideAvatar').textContent=nameInitial(state.user.name);
  $('#topAvatar').textContent=nameInitial(state.user.name);
  $('#topContext').textContent=items.find(x=>x.id===state.page)?.label||'Задачи';
}
function render(){
  if(!state.user)return;
  if(!isManager()&&['dashboard','history','settings'].includes(state.page))state.page='tasks';
  if(isManager()&&state.page==='mine')state.page='tasks';
  renderNavigation();
  const page=$('#page');
  if(!state.ready && !state.lastSync && !state.tasks.length){
    page.innerHTML=isOffline()?'<div class="empty"><div class="empty-icon">◌</div><h3>Нет сохранённых заданий</h3><p>Подключитесь к интернету для первой загрузки задач. После этого данные будут доступны при обрыве связи, пока страница открыта.</p></div>':renderPageSkeleton();
    return;
  }
  switch(state.page){
    case 'tasks':case 'mine':page.innerHTML=renderTasksPage();break;
    case 'dashboard':page.innerHTML=renderDashboard();break;
    case 'history':page.innerHTML=renderHistory();break;
    case 'settings':page.innerHTML=renderSettings();break;
  }
  updateTimers();
}
function renderPageSkeleton(){
  return `<div class="page-head"><div><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-subtitle"></div></div></div>
    <div class="skeleton-banner"><span class="inline-spinner" aria-hidden="true"></span><span>Загружаем задачи и справочники…</span></div>
    <div class="skeleton-grid">${Array.from({length:4},()=>'<div class="skeleton-card"><div class="skeleton skeleton-short"></div><div class="skeleton skeleton-main"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div>').join('')}</div>`;
}
function heading(title,subtitle,action=''){
  return `<div class="page-head"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="head-actions">${action}</div></div>`;
}
function addButton(){return isManager()?'<button class="btn primary" data-action="create-task">＋ Новая задача</button>':''}
function visibleTaskPool(){
  return state.tasks.filter(t=>!['DONE','CANCELLED'].includes(t.status) && (state.page!=='mine'||isMine(t)));
}
function taskCounters(){
  const all=visibleTaskPool();
  return {all:all.length, mine:all.filter(t=>isMine(t)).length,
    progress:all.filter(t=>isMine(t)&&t.status==='IN_PROGRESS').length,
    assigned:all.filter(t=>isMine(t)&&t.status==='ASSIGNED').length,
    free:all.filter(t=>t.status==='NEW').length,
    urgent:all.filter(t=>t.priority==='Срочно').length};
}
function activeTasksBase(){
  let result=visibleTaskPool();
  if(!isManager() && state.page==='tasks'){
    if(state.focus==='MINE')result=result.filter(isMine);
    if(state.focus==='FREE')result=result.filter(t=>t.status==='NEW');
    if(state.focus==='URGENT')result=result.filter(t=>t.priority==='Срочно');
  }
  if(state.search){
    const q=state.search.toLocaleLowerCase('ru').trim();
    result=result.filter(t=>[t.number,t.city,t.address,t.fromAddress,t.toAddress,t.details,t.driverName,t.lastReason].join(' ').toLocaleLowerCase('ru').includes(q));
  }
  return result;
}
function currentTasks(){
  let result=activeTasksBase();
  if(state.page==='tasks'&&state.city!=='ALL')result=result.filter(t=>t.city===state.city);
  return result.sort((a,b)=>{
    if(state.page==='mine')return (statusRank[a.status]??9)-(statusRank[b.status]??9) ||
      (priorityRank[a.priority]??9)-(priorityRank[b.priority]??9) || a.createdAt.localeCompare(b.createdAt);
    return (priorityRank[a.priority]??9)-(priorityRank[b.priority]??9) ||
      a.createdAt.localeCompare(b.createdAt) || (statusRank[a.status]??9)-(statusRank[b.status]??9);
  });
}
function topTaskMetrics(mine){
  const c=taskCounters();
  if(!isManager()){
    if(mine)return `<div class="driver-summary"><div class="driver-feature"><span class="driver-feature-label">МОИ ЗАДАЧИ</span><strong>${c.mine}</strong><span>${c.progress} в работе · ${c.assigned} ожидают начала</span></div><div class="driver-status"><span class="status-dot"></span> Управляйте своими заданиями в одном месте</div></div>`;
    return `<div class="driver-focus" role="group" aria-label="Быстрый выбор задач">
      ${[['MINE','Мои задачи',c.mine,'▣'],['FREE','Свободные',c.free,'◇'],['URGENT','Срочные',c.urgent,'⚑']].map(([f,label,count,icon])=>
        `<button type="button" class="focus-card ${state.focus===f?'selected':''}" data-action="focus" data-focus="${f}" aria-pressed="${state.focus===f}"><span class="focus-top"><span>${icon}</span><span class="focus-count">${count}</span></span><strong>${label}</strong><small>${f==='MINE'?'Назначены вам':f==='FREE'?'Доступны для принятия':'Высокий приоритет'}</small></button>`).join('')}
    </div>`;
  }
  return `<div class="task-overview">
    <div class="overview-card primary"><small>Всего активных</small><strong>${c.all}</strong><span>Во всех городах</span></div>
    <div class="overview-card"><small>Срочных</small><strong>${c.urgent}</strong><span>Первый приоритет</span></div>
    <div class="overview-card"><small>В работе</small><strong>${state.tasks.filter(t=>t.status==='IN_PROGRESS').length}</strong><span>Исполняются водителями</span></div>
    <div class="overview-card"><small>Свободных</small><strong>${c.free}</strong><span>Ожидают принятия</span></div>
  </div>`;
}
function cityRail(){
  if(state.page==='mine')return '';
  const list=activeTasksBase();
  const counts=list.reduce((map,t)=>(map[t.city]=(map[t.city]||0)+1,map),{});
  const ordered=['ALL', ...state.cities.filter(c=>counts[c])];
  // Сохраняем город в списке, если его фильтр выбран, но задач там больше нет.
  if(state.city!=='ALL' && !ordered.includes(state.city))ordered.push(state.city);
  return `<div class="city-rail-wrap"><div class="filter-eyebrow">ГОРОДА <small>нажмите, чтобы показать задачи</small></div><div class="city-rail" role="tablist" aria-label="Задачи по городам">${ordered.map(city=>{
    const active=state.city===city;
    const label=city==='ALL'?'Все города':city;
    const count=city==='ALL'?list.length:(counts[city]||0);
    return `<button type="button" class="city-pill ${active?'active':''}" data-action="city-filter" data-city="${escapeHtml(city)}" role="tab" aria-selected="${active?'true':'false'}"><span>${escapeHtml(label)}</span><b>${count}</b></button>`;
  }).join('')}</div></div>`;
}
function taskRoute(t){
  let from=String(t.fromAddress||'').trim();
  let to=String(t.toAddress||'').trim();
  // Отображение сохранённых до v1.5 заданий.
  if(!from && !to && t.address){
    if(t.type==='Забрать')from=t.address;
    else to=t.address;
  }
  return {from,to};
}
function taskRouteLabel(t){
  const route=taskRoute(t);
  return [route.from||'Не указано',route.to||'Не указано'].join(' → ');
}
function taskMapUrl(t){
  if(t.mapUrl && /^https:\/\/[^\s<>"']+$/i.test(t.mapUrl))return t.mapUrl;
  const route=taskRoute(t);
  const city=String(t.city||'').trim();
  const withCity=address=>[city,address].filter(Boolean).join(', ');
  if(route.from && route.to){
    return 'https://www.google.com/maps/dir/?api=1&origin='+encodeURIComponent(withCity(route.from))+'&destination='+encodeURIComponent(withCity(route.to))+'&travelmode=driving';
  }
  return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(withCity(route.from||route.to||t.address||''));
}
function routeMarkup(t,compact=false){
  const r=taskRoute(t);
  return `<span class="task-route ${compact?'compact':''}">
    <span class="route-stop from"><span class="route-marker"></span><span class="route-copy"><small>ОТКУДА</small><strong>${escapeHtml(r.from||'Адрес не указан')}</strong></span></span>
    <span class="route-stop to"><span class="route-marker"></span><span class="route-copy"><small>КУДА</small><strong>${escapeHtml(r.to||'Адрес не указан')}</strong></span></span>
  </span>`;
}
function taskActionButtons(t){
  if(isManager())return '';
  const mine=isMine(t);
  if(t.status==='IN_PROGRESS' && mine)return `<button type="button" class="quick-btn quick-done" data-action="confirm-complete" data-id="${escapeHtml(t.id)}">✓ Завершить</button><button type="button" class="quick-btn quick-release" data-action="quick-release" data-id="${escapeHtml(t.id)}">Отказаться</button>`;
  if(t.status==='NEW'||(t.status==='ASSIGNED' && mine))return `<button type="button" class="quick-btn quick-start" data-action="quick-start" data-id="${escapeHtml(t.id)}">↗ В работу</button>`;
  return '';
}
function card(t){
  const mine=isMine(t);
  const status=statusText(t.status);
  const volume=t.volume?`<span class="mini-tag">${escapeHtml(t.volume)}</span>`:'';
  const poa=t.powerOfAttorney?'<span class="mini-tag power-needed">Нужна доверенность</span>':'<span class="mini-tag neutral">Без доверенности</span>';
  const reason=t.lastReason?`<div class="task-note"><b>Причина последнего отказа:</b> ${escapeHtml(t.lastReason)}</div>`:'';
  const assignee=isManager()&&t.driverName?`<div class="task-assignee">Исполнитель: <b>${escapeHtml(t.driverName)}</b></div>`:'';
  const map=taskMapUrl(t);
  return `<article class="task-card ${mine?'owned':''} ${t.priority==='Срочно'?'card-urgent':''}">
    <div class="task-head"><span class="task-id">${escapeHtml(t.number)}${t._pending?' · ⏳ На устройстве':''}</span><span class="priority ${priorityClass(t.priority)}">${escapeHtml(t.priority)}</span></div>
    <button type="button" class="task-open-area" data-action="open-task" data-id="${escapeHtml(t.id)}" aria-label="Подробнее о задаче ${escapeHtml(t.number)}">
      <span class="task-meta-row"><span class="task-type">${t.type==='Забрать'?'↙ Забрать':'↗ Отвезти'}</span><span class="task-city-pill">${escapeHtml(t.city)}</span></span>
      ${routeMarkup(t,true)}
      <span class="task-description">${escapeHtml(t.details)}</span>
    </button>
    <div class="task-tags">${volume}${poa}</div>${reason}
    <div class="task-footer"><span class="age-indicator ${ageLevel(t.createdAt)}" data-created="${escapeHtml(t.createdAt)}" data-age-indicator="true"><span class="age-dot"></span><span class="age-copy">${elapsed(t.createdAt)}</span></span>
      <span class="status-tag ${t.status==='IN_PROGRESS'?'work':''}">${mine&&t.status==='IN_PROGRESS'?'● ':''}${escapeHtml(status)}</span></div>
    ${assignee}
    <div class="card-actions ${!isManager()&&mine&&t.status==='IN_PROGRESS'?'is-working':''}">${taskActionButtons(t)}<a class="quick-btn quick-map" href="${escapeHtml(map)}" target="_blank" rel="noopener noreferrer" aria-label="Открыть маршрут: ${escapeHtml(taskRouteLabel(t))}">⌖ Маршрут</a>${isManager()?`<button type="button" class="quick-btn quick-details" data-action="open-task" data-id="${escapeHtml(t.id)}">Подробнее →</button>`:''}</div>
  </article>`;
}
function taskSections(){
  const tasks=currentTasks();
  if(!tasks.length)return `<div class="empty"><div class="empty-icon">✓</div><h3>${state.page==='mine'?'Нет ваших задач':'Задачи не найдены'}</h3><p>${state.page==='mine'?'Свободные задания можно взять с главного экрана.':'Попробуйте выбрать другой город или сбросить фильтры.'}</p>${state.page==='tasks'&&(!isManager()&&state.focus!=='ALL'||state.city!=='ALL'||state.search)?'<button class="btn secondary" type="button" data-action="reset-filters">Сбросить фильтры</button>':''}</div>`;
  const names=[...new Set(tasks.map(t=>t.city))].sort((a,b)=>state.cities.indexOf(a)-state.cities.indexOf(b));
  return names.map(name=>{
    const list=tasks.filter(t=>t.city===name);
    const urgent=list.filter(t=>t.priority==='Срочно').length;
    const inWork=list.filter(t=>t.status==='IN_PROGRESS').length;
    return `<section class="city-section"><div class="city-title-wrap"><div class="city-title">${escapeHtml(name)} <small>${list.length}</small></div><div class="city-title-meta"><span>Срочных: <b>${urgent}</b></span><span>В работе: <b>${inWork}</b></span></div></div><div class="task-grid">${list.map(card).join('')}</div></section>`;
  }).join('');
}
function renderTasksPage(){
  const mine=state.page==='mine';
  const totalActive=state.tasks.filter(t=>!['DONE','CANCELLED'].includes(t.status)).length;
  const myCount=state.tasks.filter(t=>isMine(t)&&!['DONE','CANCELLED'].includes(t.status)).length;
  const title=mine?'Мои задачи':isManager()?'Все задачи':'Активные задачи';
  const subtitle=mine?`${myCount} задач · только назначенные вам`:`${totalActive} активных · ${state.lastSync?('обновлено '+fmtDate(state.lastSync)):'загружаем данные'}`;
  return heading(title,subtitle,addButton())+
    `${state.page==='tasks'?cityRail():''}${topTaskMetrics(mine)}
    <div class="toolbar product-toolbar"><div class="search"><input id="taskSearch" placeholder="Найти адрес, задачу или описание" value="${escapeHtml(state.search)}" aria-label="Поиск задач" autocomplete="off"></div><div class="sort-hint"><b>Порядок:</b> ${mine?'сначала в работе, затем по важности':'срочные → средние → обычные · сначала старые'}</div></div>
    <div class="age-legend"><span><i class="age-dot fresh"></i> до 2 часов</span><span><i class="age-dot warning"></i> 2–6 часов</span><span><i class="age-dot critical"></i> больше 6 часов</span><small>Время с создания, не срок исполнения</small></div>
    <div id="taskSections">${taskSections()}</div>`;
}
function metric(label,count,hint,style,icon){return `<div class="metric ${style||''}"><span class="metric-icon">${icon}</span><div class="metric-label">${label}</div><div class="metric-number">${count}</div><div class="metric-hint">${hint}</div></div>`}
function barRows(pairs,total){return pairs.map(([name,count],i)=>`<div class="bar-row"><span>${escapeHtml(name)}</span><span>${count}</span></div><div class="bar-track"><div class="bar-fill ${i===0?'warn':''}" style="width:${Math.round(count/Math.max(total,1)*100)}%"></div></div>`).join('')}
function renderDashboard(){
  const tasks=state.tasks.filter(t=>!['DONE','CANCELLED'].includes(t.status));
  const free=tasks.filter(t=>t.status==='NEW').length;
  const assigned=tasks.filter(t=>t.status==='ASSIGNED').length;
  const working=tasks.filter(t=>t.status==='IN_PROGRESS').length;
  const urgent=tasks.filter(t=>t.priority==='Срочно').length;
  const aged=tasks.filter(t=>ageLevel(t.createdAt)==='critical').length;
  const cities=Object.entries(tasks.reduce((obj,t)=>(obj[t.city]=(obj[t.city]||0)+1,obj),{})).sort((a,b)=>b[1]-a[1]);
  const priorities=['Срочно','Средний','Обычный'].map(p=>[p,tasks.filter(t=>t.priority===p).length]);
  const oldest=[...tasks].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,6);
  const pct=n=>Math.round(n/Math.max(1,tasks.length)*100);
  return heading('Диспетчерская','Нагрузка и состояние активных перевозок',addButton())+
    `<section class="manager-hero"><div><span class="hero-eyebrow">ОПЕРАТИВНАЯ СВОДКА</span><h2>${tasks.length} <small>активных задач</small></h2><p>Все города, исполнители и приоритеты — в одном обзоре.</p></div><div class="hero-side"><strong>${aged}</strong><span>задач созданы больше 6 часов назад</span></div></section>
    <div class="dashboard-metrics">
      <div class="dashboard-metric"><div class="db-icon blue">◇</div><span>Свободные</span><strong>${free}</strong><small>Ожидают принятия</small></div>
      <div class="dashboard-metric"><div class="db-icon amber">◷</div><span>Назначенные</span><strong>${assigned}</strong><small>Пока не начаты</small></div>
      <div class="dashboard-metric"><div class="db-icon green">↗</div><span>В работе</span><strong>${working}</strong><small>Водители выполняют</small></div>
      <div class="dashboard-metric"><div class="db-icon red">⚑</div><span>Срочные</span><strong>${urgent}</strong><small>Первый приоритет</small></div>
    </div>
    <div class="dashboard-columns">
      <section class="panel dashboard-panel"><div class="panel-title-row"><div><h3>Города</h3><p>Количество активных заданий</p></div><span class="muted">${cities.length} городов</span></div>
        ${cities.length?cities.map(([name,count])=>`<button type="button" class="city-progress" data-action="dashboard-city" data-city="${escapeHtml(name)}"><span class="city-progress-top"><strong>${escapeHtml(name)}</strong><b>${count} <small>(${pct(count)}%)</small></b></span><span class="progress-track"><span class="progress-fill" style="width:${pct(count)}%"></span></span></button>`).join(''):'<div class="dashboard-empty">Активных задач нет</div>'}
      </section>
      <section class="panel dashboard-panel"><div class="panel-title-row"><div><h3>Важность</h3><p>Сколько задач каждого приоритета</p></div></div>
        <div class="priority-donut" style="--urgent:${pct(urgent)}%;--medium:${pct(priorities[1][1])}%"><div class="donut-hole"><strong>${tasks.length}</strong><small>всего</small></div></div>
        <div class="priority-legend">${priorities.map(([name,count])=>`<div><i class="priority-key ${priorityClass(name)}"></i><span>${escapeHtml(name)}</span><strong>${count}</strong></div>`).join('')}</div>
        <div class="dashboard-note">Важно: приоритет влияет на порядок задач, а не на доступность.</div>
      </section>
    </div>
    <section class="panel dashboard-panel dashboard-oldest"><div class="panel-title-row"><div><h3>Дольше всего ожидают</h3><p>Время с момента создания задачи</p></div><div class="age-legend compact"><span><i class="age-dot fresh"></i> до 2 ч</span><span><i class="age-dot warning"></i> 2–6 ч</span><span><i class="age-dot critical"></i> 6+ ч</span></div></div>
    ${oldest.length?oldest.map((t,i)=>`<div class="old-task-row"><span class="old-rank">${i+1}</span><div class="old-task-main"><strong>${escapeHtml(taskRouteLabel(t))}</strong><small>${escapeHtml(t.city)} · ${escapeHtml(t.type)} · ${escapeHtml(t.number)}</small></div><span class="age-indicator ${ageLevel(t.createdAt)}" data-created="${escapeHtml(t.createdAt)}" data-age-indicator="true"><span class="age-dot"></span><span class="age-copy">${elapsed(t.createdAt)}</span></span><button type="button" class="btn small light" data-action="open-task" data-id="${escapeHtml(t.id)}">Открыть</button></div>`).join(''):'<div class="dashboard-empty">Пока нечего отслеживать</div>'}
    </section>`;
}
function defaultHistoryFilters(){
  const to=new Date(),from=new Date(to.getTime()-29*86400000);
  const key=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return {from:key(from),to:key(to),dateBasis:'CREATED',city:'',priority:'',type:'',status:'CLOSED',driverId:'',search:''};
}
function filterSelect(name,selected,items){return `<select name="${name}">${items.map(([v,label])=>`<option value="${escapeHtml(v)}" ${selected===v?'selected':''}>${escapeHtml(label)}</option>`).join('')}</select>`}
function renderHistory(){
  if(!state.historyFilters)state.historyFilters=defaultHistoryFilters();
  const f=state.historyFilters;
  const fields=`<form id="historyForm"><div class="filter-grid">
    <label>С даты<input type="date" name="from" required value="${escapeHtml(f.from)}"></label>
    <label>По дату<input type="date" name="to" required value="${escapeHtml(f.to)}"></label>
    <label>Дата отбора${filterSelect('dateBasis',f.dateBasis,[['CREATED','Создания'],['FINISHED','Завершения']])}</label>
    <label>Статус${filterSelect('status',f.status,[['CLOSED','Завершённые и отменённые'],['ALL','Все'],['NEW','Свободные'],['ASSIGNED','Назначенные'],['IN_PROGRESS','В работе'],['DONE','Завершённые'],['CANCELLED','Отменённые']])}</label>
    <label>Город${filterSelect('city',f.city,[['','Все города'],...state.cities.map(c=>[c,c])])}</label>
    <label>Важность${filterSelect('priority',f.priority,[['','Все'],['Срочно','Срочно'],['Средний','Средний'],['Обычный','Обычный']])}</label>
    <label>Тип${filterSelect('type',f.type,[['','Все'],['Забрать','Забрать'],['Отвезти','Отвезти']])}</label>
    <label>Водитель${filterSelect('driverId',f.driverId,[['','Все'],...state.staff.filter(s=>s.role==='DRIVER').map(s=>[s.employeeId,s.name])])}</label>
    <label style="grid-column:span 2">Поиск<input name="search" value="${escapeHtml(f.search)}" placeholder="Номер, адрес, описание"></label>
    </div><div class="inline-form" style="justify-content:flex-end"><button class="btn secondary" type="submit">Применить фильтры</button><button class="btn primary" type="button" data-action="export">↓ Скачать CSV</button></div></form>`;
  return heading('История задач','Отчёты, фильтры и выгрузка за выбранный период')+
    `<section class="panel">${fields}</section><section class="panel"><h3>Результаты · ${state.historyTotal}</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>Номер</th><th>Город</th><th>Откуда</th><th>Куда</th><th>Тип</th><th>Статус</th><th>Водитель</th><th>Создана</th><th>Завершена</th></tr></thead><tbody>${state.historyRows.length?state.historyRows.map(t=>`<tr><td>${escapeHtml(t.number)}</td><td>${escapeHtml(t.city)}</td><td class="wrap-cell">${escapeHtml(taskRoute(t).from||'—')}</td><td class="wrap-cell">${escapeHtml(taskRoute(t).to||'—')}</td><td>${escapeHtml(t.type)}</td><td>${escapeHtml(statusText(t.status))}</td><td>${escapeHtml(t.driverName||'—')}</td><td>${escapeHtml(fmtFullDate(t.createdAt))}</td><td>${escapeHtml(fmtFullDate(t.finishedAt))}</td></tr>`).join(''):'<tr><td colspan="9" style="text-align:center;padding:35px;color:#8995a5">Нет строк. Нажмите «Применить фильтры».</td></tr>'}</tbody></table></div>
    <div class="pager"><span>Страница ${state.historyPage} из ${Math.max(1,Math.ceil(state.historyTotal/60))}</span><div><button class="btn small light" data-action="history-page" data-page="${state.historyPage-1}" ${state.historyPage<=1?'disabled':''}>← Назад</button> <button class="btn small light" data-action="history-page" data-page="${state.historyPage+1}" ${state.historyPage*60>=state.historyTotal?'disabled':''}>Вперёд →</button></div></div></section>`;
}
function renderSettings(){
  return heading('Настройки','Справочник городов и управление доступом сотрудников')+
    `<section class="panel"><h3>Города · ${state.cities.length}/10</h3><div class="setting-list">${state.cities.map(c=>`<span class="city-chip">${escapeHtml(c)} <button data-action="disable-city" data-city="${escapeHtml(c)}" title="Убрать город">×</button></span>`).join('')}</div>
    <form id="cityForm" class="inline-form" style="margin-top:18px"><label>Добавить город<input name="city" maxlength="80" required placeholder="Название города"></label><button class="btn primary" type="submit">Добавить</button></form></section>
    <section class="panel"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 style="margin:0">Сотрудники</h3><button class="btn primary small" data-action="staff-create">＋ Добавить</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>ID</th><th>Сотрудник</th><th>Роль</th><th>Статус</th><th>Действия</th></tr></thead><tbody>${state.staff.map(s=>`<tr><td>${escapeHtml(s.employeeId)}</td><td>${escapeHtml(s.name)}</td><td>${s.role==='MANAGER'?'Руководитель':'Водитель'}</td><td>${s.active==='TRUE'?'Активен':'Отключён'}</td><td><button class="btn small light" data-action="staff-edit" data-id="${escapeHtml(s.employeeId)}">Изменить</button> <button class="btn small ${s.active==='TRUE'?'danger':'success'}" data-action="staff-toggle" data-id="${escapeHtml(s.employeeId)}" ${s.employeeId===state.user.employeeId?'disabled':''}>${s.active==='TRUE'?'Отключить':'Включить'}</button></td></tr>`).join('')}</tbody></table></div></section>`;
}
function updateModalViewport(){
  if($('#overlay').classList.contains('hidden'))return;
  const viewport=window.visualViewport;
  const overlay=$('#overlay');
  if(viewport && window.innerWidth<=800){
    overlay.style.height=Math.round(viewport.height)+'px';
    overlay.style.top=Math.round(viewport.offsetTop)+'px';
  }else{overlay.style.height='';overlay.style.top=''}
}
function openModal(html){
  $('#modal').innerHTML=html;
  $('#overlay').classList.remove('hidden');
  $('#overlay').setAttribute('aria-hidden','false');
  document.body.classList.add('modal-open');
  $('#modal').scrollTop=0;
  updateModalViewport();
}

function closeModal(){
  state.modalTaskId=null;
  $('#overlay').classList.add('hidden');
  $('#overlay').setAttribute('aria-hidden','true');
  $('#modal').innerHTML='';
  document.body.classList.remove('modal-open');
  $('#overlay').style.height='';$('#overlay').style.top='';
}
function modalHeader(title,desc=''){return `<div class="modal-header"><div><h2>${title}</h2>${desc?`<p>${desc}</p>`:''}</div><button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button></div>`}
function renderCreateModal(existing=null){
  const drivers=activeStaff();
  const t=existing||{};
  if(existing)state.modalTaskId=existing.id;
  openModal(modalHeader(existing?'Редактирование задачи':'Новая задача',existing?'Изменения сохранятся в истории действий':'Заполните основные поля задания')+
  `<form id="${existing?'editTaskForm':'createTaskForm'}" data-request-id="${requestId()}"><div class="form-grid">
   <label>Тип задачи *${filterSelect('type',t.type||'Забрать',[['Забрать','Забрать'],['Отвезти','Отвезти']])}</label>
   <label>Важность *${filterSelect('priority',t.priority||'Обычный',[['Обычный','Обычный'],['Средний','Средний'],['Срочно','Срочно']])}</label>
   <label>Город *${filterSelect('city',t.city||'',state.cities.map(c=>[c,c]))}</label>
   ${existing?'':`<label>Водитель <span class="optional">(необязательно)</span>${filterSelect('driverId','',[['','Не назначать'],...drivers.map(s=>[s.employeeId,s.name])])}</label>`}
   <div class="route-form-section wide"><div class="route-form-heading"><span>⌖</span><div><strong>Маршрут</strong><small>Укажите точку отправления и назначения</small></div></div>
     <label class="route-form-field">Адрес откуда *<input name="fromAddress" required maxlength="350" enterkeyhint="next" autocomplete="street-address" placeholder="Откуда забрать или выехать" value="${escapeHtml(taskRoute(t).from)}"></label>
     <label class="route-form-field">Адрес куда *<input name="toAddress" required maxlength="350" enterkeyhint="next" autocomplete="off" placeholder="Куда отвезти или приехать" value="${escapeHtml(taskRoute(t).to)}"></label>
   </div>
   <label class="wide">Ссылка на карты <span class="optional">(необязательно — маршрут сформируется автоматически)</span><input name="mapUrl" type="url" maxlength="1000" placeholder="https://yandex.ru/maps/..." value="${escapeHtml(t.mapUrl||'')}"></label>
   <label class="wide">Информация / что сделать *<textarea name="details" required maxlength="4000" placeholder="Что забрать или отвезти, контакты, уточнения">${escapeHtml(t.details||'')}</textarea></label>
   <label>Объём <span class="optional">(необязательно)</span><input name="volume" maxlength="100" placeholder="Например, 50 кубов" value="${escapeHtml(t.volume||'')}"></label>
   <label>Доверенность <span class="optional">(необязательно)</span><input name="powerOfAttorney" maxlength="350" placeholder="Номер, кому или где получить" value="${escapeHtml(t.powerOfAttorney||'')}"></label>
  </div><div class="modal-actions"><button type="button" class="btn light" data-action="close-modal">Отмена</button><button type="submit" class="btn primary">${existing?'Сохранить':'Создать задачу'}</button></div></form>`);
}
function detailField(label,value){return `<div class="detail-field"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value||'—')}</strong></div>`}
function taskDetail(id){
  const t=state.tasks.find(x=>x.id===id)||state.historyRows.find(x=>x.id===id);
  if(!t){toast('Задача отсутствует в текущем списке. Обновите данные.','error');return}
  state.modalTaskId=id;
  const mine=isMine(t),driver=!isManager();
  let actions='';
  if(driver&&['NEW','ASSIGNED'].includes(t.status)&&(!t.driverId||mine))actions+='<button class="btn primary" data-action="start-task">↗ Взять в работу</button>';
  if(driver&&mine&&t.status==='IN_PROGRESS')actions+=`<button class="btn success" data-action="confirm-complete" data-id="${escapeHtml(t.id)}">✓ Завершить</button>`;
  if(driver&&mine&&['IN_PROGRESS','ASSIGNED'].includes(t.status))actions+='<button class="btn outline" data-action="reason-dialog" data-kind="release">Отказаться с причиной</button>';
  if(isManager()&&['NEW','ASSIGNED'].includes(t.status))actions+='<button class="btn secondary" data-action="edit-task">Изменить</button>';
  if(isManager()&&t.status==='ASSIGNED')actions+='<button class="btn light" data-action="unassign">Снять назначение</button>';
  if(isManager()&&['ASSIGNED','IN_PROGRESS'].includes(t.status))actions+='<button class="btn outline" data-action="reason-dialog" data-kind="forceRelease">Освободить</button>';
  if(isManager()&&['NEW','ASSIGNED','IN_PROGRESS'].includes(t.status))actions+='<button class="btn danger" data-action="reason-dialog" data-kind="cancel">Отменить задачу</button>';
  let assign='';
  if(isManager()&&['NEW','ASSIGNED'].includes(t.status)){
    assign=`<form id="assignForm" class="inline-form"><label>Назначить водителю${filterSelect('driverId','',[['','Выберите водителя'],...activeStaff().map(s=>[s.employeeId,s.name])])}</label><button class="btn secondary" type="submit">Назначить</button></form>`;
  }
  const map=`<a class="detail-link" target="_blank" rel="noopener noreferrer" href="${escapeHtml(taskMapUrl(t))}">⌖ Открыть в навигаторе</a>`;
  const releaseHint=driver&&mine&&['IN_PROGRESS','ASSIGNED'].includes(t.status)?'<div class="modal-note info">Если отказаться от задачи, она останется в списке активных и будет доступна для повторного назначения.</div>':'';
  const reasonHint=t.lastReason?`<div class="modal-note warn"><b>Последняя причина:</b> ${escapeHtml(t.lastReason)}</div>`:'';
  openModal(modalHeader(escapeHtml(t.number),`<span class="priority ${priorityClass(t.priority)}">${escapeHtml(t.priority)}</span> · ${escapeHtml(statusText(t.status))}`)+
    `<div class="detail-topline"><span class="task-type">${escapeHtml(t.type)}</span><span class="task-city-pill">${escapeHtml(t.city)}</span></div>
    ${routeMarkup(t)}${map}${releaseHint}${reasonHint}
    <h3 style="font-size:13px;margin:24px 0 6px">Что нужно сделать</h3><div class="detail-text">${escapeHtml(t.details)}</div>
    <div class="detail-grid">${detailField('Создана',fmtFullDate(t.createdAt))}${detailField('Прошло времени',elapsed(t.createdAt))}
    ${detailField('Объём',t.volume||'Не указан')}${detailField('Доверенность',t.powerOfAttorney||'Не требуется')}
    ${detailField('Водитель',t.driverName||'Не назначен')}${detailField('Взята в работу',fmtFullDate(t.startedAt))}
    ${detailField('Назначена',fmtFullDate(t.assignedAt))}${t.finishedAt?detailField('Закрыта',fmtFullDate(t.finishedAt)):detailField('Статус',statusText(t.status))}</div>
    ${assign}<div class="modal-actions"><button class="btn light" data-action="close-modal">Закрыть</button>${actions}</div>`);
}
function confirmComplete(id){
  const t=state.tasks.find(x=>x.id===id);
  if(!t||!isMine(t)||t.status!=='IN_PROGRESS'){toast('Задание уже изменилось. Обновите список.','error');return}
  state.modalTaskId=id;
  openModal(modalHeader('Завершить задачу?',`<span class="priority ${priorityClass(t.priority)}">${escapeHtml(t.priority)}</span> · ${escapeHtml(t.city)}`)+
    `${routeMarkup(t)}<div class="modal-note info">Подтвердите выполнение. Задание исчезнет из активного списка, а руководитель увидит исполнителя и время завершения.</div>
      <div class="modal-actions"><button type="button" class="btn light" data-action="close-modal">Вернуться</button><button type="button" class="btn success" data-action="complete-task">✓ Да, завершить</button></div>`);
}
function reasonModal(kind){
  const title=kind==='release'?'Отказаться от выполнения':kind==='forceRelease'?'Освободить задачу':'Отменить задачу';
  const desc=kind==='release'?'Задача останется активной и вернётся в общий список задач.':'Причина останется в журнале действий';
  const btnLabel=kind==='release'?'Подтвердить отказ':'Подтвердить';
  openModal(modalHeader(title,desc)+
    `<form id="reasonForm" data-kind="${kind}"><label>Причина *<textarea name="reason" required maxlength="700" placeholder="Кратко объясните причину"></textarea></label>
     <div class="modal-actions"><button class="btn light" type="button" data-action="close-modal">Назад</button><button class="btn ${kind==='cancel'?'danger':'primary'}" type="submit">${btnLabel}</button></div></form>`);
}
function staffModal(person=null){
  if(!isManager()){toast('Добавлять сотрудников может только руководитель.','error');return}
  const editing=!!person;
  const s=person||{employeeId:'',name:'',role:'DRIVER'};
  openModal(modalHeader(editing?'Редактировать сотрудника':'Добавить сотрудника',
    editing?'Измените данные или установите новый PIN.':'Создайте доступ для водителя или руководителя.')+
    `<form id="staffForm" class="staff-form">
      <div class="staff-form-intro"><span class="staff-form-symbol">♧</span><div><strong>${editing?'Карточка сотрудника':'Новый пользователь'}</strong><small>После сохранения сотрудник сможет войти по ID и назначенному PIN, если он установлен.</small></div></div>
      <div class="form-grid">
        <label>ID сотрудника *<input name="employeeId" inputmode="text" required maxlength="40" pattern="[A-Za-z0-9_-]{2,40}" value="${escapeHtml(s.employeeId)}" placeholder="Например, 1002" ${editing?'readonly':''} autocomplete="off"></label>
        <label>Роль *${filterSelect('role',s.role,[['DRIVER','Водитель'],['MANAGER','Руководитель']])}</label>
        <label class="wide">ФИО сотрудника *<input name="name" required maxlength="100" value="${escapeHtml(s.name)}" placeholder="Фамилия Имя" autocomplete="name"></label>
        <label class="wide"><span id="staffPinTitle">${editing?'Новый PIN (оставьте пустым, чтобы не менять)':'PIN-код'}</span><input id="staffPin" name="pin" type="password" minlength="8" maxlength="100" autocomplete="new-password" placeholder="Не менее 8 символов"><small id="staffPinHelp" class="form-help"></small></label>
      </div>
      <div class="modal-actions"><button type="button" class="btn light" data-action="close-modal">Отмена</button><button type="submit" class="btn primary">${editing?'Сохранить изменения':'Добавить сотрудника'}</button></div>
    </form>`);
  const form=$('#staffForm');
  form.dataset.originalRole=s.role;
  form.dataset.editing=editing?'true':'false';
  updateStaffPinRequirement();
  const name=form.elements.namedItem('name');if(name&&!editing)name.focus({preventScroll:true});
}
function updateStaffPinRequirement(){
  const form=$('#staffForm');if(!form)return;
  const role=form.elements.namedItem('role').value;
  const editing=form.dataset.editing==='true';
  const originalRole=form.dataset.originalRole;
  const required=role==='MANAGER'&&(!editing||originalRole!=='MANAGER');
  const pin=$('#staffPin'),help=$('#staffPinHelp');
  pin.required=required;
  const label=$('#staffPinTitle');
  if(label)label.textContent=required?'PIN-код руководителя *':(editing?'Новый PIN (пустой — не менять)':'PIN-код (необязательно)');
  if(help)help.textContent=required?'Для руководителя обязателен PIN не короче 8 символов.':
    editing?'Оставьте пустым, если менять PIN не нужно.':
    'Водитель может входить только по ID, но для безопасности лучше задать PIN (8+ символов).';
}
function setBusy(busy,label='Сохраняем изменения…'){
  state.busy=busy;
  document.body.classList.toggle('working',busy);
  const view=$('#actionLoading');
  if(view){
    view.classList.toggle('hidden',!busy);
    view.setAttribute('aria-hidden',busy?'false':'true');
    if(busy)$('#loadingTitle').textContent=label;
  }
  // Выключаем только те кнопки, которые до запроса были доступны.
  document.querySelectorAll('button[type="submit"],button[data-action="start-task"],button[data-action="complete-task"],button[data-action="quick-start"],button[data-action="confirm-complete"],button[data-action="reason-dialog"],button[data-action="unassign"]').forEach(btn=>{
    if(busy){if(!btn.disabled){btn.disabled=true;btn.dataset.busyDisabled='1'}}
    else if(btn.dataset.busyDisabled==='1'){btn.disabled=false;delete btn.dataset.busyDisabled}
  });
}

async function mutate(action,values={},optimistic=false){
  if(state.busy)return;
  const id=values.taskId||state.modalTaskId;
  const old=state.tasks.find(t=>t.id===id);
  const payload={...values};
  if(id&&!payload.taskId)payload.taskId=id;
  if(old&&!payload.expectedRevision)payload.expectedRevision=old.revision;
  if(!isManager()&&['start','release','complete'].includes(action)){payload.actionId=payload.actionId||requestId();payload.performedAt=payload.performedAt||new Date().toISOString()}
  if(!isManager()&&['start','release','complete'].includes(action)){
    try{await enqueueDriverAction(action,payload)}catch(err){toast(err.message,'error')}return;
  }
  if(isOffline()){toast('Для действия руководителя требуется подключение к серверу.','error');return}
  setBusy(true,({create:'Создаём задачу…',edit:'Сохраняем задачу…',start:'Закрепляем задачу за вами…',complete:'Завершаем задачу…',release:'Сохраняем причину отказа…',forceRelease:'Освобождаем задачу…',assign:'Назначаем водителя…',unassign:'Снимаем назначение…',cancel:'Отменяем задачу…'})[action]||'Сохраняем изменения…');
  try{
    const result=await callApi('apiMutate',state.token,action,payload);
    closeModal();
    if(result.task){
      const updated=result.task;
      state.serverTasks=state.serverTasks.filter(x=>x.id!==updated.id);
      if(!['DONE','CANCELLED'].includes(updated.status) && (isManager()||!updated.driverId||updated.driverId===state.user.employeeId))state.serverTasks.push(updated);
      state.tasks=overlayQueue(state.serverTasks);
      // Не обновляем ревизию до серверной сверки: параллельные изменения не потеряются.
      state.lastSync=new Date().toISOString();
      render();
      saveCached().catch(()=>{});
      // Сервер пришлёт только изменившийся срез по ревизиям.
      sync(false).catch(()=>{});
    }
    toast(({edit:'Изменения сохранены',create:'Задача создана',start:'Задача взята в работу',complete:'Задача завершена',release:'Отказ сохранён. Задача снова доступна',forceRelease:'Задача возвращена в активные',assign:'Водитель назначен',unassign:'Назначение снято',cancel:'Задача отменена руководителем'})[action]||'Сохранено');
    if(state.page==='history')loadHistory(1).catch(()=>{});
    return result;
  }catch(e){
    if(!isManager()&&['start','release','complete'].includes(action)&&(e.networkError||!navigator.onLine)){
      state.networkFailed=true;
      try{await enqueueDriverAction(action,payload)}catch(err){toast(err.message,'error')}
    }else{
      toast(e.message,'error');
      if(/изменена|закрыта|недоступна|закреплена|не находится в работе/i.test(e.message))sync(false).catch(()=>{});
    }
  }finally{setBusy(false)}
}
async function manage(action,input){
  if(state.busy)return;
  setBusy(true,({upsertStaff:'Сохраняем сотрудника…',toggleStaff:'Изменяем доступ сотрудника…',addCity:'Добавляем город…',disableCity:'Обновляем справочник городов…'})[action]||'Сохраняем изменения…');
  try{
    await callApi('apiManage',state.token,action,input);
    closeModal();toast(action==='upsertStaff'?'Сотрудник сохранён':action==='toggleStaff'?'Доступ сотрудника обновлён':'Изменения сохранены');
    if($('#loadingTitle'))$('#loadingTitle').textContent='Обновляем списки…';
    try{await sync(true)}catch(e){toast('Изменение сохранено. Обновите список при восстановлении связи.','error')}
  }catch(e){toast(e.message,'error')}finally{setBusy(false)}
}
async function loadHistory(page,foreground=false){
  if(!isManager())return;
  if(foreground){if(state.busy)return;setBusy(true,'Загружаем историю задач…')}
  try{
    const p=Math.max(1,Number(page||1));
    const result=await callApi('apiHistory',state.token,state.historyFilters,p,false);
    state.historyRows=result.rows;state.historyTotal=result.total;state.historyPage=result.page;
    if(state.page==='history')render();
  }finally{if(foreground)setBusy(false)}
}
function csvSafe(value){
  let s=String(value==null?'':value).replace(/\r\n?/g,'\n');
  // Защита от CSV injection при открытии в Excel/LibreOffice.
  if(/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}
async function exportHistory(){
  if(!isManager()||state.busy)return;
  setBusy(true,'Формируем CSV-отчёт…');
  try{
    const data=await callApi('apiHistory',state.token,state.historyFilters,1,true);
    const columns=[['number','Номер'],['type','Тип'],['city','Город'],['fromAddress','Откуда'],['toAddress','Куда'],['mapUrl','Ссылка на карты'],
      ['details','Информация'],['volume','Объём'],['powerOfAttorney','Доверенность'],['priority','Важность'],
      ['status','Статус'],['driverId','ID водителя'],['driverName','Водитель'],['createdAt','Создана'],
      ['assignedAt','Назначена'],['startedAt','В работе с'],['finishedAt','Закрыта'],
      ['createdBy','Создал'],['lastReason','Причина']];
    const csv='\ufeff'+[columns.map(x=>csvSafe(x[1])).join(';'),...data.rows.map(t=>columns.map(([key])=>csvSafe(key==='fromAddress'||key==='toAddress'?taskRoute(t)[key==='fromAddress'?'from':'to']:t[key])).join(';'))].join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='driverflow_'+state.historyFilters.from+'_'+state.historyFilters.to+'.csv';
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
    toast('Файл отчёта сформирован: '+data.total+' строк');
  }catch(e){toast('Не удалось выгрузить: '+e.message,'error')}finally{setBusy(false)}
}
function updateTimers(){
  document.querySelectorAll('[data-created]').forEach(node=>{
    const stamp=node.dataset.created, age=elapsed(stamp);
    if(node.dataset.ageIndicator==='true'){
      node.classList.remove('fresh','warning','critical');node.classList.add(ageLevel(stamp));
      const copy=node.querySelector('.age-copy');if(copy)copy.textContent=age;
    }else if(node.classList.contains('elapsed'))node.textContent='◷ '+age;
    else node.textContent=age;
  });
}
async function manualSync(){
  if(state.busy||!state.token)return;
  if(!navigator.onLine){updateOfflineUi();toast('Нет сети. Данные доступны из памяти телефона.');return}
  setBusy(true,'Обновляем данные…');
  try{await sync(true);toast('Данные обновлены')}
  catch(e){/* Подробная ошибка уже показана внутри sync() */}
  finally{setBusy(false)}
}
async function navigate(page){
  state.page=page;state.search='';state.focus='ALL';state.city='ALL';
  closeModal();render();window.scrollTo({top:0,behavior:'auto'});
  if(page==='history')try{await loadHistory(1,true)}catch(e){toast(e.message,'error')}
}
function formObject(form){return Object.fromEntries(new FormData(form).entries())}
function handleClick(e){
  const button=e.target.closest('[data-action]');if(!button||button.disabled)return;
  const action=button.dataset.action;
  if(state.busy&&action!=='close-modal')return;
  if(action==='navigate'){navigate(button.dataset.page);return}
  if(action==='sync'){manualSync();return}
  if(action==='view-queue'){queueDialog();return}
  if(action==='flush-queue'){closeModal();sync(true).catch(()=>{});return}
  if(action==='discard-offline'){
    const entry=state.queue.find(q=>q.id===button.dataset.id);
    if(entry){
      const index=state.queue.findIndex(q=>q.id===entry.id);
      if(state.queue.slice(index+1).some(q=>q.payload.taskId===entry.payload.taskId)){
        toast('Сначала отмените более позднее действие по этой задаче.','error');return;
      }
      if(confirm('Удалить неотправленное действие? Оно НЕ будет выполнено на сервере.')){
        state.queue.splice(index,1);
        state.tasks=overlayQueue(state.serverTasks);
        storeQueue().then(()=>saveCached()).then(()=>{if(navigator.onLine)sync(true).catch(()=>{})}).catch(e=>toast(e.message,'error'));
        closeModal();render();updateOfflineUi();
      }
    }return;
  }
  if(action==='logout'){logOut(false);return}
  if(action==='api-settings'){closeModal();showApiSetup();return}
  if(action==='push-enable'){enableDriverPush();return}
  if(action==='push-test'){testDriverPush();return}
  if(action==='push-disable'){disableDriverPush();return}
  if(action==='profile'){openModal(modalHeader('Мой профиль')+`<div class="detail-grid">${detailField('Сотрудник',state.user.name)}${detailField('ID',state.user.employeeId)}${detailField('Роль',isManager()?'Руководитель':'Водитель')}</div><div class="profile-tools"><button class="btn secondary" data-action="push-enable">🔔 Включить уведомления</button><button class="btn light" data-action="push-test">Проверить Push</button><button class="btn light" data-action="push-disable">Выключить Push</button><button class="btn light" data-action="api-settings">⚙ Сменить API</button></div><div class="modal-actions"><button class="btn danger" data-action="logout">Выйти из приложения</button></div>`);return}
  if(action==='close-modal'){closeModal();return}
  if(action==='create-task'){renderCreateModal();return}
  if(action==='edit-task'){const t=state.tasks.find(x=>x.id===state.modalTaskId);if(t)renderCreateModal(t);return}
  if(action==='open-task'){taskDetail(button.dataset.id);return}
  if(action==='focus'){state.focus=state.focus===button.dataset.focus?'ALL':button.dataset.focus;state.city='ALL';render();return}
  if(action==='reset-filters'){state.focus='ALL';state.city='ALL';state.search='';render();return}
  if(action==='quick-start'){mutate('start',{taskId:button.dataset.id},false);return}
  if(action==='quick-release'){state.modalTaskId=button.dataset.id;reasonModal('release');return}
  if(action==='confirm-complete'){confirmComplete(button.dataset.id);return}
  if(action==='dashboard-city'){state.page='tasks';state.focus='ALL';state.city=button.dataset.city;state.search='';render();window.scrollTo({top:0,behavior:'auto'});return}
  if(action==='city-filter'){state.city=button.dataset.city;render();window.scrollTo({top:0,behavior:'smooth'});return}
  if(action==='start-task'){mutate('start',{},false);return}
  if(action==='complete-task'){mutate('complete',{},false);return}
  if(action==='unassign'){mutate('unassign',{},false);return}
  if(action==='reason-dialog'){reasonModal(button.dataset.kind);return}
  if(action==='staff-create'){staffModal(null);return}
  if(action==='staff-edit'){staffModal(state.staff.find(s=>s.employeeId===button.dataset.id));return}
  if(action==='staff-toggle'){
    const id=button.dataset.id,s=state.staff.find(p=>p.employeeId===id);
    if(s&&confirm((s.active==='TRUE'?'Отключить':'Включить')+' сотрудника '+s.name+'?'))manage('toggleStaff',{employeeId:id});return;
  }
  if(action==='disable-city'){
    const city=button.dataset.city;
    if(confirm('Убрать город «'+city+'» из списка?'))manage('disableCity',{name:city});return;
  }
  if(action==='history-page'){loadHistory(Number(button.dataset.page),true).catch(e=>toast(e.message,'error'));return}
  if(action==='export'){
    const form=$('#historyForm');
    if(form&&form.reportValidity()){
      const f=formObject(form);
      if(f.from>f.to){toast('Дата начала не должна быть позже даты окончания','error');return}
      state.historyFilters=f;exportHistory();
    }
    return;
  }
}
async function handleSubmit(e){
  const form=e.target;if(!(form instanceof HTMLFormElement))return;
  e.preventDefault();
  if(state.busy)return;
  const input=formObject(form);
  if(form.id==='loginForm'){
    const button=$('#loginButton');
    setBusy(true,'Проверяем доступ сотрудника…');
    button.innerHTML='<span class="inline-spinner" aria-hidden="true"></span> Входим…';
    try{
      const result=await callApi('apiLogin',input);
      state.token=result.token;state.user=result.user;state.tasks=[];state.serverTasks=[];state.cities=[];state.staff=[];
      state.versions={};state.ready=false;state.page='tasks';state.focus='ALL';state.city='ALL';
      storageSet('df_token',state.token);storageSet('df_user',JSON.stringify(state.user));
      switchView(true);await loadQueue();await loadCached();render();
      $('#loadingTitle').textContent='Загружаем ваши задачи…';
      await sync(true);
      toast('Добро пожаловать, '+state.user.name);
    }catch(err){toast(err.message,'error')}
    finally{setBusy(false);button.innerHTML='Войти в приложение <span>→</span>'}
    return;
  }
  if(form.id==='createTaskForm'){input.requestId=form.dataset.requestId;mutate('create',input,false);return}
  if(form.id==='editTaskForm'){mutate('edit',input,false);return}
  if(form.id==='assignForm'){
    if(!input.driverId){toast('Выберите водителя','error');return}
    mutate('assign',{driverId:input.driverId},false);return;
  }
  if(form.id==='reasonForm'){
    const kind=form.dataset.kind;
    mutate(kind,{reason:input.reason},false);return;
  }
  if(form.id==='staffForm'){manage('upsertStaff',input);return}
  if(form.id==='cityForm'){manage('addCity',{name:input.city});return}
  if(form.id==='historyForm'){
    state.historyFilters=input;
    state.historyRows=[];state.historyTotal=0;state.historyPage=1;
    loadHistory(1,true).catch(err=>toast(err.message,'error'));return;
  }
}
document.addEventListener('click',event=>{
  try{handleClick(event)}
  catch(error){console.error('DriverFlow UI error',error);toast('Ошибка интерфейса: '+(error.message||'неизвестная ошибка'),'error')}
});
document.addEventListener('submit',handleSubmit);
document.addEventListener('change',e=>{if(e.target.matches('#staffForm [name="role"]'))updateStaffPinRequirement()});
document.addEventListener('input',e=>{
  if(e.target.id==='taskSearch'){
    state.search=e.target.value;
    const area=$('#taskSections');if(area)area.innerHTML=taskSections();
    document.querySelectorAll('.city-pill').forEach(b=>{const city=b.dataset.city;const ts=activeTasksBase();const count=city==='ALL'?ts.length:ts.filter(t=>t.city===city).length;const n=b.querySelector('b');if(n)n.textContent=count;});
    updateTimers();
  }
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!state.busy&&!$('#overlay').classList.contains('hidden'))closeModal();
});
$('#overlay').addEventListener('click',e=>{if(e.target.id==='overlay')closeModal()});
window.addEventListener('online',()=>{state.networkFailed=false;updateOfflineUi();if(state.token)sync(false).catch(()=>{})});
window.addEventListener('offline',()=>{state.networkFailed=true;updateOfflineUi()});
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(e=>console.warn('SW registration',e));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.token&&(!state.lastSync||Date.now()-new Date(state.lastSync).getTime()>60000))sync(false).catch(()=>{})});
setInterval(()=>{if(!document.hidden&&state.token&&navigator.onLine)sync(false).catch(()=>{})},120000);
setInterval(updateTimers,60000);
boot();
