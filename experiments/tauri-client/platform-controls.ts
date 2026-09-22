import { listen } from '@tauri-apps/api/event';
import { makePreview } from './preview';
import { icon } from './icons';
import { getLocale, setLocale, t, errorMessage } from './i18n';
import { wallpaperView } from './wallpaper-view';
import { mountAccount } from './account-ui';
import { libraryWallpapers, themeWallpapers, media, type LocalVideo, type Preset, type OfficialTheme } from './wallpapers';
type MarketItem = {
  id: string;
  title: string;
  description: string;
  author: string;
  owner: string;
  bytes: number;
  sha256: string;
  coverUrl: string;
  shareUrl: string;
  info: LocalVideo['info'];
  kind?:string;themeId?:string;official?:boolean;featured?:boolean;variants?:{id:string;label:string}[];
};
const size = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
export async function mountPlatform(
  root: HTMLElement,
  call: (action: string, value?: unknown) => Promise<any>,
) {
  setLocale((await call('preferences')).language);
  root.innerHTML = `<header class="platform-header"><div class="brand" aria-label="SofaMate">SofaMate</div><nav aria-label="${t('壁纸来源')}"><button data-tab="scenes">${icon('home')}${t('精选主题')}</button><button data-tab="library">${icon('library')}${t('我的壁纸')}</button><button data-tab="market">${icon('market')}${t('分享市场')}</button></nav><div class="header-actions"><button id="import-video">${icon('plus')}${t('导入视频')}</button><select id="language" aria-label="${t('语言')}"><option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option></select><button id="app-exit" class="icon-button" aria-label="${t('退出 SofaMate')}" title="${t('退出 SofaMate')}">${icon('exit')}</button></div></header>
  <section id="scene-pane"></section><section id="library-pane" hidden></section>
  <section id="market-pane" class="platform-pane" hidden><div class="pane-heading"><div><h1>${t('分享市场')}</h1><p class="muted">${t('发现喜欢的画面，下载后离线使用。')}</p></div><form id="market-search" class="search-form"><label class="search-field">${icon('search')}<input id="search-query" aria-label="${t('搜索壁纸')}" placeholder="${t('搜索壁纸、作者')}" maxlength="100"></label><button>${t('搜索')}</button></form></div><div class="market-summary"><p id="market-status" role="status"></p><span>${t('本机市场')}</span></div><div id="market-list" class="market-grid"></div><button id="market-more" hidden>${t('加载更多')}</button></section>
  <div id="transfer" class="transfer" hidden><div><strong id="transfer-title"></strong><span id="transfer-detail"></span></div><progress id="transfer-bar" max="1" value="0"></progress><button id="cancel-transfer">${t('取消')}</button></div><div id="platform-notice" class="platform-notice" role="status"></div>
  <dialog id="share-dialog" aria-labelledby="share-heading"><form id="share-form"><h2 id="share-heading">${t('分享壁纸')}</h2><p class="muted">${t('将视频与九宫格发布到本机市场，供其他本机用户下载。')}</p><label>${t('标题')}<input name="title" maxlength="80" required></label><label>${t('作者昵称')}<input name="name" maxlength="40" required></label><label>${t('简介')}<textarea name="description" maxlength="1000" rows="3" placeholder="${t('介绍一下这段画面…')}"></textarea></label><div class="actions"><button type="button" id="share-close">${t('取消')}</button><button id="publish-share" class="primary">${t('发布分享')}</button></div></form></dialog>
  <dialog id="link-dialog"><h2>${t('分享已发布')}</h2><p>${t('复制链接，可在本机浏览器打开预览页。')}</p><input id="share-link" readonly aria-label="${t('本机分享链接')}"><div class="actions"><button id="copy-link" class="primary">${t('复制链接')}</button><button id="link-close">${t('完成')}</button></div></dialog>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  let entries: LocalVideo[] = [],
    presets: Preset[] = [],
    busy = false,
    abort: AbortController | null = null,
    shareId = '';
  let marketItems: MarketItem[] = [],
    owner = '',
    next: number | null = null,
    marketGeneration = 0,
    applyGeneration = 0;
  let selectedMonitor='';
  let featuredItems:MarketItem[]|null=null,canCurate=false;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const notice = (text: string) => {
    clearTimeout(noticeTimer);
    el('platform-notice').textContent = text;
    if (text) noticeTimer = setTimeout(() => (el('platform-notice').textContent = ''), 4000);
  };
  const report = (error: unknown) => notice(errorMessage(error));
  const on = (id: string, fn: () => unknown) =>
    el(id).addEventListener('click', () => void Promise.resolve().then(fn).catch(report));
  const viewOptions = {
    call,
    apply,
    stop,
    share,
    cover: (video: LocalVideo) => work('正在生成九宫格', () => cover(video)),
    report,
    importVideo: () => el<HTMLButtonElement>('import-video').click(),
    browseMarket: () => setTab('market'),
    download: (id: string) => work('正在下载主题',async()=>{await call('official-install',id);}),
    downloadMarket:(id:string)=>work('正在下载',async()=>{const entry=await call('market-download',id);if(entry.coverVersion!==2)await cover(entry);}),
  };
  const views = [
    wallpaperView(el('scene-pane'), true, viewOptions),
    wallpaperView(el('library-pane'), false, viewOptions),
  ];
  function playback(m: any) {
    for (const view of views) view.playback(m);
  }
  function displays(data:any){selectedMonitor=data.target;for(const view of views)view.displays(data);const m=data.monitors.find((m:any)=>m.id===data.target);if(m)playback(m.state.playback);}
  await listen<any>('trial-metrics', (e) => {if(e.payload.monitorId===selectedMonitor)playback(e.payload);});
  await listen<any>('displays-changed',e=>displays(e.payload));
  displays(await call('displays'));
  playback((await call('metrics')).playback);
  function setTab(name: string) {
    sessionStorage.setItem('sofamate-tab', name);
    window.scrollTo(0, 0);
    views.forEach((v) => v.stopPreview());
    for (const tab of ['scenes', 'library', 'market'])
      el(tab === 'scenes' ? 'scene-pane' : tab + '-pane').hidden = name !== tab;
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      b.classList.toggle('active', b.dataset.tab === name);
      b.setAttribute('aria-current', b.dataset.tab === name ? 'page' : 'false');
    }
    if (name === 'market') void refreshMarket();
  }
  async function refreshLibrary() {
    const [videos, catalog, official] = await Promise.all([call('library-list'), call('catalog'),call('official-catalog')]);
    entries = videos;
    presets = catalog.presets;
    const themes=themeWallpapers(presets,official.themes as OfficialTheme[]);
    const featured=featuredItems===null?themes:featuredItems.flatMap(item=>{
      if(item.kind==='scene-pack')return themes.filter(t=>t.id==='theme:'+item.themeId);
      const local=entries.find(e=>e.sha256===item.sha256&&e.ready);
      return [{id:'market:'+item.id,title:item.title,description:item.description,author:item.author,cover:item.coverUrl,ready:!!local,playbackIds:local?['local:'+local.id]:[],presets:[],video:local,market:item}];
    });
    views[0].setItems(featured);
    views[1].setItems(libraryWallpapers(presets, entries));
  }
  async function apply(id: string) {
    const generation = ++applyGeneration;
    const monitorId=selectedMonitor;
    views.forEach((v) => {
      v.actionNotice('');
      v.stopPreview();
      v.setApplying(true);
    });
    try {
      await call('select', {id,monitorId});
      const deadline = Date.now() + 16000;
      while (generation === applyGeneration && Date.now() < deadline) {
        const current = (await call('metrics',{monitorId})).playback;
        if(selectedMonitor===monitorId)playback(current);
        if (current.selectionId === id && current.fault) throw Error('播放未能启动，请重试。');
        if (
          current.selectionId === id &&
          !current.paused &&
          !current.stopped &&
          !current.loading &&
          current.frames > 0
        ) {
          if(selectedMonitor===monitorId)for(const view of views)view.actionNotice(t('已启动，请返回桌面观看'));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (generation === applyGeneration) throw Error('播放未能启动，请重试。');
    } finally {
      if (generation === applyGeneration) views.forEach((v) => v.setApplying(false));
    }
  }
  async function stop() {
    ++applyGeneration;
    views.forEach((v) => {
      v.stopPreview();
      v.setApplying(false);
    });
    await call('stop');
    playback((await call('metrics')).playback);
    for(const view of views)view.actionNotice(t('已停止，桌面播放资源已释放'));
  }
  async function work(label: string, fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    abort = new AbortController();
    notice('');
    el('transfer').hidden = false;
    el('transfer-title').textContent = t(label);
    el('transfer-detail').textContent = '';
    el<HTMLProgressElement>('transfer-bar').value = 0;
    el<HTMLButtonElement>('import-video').disabled = true;
    el<HTMLSelectElement>('language').disabled = true;
    el<HTMLButtonElement>('cancel-transfer').disabled = false;
    try {
      await fn();
    } catch (e) {
      report(e);
    } finally {
      busy = false;
      abort = null;
      el('transfer').hidden = true;
      el<HTMLButtonElement>('import-video').disabled = false;
      el<HTMLSelectElement>('language').disabled = false;
      await refreshLibrary();
    }
  }
  async function cover(entry: LocalVideo) {
    el('transfer-title').textContent = t('正在生成九宫格');
    const bytes = await makePreview(
      media(entry, 'video.mp4'),
      (n) => {
        el('transfer-detail').textContent = `${n} / 9`;
        el<HTMLProgressElement>('transfer-bar').value = n / 9;
      },
      abort!.signal,
    );
    if (abort!.signal.aborted) throw Error('操作已取消');
    await call('save-cover', { id: entry.id, bytes });
  }
  async function share(entry: LocalVideo) {
    if (busy) return;
    if (!(await account.requireLogin())) return;
    if(entry.coverVersion!==2){await work('正在更新九宫格',()=>cover(entry));entry=entries.find(e=>e.id===entry.id)??entry;}
    if(entry.coverVersion!==2)return;
    shareId = entry.id;
    const form = el<HTMLFormElement>('share-form');
    (form.elements.namedItem('title') as HTMLInputElement).value = entry.title;
    (form.elements.namedItem('description') as HTMLTextAreaElement).value = '';
    const profile = await call('market-profile');
    const name = form.elements.namedItem('name') as HTMLInputElement;
    name.value = profile?.name ?? t('本机创作者');
    name.readOnly = !!profile;
    el<HTMLDialogElement>('share-dialog').showModal();
  }
  async function refreshMarket(more = false) {
    const generation = ++marketGeneration;
    el('market-status').textContent = t('正在读取市场…');
    try {
      const data = await call('market-list', {
        query: el<HTMLInputElement>('search-query').value,
        offset: more ? (next ?? 0) : 0,
      });
      if (generation !== marketGeneration) return;
      marketItems = more ? [...marketItems, ...data.items] : data.items;
      owner = data.owner ?? '';
      canCurate=!!data.canCurate;
      next = data.nextOffset;
      renderMarket();
      el('market-status').textContent = marketItems.length
        ? t('{n} 条分享', { n: data.total })
        : t('还没有分享。导入视频后，可以发布第一条。');
    } catch (e) {
      if (generation === marketGeneration) el('market-status').textContent = errorMessage(e);
    }
  }
  function renderMarket() {
    const grid = el('market-list');
    grid.replaceChildren();
    el('market-more').hidden = next === null;
    for (const item of marketItems) {
      const article = document.createElement('article');
      article.className = 'market-card';
      const image = document.createElement('img');
      image.src = item.coverUrl;
      image.alt = item.title;
      image.loading = 'lazy';
      const body = document.createElement('div');
      body.className = 'market-card-body';
      const title = document.createElement('h2');
      title.textContent = item.title;
      const author = document.createElement('p');
      author.className = 'muted';
      author.textContent = `${item.author}${item.official?' · '+t('官方作品'):item.featured?' · '+t('官方精选'):''} · ${item.info.width} × ${item.info.height} · ${size(item.bytes)}`;
      const desc = document.createElement('p');
      desc.className = 'market-description';
      desc.textContent = item.description;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const button = document.createElement('button');
      const local = entries.find((e) => e.sha256 === item.sha256 && e.ready);
      button.className = 'primary';
      button.textContent = t(local ? '已下载 · 使用' : '下载壁纸');
      button.onclick = () =>
        local
          ? void apply('local:' + local.id).catch(report)
          : void work('正在下载', async () => {
              const entry = await call('market-download', item.id);
              if(entry.coverVersion!==2)await cover(entry);
              await refreshLibrary();
              views[1].select('local:' + entry.id);
              setTab('library');
              notice(t('下载完成，已加入我的壁纸。'));
            });
      if(item.kind==='scene-pack'){
        const quality=document.createElement('select');quality.setAttribute('aria-label',t('分辨率与下载'));
        quality.replaceChildren(...(item.variants??[]).map(v=>new Option(v.label,v.id)));
        const refreshButton=()=>button.textContent=t(presets.some(p=>p.id===quality.value)?'已下载 · 使用':'下载壁纸');
        quality.onchange=refreshButton;refreshButton();actions.append(quality);
        button.onclick=()=>{const id=quality.value;if(presets.some(p=>p.id===id)){void apply(id).catch(report);}else{void work('正在下载主题',async()=>{await call('official-install',id);await refreshLibrary();setTab('library');views[1].select('theme:'+item.themeId);await refreshMarket();});}};
      }
      const link = document.createElement('button');
      link.textContent = t('分享链接');
      link.onclick = () => showLink(item.shareUrl);
      actions.append(button, link);
      if(canCurate){const feature=document.createElement('button');feature.textContent=t(item.featured?'移出精选':'加入精选');feature.onclick=()=>{void work('精选已更新',async()=>{await call('market-feature',{id:item.id,featured:!item.featured});await refreshFeatured();await refreshMarket();});};actions.append(feature);}
      if (item.owner === owner) {
        const withdraw = document.createElement('button');
        withdraw.textContent = t('撤回分享');
        withdraw.onclick = () =>
          void work('正在撤回', async () => {
            await call('market-withdraw', item.id);
            await refreshMarket();
            notice(t('分享已撤回，已下载的本机文件不受影响。'));
          });
        actions.append(withdraw);
      }
      body.append(title, author, desc, actions);
      article.append(image, body);
      grid.append(article);
    }
  }
  function showLink(url: string) {
    el<HTMLInputElement>('share-link').value = url;
    el<HTMLDialogElement>('link-dialog').showModal();
  }
  root
    .querySelectorAll<HTMLButtonElement>('[data-tab]')
    .forEach((b) => (b.onclick = () => setTab(b.dataset.tab!)));
  on('import-video', () =>
    work('正在导入', async () => {
      const entry = await call('import');
      if (!entry) return;
      setTab('library');
      if (!entry.ready) await cover(entry);
      await refreshLibrary();
      views[1].select('local:' + entry.id);
      await apply('local:' + entry.id);
    }),
  );
  on('app-exit', () => call('exit'));
  on('cancel-transfer', async () => {
    abort?.abort();
    el<HTMLButtonElement>('cancel-transfer').disabled = true;
    await call('transfer-cancel');
  });
  on('share-close', () => el<HTMLDialogElement>('share-dialog').close());
  on('link-close', () => el<HTMLDialogElement>('link-dialog').close());
  on('copy-link', async () => {
    const input = el<HTMLInputElement>('share-link');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      notice(t('分享链接已复制。'));
    } catch {
      notice(t('请按 Ctrl+C 复制已选中的链接。'));
    }
  });
  el('share-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy || !shareId) return;
    const data = new FormData(el<HTMLFormElement>('share-form')),
      id = shareId;
    el<HTMLDialogElement>('share-dialog').close();
    void work('正在分享', async () => {
      const item = await call('market-publish', {
        id,
        title: data.get('title'),
        description: data.get('description'),
        name: data.get('name'),
      });
      showLink(item.shareUrl);
      notice(t('分享已发布。'));
    });
  });
  el('market-search').addEventListener('submit', (e) => {
    e.preventDefault();
    void refreshMarket();
  });
  on('market-more', () => refreshMarket(true));
  el<HTMLSelectElement>('language').value = getLocale();
  el('language').addEventListener('change', () => {
    if (busy) return;
    void call('set-language', el<HTMLSelectElement>('language').value)
      .then(() => {
        views.forEach((v) => v.stopPreview());
        location.reload();
      })
      .catch(report);
  });
  await listen<any>('transfer-progress', (e) => {
    if (!busy) return;
    el('transfer-title').textContent = t(e.payload.stage);
    el('transfer-detail').textContent =
      e.payload.total > 1 ? `${size(e.payload.done)} / ${size(e.payload.total)}` : '';
    el<HTMLProgressElement>('transfer-bar').value = e.payload.total ? e.payload.done / e.payload.total : 0;
  });
  const account = await mountAccount(root, call, report);
  if (account.public) {
    root.querySelector('.market-summary > span')!.textContent = t('在线社区');
    root.querySelector('#share-dialog .muted')!.textContent = t('将视频与九宫格发布到社区，让其他人发现你的画面。');
    root.querySelector('#link-dialog p')!.textContent = t('复制链接，让朋友在浏览器中预览和下载。');
    el('share-link').setAttribute('aria-label', t('分享链接'));
  }
  await refreshLibrary();
  const catalog = await call('catalog');
  const initial = libraryWallpapers(presets, entries).find((w) => w.playbackIds.includes(catalog.selected));
  if (initial) views[1].select(initial.id);
  const theme = themeWallpapers(presets).find((w) => w.playbackIds.includes(catalog.selected));
  if (theme) views[0].select(theme.id);
  const savedTab = sessionStorage.getItem('sofamate-tab');
  setTab(
    savedTab && ['scenes', 'library', 'market'].includes(savedTab)
      ? savedTab
      : catalog.selected?.startsWith('local:')
        ? 'library'
        : 'scenes',
  );
  (window as any).screenmatePlatform = { refreshLibrary };
  void call('official-refresh').then(refreshLibrary).catch(()=>{});
  async function refreshFeatured(){let offset:number|null=0;const items:MarketItem[]=[];while(offset!==null){const data=await call('market-list',{featured:true,offset});items.push(...data.items);offset=data.nextOffset;if(items.length>=1000)break;}featuredItems=items;await refreshLibrary();}
  void refreshFeatured().catch(()=>{});
  // Upgrade old local covers once; preserve imported videos and official art.
  const oldCovers=entries.filter(e=>e.ready&&e.coverVersion!==2);
  if(oldCovers.length)void work('正在更新九宫格',async()=>{for(const entry of oldCovers)await cover(entry);});
}
