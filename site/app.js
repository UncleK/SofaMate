const $ = id => document.getElementById(id);
const c = window.sofaCopy;
const lang = document.documentElement.dataset.language || 'zh';
const prefix = lang === 'zh' ? '' : '/' + lang;
const localPage = page => prefix + '/' + page;
try {
  const saved = localStorage.getItem('sofamate-language');
  // An OAuth callback returns to /login; restore only its previously chosen locale.
  if (location.pathname === '/login' && ['en','ja'].includes(saved)) location.replace('/' + saved + '/login' + location.search);
  else localStorage.setItem('sofamate-language', lang);
} catch {}
$('site-language')?.addEventListener('change', event => {
  const selected = event.target.value;
  if (!['zh','en','ja'].includes(selected)) return;
  try { localStorage.setItem('sofamate-language', selected); } catch {}
  const page = document.documentElement.dataset.page;
  location.href = (selected === 'zh' ? '' : '/' + selected) + '/' + (page === 'index' ? '' : page) + location.search;
});
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store', headers:body === undefined ? {} : {'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body), redirect:'error' });
  const error = () => Object.assign(new Error(response.status === 429 ? c.frequent : c.unavailable), { status:response.status });
  if (!response.headers.get('content-type')?.includes('application/json')) throw error();
  const value = await response.json();
  if (!response.ok) throw error();
  return value;
}
// Every page asks the server for its own session. No identity or credential is cached locally.
let sessionGeneration=0, signingOut=false, renderAccount=()=>{}, accountRefreshError=()=>{};
function showAccount(user) {
  const link=$('site-account');
  if (link) {
    const name=typeof user?.name==='string' && user.name.trim() ? user.name.trim() : c.account;
    link.textContent=user ? name : c.login;
    link.title=user ? c.account+' · '+name : c.login;
    link.setAttribute('aria-label',link.title);
    link.classList.toggle('is-signed-in',!!user);
  }
  renderAccount(user);
}
const notifySessionChange=()=>{try{localStorage.setItem('sofamate-session-change',crypto.randomUUID());}catch{}};
async function refreshAccount() {
  if (signingOut) return;
  const generation=++sessionGeneration;
  try {
    const {user}=await api('/v1/auth/me');
    if (generation!==sessionGeneration) return;
    showAccount(user);
  } catch(error) {
    if (generation!==sessionGeneration) return;
    if (error.status===401) showAccount(null);
    else accountRefreshError(error);
  }
}
window.addEventListener('focus',()=>void refreshAccount());
window.addEventListener('pageshow',event=>{if(event.persisted)void refreshAccount();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshAccount();});
window.addEventListener('storage',event=>{if(event.key==='sofamate-session-change')void refreshAccount();});
if ($('unified-sign-in')) {
  const id = new URLSearchParams(location.search).get('desktop');
  const desktop = id && /^[a-f0-9]{64}$/.test(id) ? id : '';
  const startParams = new URLSearchParams({lang});
  if (desktop) startParams.set('desktop',desktop);
  $('unified-login').href += '?' + startParams;
  const status = text => { $('auth-status').textContent=text; };
  const run = async fn => { try { await fn(); } catch(error) { status(error.message); } };
  let paired=false, accountId=null, notified=false;
  accountRefreshError=error=>status(error.message);
  renderAccount=user=>{
    $('unified-sign-in').hidden=!!user; $('signed-in').hidden=!user;
    $('auth-title').textContent=user ? c.welcomeBack : c.welcome;
    $('user-name').textContent=user?.name || c.account; $('user-email').textContent=user?.email || '';
    if(accountId!==user?.id){paired=false;accountId=user?.id;$('pairing').hidden=true;status('');}
    if(user && !notified){notified=true;notifySessionChange();}
    $('account-actions').hidden=!!desktop;
    if(user && desktop && !paired) {
      const generation=sessionGeneration;
      void run(async()=>{
        const pair=await api('/v1/auth/desktop/info?id='+desktop);
        if(generation!==sessionGeneration || paired)return;
        $('pairing').hidden=false; $('pair-code').textContent=pair.code;
      });
    }
  };
  $('approve-desktop').onclick = () => void run(async () => {
    $('approve-desktop').disabled=true;
    try { await api('/v1/auth/desktop/approve',{id:desktop}); paired=true; $('pairing').hidden=true; status(c.connected); }
    finally { $('approve-desktop').disabled=false; }
  });
  $('sign-out').onclick = () => void run(async () => {
    signingOut=true; ++sessionGeneration; $('sign-out').disabled=true;
    try { await api('/v1/auth/logout',{}); showAccount(null); notifySessionChange(); }
    finally { signingOut=false; $('sign-out').disabled=false; }
  });
  void run(async () => {
    const config=await api('/v1/auth/config');
    if (!config.unified) { $('unified-login').removeAttribute('href'); $('unified-login').setAttribute('aria-disabled','true'); status(c.configuring); return; }
  });
}
void refreshAccount();
// Preview stays in its card. Only the requested video loads, and only one plays.
const pauseVideos = except => document.querySelectorAll('video').forEach(video => { if(video!==except)video.pause(); });
const visibleVideos = new IntersectionObserver(entries => { for(const entry of entries) if(!entry.isIntersecting)entry.target.pause(); },{threshold:0.05});
document.addEventListener('click', event => {
  const cover=event.target.closest('[data-preview]');
  if(!cover) return;
  const video=document.createElement('video'); video.className='inline-preview'; video.controls=true;video.playsInline=true;video.preload='none';video.muted=true;
  video.poster=cover.querySelector('img').src; video.src=cover.dataset.preview;video.setAttribute('aria-label',c.play);video.tabIndex=0;
  video.addEventListener('play',()=>pauseVideos(video));
  cover.replaceWith(video);visibleVideos.observe(video);pauseVideos(video);video.play().catch(()=>{});video.focus({preventScroll:true});
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseVideos();});
window.addEventListener('pagehide',()=>pauseVideos());
if ($('market-grid')) {
  let next=null, generation=0;

  function card(item) {
    const article=document.createElement('article');article.className='companion-card community-card';
    const cover=document.createElement('button');cover.className='companion-cover';if(item.previewPath)cover.dataset.preview=item.previewPath;else cover.disabled=true;cover.setAttribute('aria-label',c.play+' — '+item.title);
    const image=document.createElement('img');image.src=item.coverPath;image.alt=item.title;image.loading='lazy';image.width=1280;image.height=720;
    const play=document.createElement('span');play.textContent='▶ '+c.play;cover.append(image,play);
    const info=document.createElement('div');info.className='companion-info';const text=document.createElement('div');const title=document.createElement('h2');title.textContent=item.title;
    const meta=document.createElement('p');meta.textContent=`${item.author}${item.official?' · '+c.officialPublisher:item.featured?' · '+c.featured:''} · ${item.kind==='scene-pack'?c.completeTheme:item.info.width+' × '+item.info.height}`;text.append(title,meta);
    const start=document.createElement('a');start.className='button primary';start.textContent=c.start+' ↗';start.href=localPage('download')+(item.kind==='scene-pack'?'?theme='+encodeURIComponent(item.themeId):'?item='+encodeURIComponent(item.id));info.append(text,start);article.append(cover,info);return article;
  }
  async function load(more=false) {
    const current=++generation;const query=$('market-query').value.trim();$('market-status').textContent=c.loading;
    try {
      const data=await api('/v1/items?'+new URLSearchParams({q:query,offset:String(more?next??0:0),featured:$('market-filter').value}));
      if(current!==generation)return;
      if(!more) { document.querySelectorAll('.community-card').forEach(el=>{el.querySelector('video')?.pause();el.remove();}); }
      data.items.forEach(item=>$('market-grid').append(card(item)));next=data.nextOffset;
      $('market-more').hidden=next===null;$('market-empty').hidden=data.total>0;$('market-reset').hidden=!query;
      $('market-status').textContent=data.total+' '+c.count;
    } catch { if(current===generation)$('market-status').textContent=c.galleryError; }
  }
  $('market-search').onsubmit=event=>{event.preventDefault();void load();};
  $('market-more').onclick=()=>void load(true);
  $('market-filter').onchange=()=>void load();
  $('market-reset').onclick=()=>{$('market-query').value='';void load();};
  void load();
}
if ($('selected-download')) {
  const params=new URLSearchParams(location.search);const item=params.get('item');
  const source=item&&/^[a-zA-Z0-9_-]{1,80}$/.test(item)?'/v1/items/'+item+'/video':null;
  if(source){$('selected-scene').hidden=false;$('selected-download').href=source;$('selected-download').download='SofaMate-'+item+'.mp4';}
  if(params.get('theme')==='living-room-night' || params.get('scene')==='night') {
    $('selected-scene').hidden=false;$('selected-download').removeAttribute('download');
    $('selected-description').textContent=c.selectedTheme;
    $('selected-download').href=localPage('market');$('selected-download').textContent=c.fullTheme;
  }
}
