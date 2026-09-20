const $ = id => document.getElementById(id);
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(response.status === 429 ? '操作太频繁，请稍后再试。' : '服务暂时不可用，请稍后重试。');
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '暂时无法连接，请稍后重试。');
  return value;
}
if ($('unified-sign-in')) {
  const id = new URLSearchParams(location.search).get('desktop');
  const desktop = id && /^[a-f0-9]{64}$/.test(id) ? id : '';
  if (desktop) $('unified-login').href += '?desktop=' + desktop;
  const status = text => { $('auth-status').textContent = text; };
  const run = async fn => { try { await fn(); } catch(error) { status(error.message); } };
  $('approve-desktop').onclick = () => void run(async () => {
    $('approve-desktop').disabled = true;
    try { await api('/v1/auth/desktop/approve', {id:desktop}); $('pairing').hidden=true; status('已连接。可以返回 SofaMate 客户端了。'); }
    finally { $('approve-desktop').disabled=false; }
  });
  $('sign-out').onclick = () => void run(async () => { await api('/v1/auth/logout', {}); location.reload(); });
  void run(async () => {
    const config = await api('/v1/auth/config');
    if (!config.unified) { $('unified-login').removeAttribute('href'); $('unified-login').setAttribute('aria-disabled','true'); status('统一登录正在配置，请稍后重试。'); return; }
    let user; try { user=(await api('/v1/auth/me')).user; } catch { return; }
    $('unified-sign-in').hidden=true; $('signed-in').hidden=false;
    $('auth-title').textContent='很高兴，再见到你。'; $('user-name').textContent=user.name; $('user-email').textContent=user.email;
    if (desktop) { const pair=await api('/v1/auth/desktop/info?id='+desktop); $('pairing').hidden=false; $('pair-code').textContent=pair.code; $('account-actions').hidden=true; }
  });
}
if ($('market-grid')) {
  let next = null, generation = 0;
  function card(item) {
    const article = document.createElement('article'); article.className = 'wallpaper-card';
    const image = document.createElement('img'); image.src = `/v1/items/${item.id}/cover`; image.alt = item.title; image.loading = 'lazy'; image.width = 1200; image.height = 675;
    const body = document.createElement('div'); body.className = 'wallpaper-card-body';
    const title = document.createElement('h2'); title.textContent = item.title;
    const meta = document.createElement('p'); meta.textContent = `${item.author} · ${item.info.width} × ${item.info.height} · ${(item.bytes / 1024 ** 2).toFixed(1)} MB`;
    const description = document.createElement('p'); description.textContent = item.description;
    const links = document.createElement('div'); links.className = 'card-links';
    const view = document.createElement('a'); view.className = 'button primary'; view.href = `/wallpaper/${item.id}`; view.textContent = '查看壁纸 ↗';
    const download = document.createElement('a'); download.href = `/v1/items/${item.id}/video`; download.download = 'wallpaper.mp4'; download.textContent = '下载 ↓';
    links.append(view, download); body.append(title, meta, description, links); article.append(image, body); return article;
  }
  async function load(more = false) {
    const run = ++generation; $('market-status').textContent = '正在寻找喜欢的画面…';
    try {
      const data = await api('/v1/items?' + new URLSearchParams({ q: $('market-query').value, offset: String(more ? next ?? 0 : 0) }));
      if (run !== generation) return;
      if (!more) $('market-grid').replaceChildren();
      data.items.forEach(item => $('market-grid').append(card(item))); next = data.nextOffset;
      $('market-more').hidden = next === null; $('market-empty').hidden = data.total > 0;
      const searching = !!$('market-query').value.trim();
      $('market-empty').querySelector('h2').textContent = searching ? '没有找到匹配的壁纸。' : '你喜欢的角色，等你来分享。';
      $('market-empty').querySelector('p').textContent = searching ? '试试其他名字，或清空搜索看看全部作品。' : '在 SofaMate 中导入你创作的视频，登录后点击「分享」。你的作品会出现在这里。';
      $('market-empty').querySelector('a').hidden = searching;
      $('market-reset').hidden = !searching;
      $('market-status').textContent = data.total ? `${data.total} 段画面，等你带回桌面。` : '';
    } catch (error) { if (run === generation) $('market-status').textContent = error.message; }
  }
  $('market-search').onsubmit = event => { event.preventDefault(); void load(); };
  $('market-more').onclick = () => void load(true);
  $('market-reset').onclick = () => { $('market-query').value = ''; void load(); };
  void load();
}

if ($('download-dialog')) {
  const dialog=$('download-dialog'), preview=$('preview-dialog'), video=$('gallery-video');
  const openDownload=(title='',url='')=>{ $('download-context').textContent=title?'你选择了「'+title+'」。下载客户端，把这份陪伴带回桌面。':'下载 SofaMate · 沙发伴侣，开始你的桌面陪伴。'; $('selected-scene').hidden=!url; if(url) $('selected-download').href=url; else $('selected-download').removeAttribute('href'); $('spotlight-video')?.pause(); dialog.showModal(); };
  document.addEventListener('click',event=>{
    const item=event.target.closest('[data-companion]'); if(item){ openDownload(item.dataset.companion,item.dataset.video); return; }
    const play=event.target.closest('[data-preview]'); if(play){ $('spotlight-video')?.pause(); video.src=play.dataset.preview; preview.showModal(); video.play().catch(()=>{}); return; }
    const download=event.target.closest('a[href*="/releases/latest/download/"]'); if(download && !dialog.contains(download)){ event.preventDefault(); openDownload(); }
  });
  for(const modal of [dialog,preview]){ modal.querySelector('[data-close-dialog]').onclick=()=>modal.close(); modal.addEventListener('click',event=>{if(event.target===modal){const rect=modal.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)modal.close();}}); }
  preview.addEventListener('close',()=>{ video.pause();video.removeAttribute('src');video.load(); });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){video.pause();$('spotlight-video')?.pause();}});
  void (async()=>{try{
    const result=await api('/v1/items?offset=0');
    for(const item of result.items.slice(0,8)){
      const card=document.createElement('article');card.className='companion-card';
      const cover=document.createElement('button');cover.className='companion-cover';cover.dataset.preview='/v1/items/'+item.id+'/video';cover.setAttribute('aria-label','预览'+item.title);
      const image=document.createElement('img');image.src='/v1/items/'+item.id+'/cover';image.alt=item.title;image.loading='lazy';image.width=1280;image.height=720;
      const play=document.createElement('span');play.textContent='▶ 预览视频';cover.append(image,play);
      const info=document.createElement('div');info.className='companion-info';const text=document.createElement('div');const tag=document.createElement('span');tag.className='scene-label';tag.textContent='社区 · '+item.author;const title=document.createElement('h3');title.textContent=item.title;text.append(tag,title);
      const button=document.createElement('button');button.className='button primary';button.textContent='立即陪伴 ↗';button.dataset.companion=item.title;button.dataset.video='/v1/items/'+item.id+'/video';info.append(text,button);card.append(cover,info);$('companion-gallery').insertBefore(card,$('companion-gallery').lastElementChild);
    }
  }catch{ $('gallery-status').textContent='社区作品暂时无法加载，你仍可以预览官方片段。'; }})();
}
