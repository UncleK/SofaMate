import { VideoPlayer } from '../../src/renderer/player';
import { validateRelease } from '../../src/core/validate';
import { LoopPlayer } from './loop-player';
import { icon } from './icons';
import { t } from './i18n';
import { isActive, type Wallpaper, type LocalVideo } from './wallpapers';
type Options = {
  call: (action: string, value?: unknown) => Promise<any>;
  apply: (id: string) => Promise<void>;
  stop: () => Promise<void>;
  share: (video: LocalVideo) => Promise<void>;
  cover: (video: LocalVideo) => Promise<void>;
  report: (error: unknown) => void;
  importVideo: () => void;
  browseMarket: () => void;
  download?: (id: string) => Promise<void>;
  downloadMarket?: (id:string) => Promise<void>;
};
export function wallpaperView(root: HTMLElement, featured: boolean, options: Options) {
  const title = featured ? '精选主题' : '我的壁纸';
  root.innerHTML = `<div class="library-layout wallpaper-view"><aside class="library-rail">
    <div class="rail-heading"><h1>${t(title)}</h1><span data-ui="count"></span></div>
    <label class="rail-search">${icon('search')}<input data-ui="query" aria-label="${t(featured ? '搜索精选主题' : '搜索我的壁纸')}" placeholder="${t(featured ? '搜索主题' : '搜索壁纸')}" maxlength="100"></label>
    <div data-ui="list" class="wallpaper-list"></div><p class="rail-note">${t(featured ? '留一点时间，给生活。' : '已安装的主题和视频，都在这里')}</p><button data-ui="library-folder">${t('打开壁纸文件夹')}</button>
    </aside><div class="library-content"><div data-ui="empty" class="empty-state">${icon('wallpaper')}<h2 data-ui="empty-title"></h2><p data-ui="empty-description"></p><div data-ui="empty-actions" class="empty-actions"><button data-ui="empty-import" class="primary">${icon('plus')}${t('导入视频')}</button><button data-ui="empty-market">${icon('market')}${t('分享市场')}</button></div></div>
    <article data-ui="detail" class="wallpaper-detail"><div class="detail-heading"><h2 data-ui="title"></h2><label class="display-choice">${t('显示器')}<select data-ui="monitor" aria-label="${t('显示器')}"></select></label><span data-ui="position" class="saved-label"></span></div>
    <div class="media-frame"><img data-ui="cover" alt="${t('视频九宫格预览')}"><div data-ui="preview-host" class="preview-host" hidden></div>
      <button data-ui="previous" class="browse-arrow previous" aria-label="${t('上一张壁纸')}">‹</button><button data-ui="next" class="browse-arrow next" aria-label="${t('下一张壁纸')}">›</button>
      <button data-ui="make-cover" hidden>${t('生成九宫格预览')}</button></div>
    <div class="detail-meta"><p data-ui="description" class="muted"></p><details data-ui="quality" class="quality-menu"><summary aria-label="${t('分辨率与下载')}"><span data-ui="quality-label"></span><span class="chevron">⌄</span></summary><div class="quality-popover"><h3>${t('分辨率与下载')}</h3><div data-ui="qualities"></div></div></details></div>
    <div class="wallpaper-toolbar"><div class="preview-toolbar"><button data-ui="preview-toggle" class="round-button" aria-label="${t('播放预览')}" title="${t('播放预览')}">${icon('play')}</button><span data-ui="preview-status">${t('预览视频')}</span>
      <label class="sound" title="${t('预览音量')}">${icon('volume')}<input data-ui="preview-volume" aria-label="${t('预览音量')}" type="range" min="0" max="1" step="0.05" value="0"></label><button data-ui="sheet" class="sheet-button" aria-label="${t('查看九宫格')}" title="${t('查看九宫格')}" hidden>${icon('library')}</button></div>
    <div class="actions"><div class="desktop-status" aria-label="${t('桌面壁纸')}" title="${t('桌面壁纸')}"><strong data-ui="status"></strong></div>
      <div class="wallpaper-split"><button data-ui="apply" class="primary">${icon('wallpaper')}<span data-ui="apply-label">${t('设为壁纸')}</span></button><details data-ui="desktop-menu" class="desktop-menu"><summary aria-label="${t('壁纸控制')}" title="${t('壁纸控制')}">${icon('chevron')}</summary><div class="desktop-popover">
        <button data-ui="desktop-toggle"><span data-ui="desktop-toggle-icon" class="menu-action-icon">${icon('pause')}</span><span data-ui="desktop-toggle-label">${t('暂停壁纸')}</span></button><button data-ui="stop"><span class="menu-action-icon">${icon('stop')}</span><span>${t('停止壁纸')}</span></button>
        <label class="wallpaper-volume"><span class="volume-heading"><span>${t('壁纸音量')}</span><output data-ui="volume-value">0%</output></span><input data-ui="volume" aria-label="${t('壁纸音量')}" type="range" min="0" max="1" step="0.05" value="0"></label>
        <label class="wallpaper-volume">${t('画面适配')}<select data-ui="fit" aria-label="${t('画面适配')}"><option value="cover">${t('铺满桌面（裁剪）')}</option><option value="contain">${t('完整画面（留边）')}</option></select></label>
      </div></details></div><button data-ui="share" aria-label="${t('分享')}" title="${t('分享')}">${icon('share')}<span class="action-label">${t('分享')}</span></button><button data-ui="desktop" aria-label="${t('返回桌面')}" title="${t('返回桌面')}">${icon('desktop')}<span class="action-label">${t('返回桌面')}</span></button>
      <p data-ui="action-notice" class="wallpaper-action-notice" role="status"></p></div></div></article></div></div>`;
  const el = <T extends HTMLElement = HTMLElement>(name: string) =>
    root.querySelector<T>(`[data-ui="${name}"]`)!;
  const button = (name: string) => el<HTMLButtonElement>(name);
  let actionNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  const actionNotice = (text:string) => {
    clearTimeout(actionNoticeTimer);
    el('action-notice').textContent=text;
    if(text)actionNoticeTimer=setTimeout(()=>{el('action-notice').textContent='';},3500);
  };
  let items: Wallpaper[] = [],
    selected = '',
    selectedQuality = '',
    metrics: any = { stopped: true };
  let player: VideoPlayer | LoopPlayer | null = null,
    previewPaused = true,
    previewEpoch = 0,
    previewBusy = false,
    applying = false;
  const choices = () => {
    const q = el<HTMLInputElement>('query').value.trim().toLocaleLowerCase();
    return items.filter((w) => `${w.title} ${w.description}`.toLocaleLowerCase().includes(q));
  };
  const current = () => items.find((w) => w.id === selected);
  const playbackId = () =>
    current()?.playbackIds.includes(selectedQuality) ? selectedQuality : current()?.playbackIds[0];
  const on = (name: string, fn: () => unknown) =>
    (button(name).onclick = () => void Promise.resolve().then(fn).catch(options.report));
  on('empty-import', options.importVideo);
  on('empty-market', options.browseMarket);
  on('library-folder',()=>options.call('library-folder'));
  void options.call('preferences').then(p=>{el<HTMLSelectElement>('fit').value=p.fit;}).catch(options.report);
  el<HTMLSelectElement>('fit').onchange=()=>{void options.call('set-fit',el<HTMLSelectElement>('fit').value).catch(options.report);};
  el<HTMLSelectElement>('monitor').onchange=()=>{void options.call('display-select',el<HTMLSelectElement>('monitor').value).catch(options.report);};
  function previewState() {
    const label = t(previewPaused ? '播放预览' : '暂停预览');
    button('preview-toggle').innerHTML = icon(previewPaused ? 'play' : 'pause');
    button('preview-toggle').setAttribute('aria-label', label);
    button('preview-toggle').title = label;
    button('preview-toggle').disabled = previewBusy || !current()?.ready;
    el('preview-status').textContent = t(
      previewBusy ? '正在启动' : player ? (previewPaused ? '已暂停' : '预览视频') : '预览视频',
    );
    el('sheet').hidden = !player;
  }
  function stopPreview() {
    ++previewEpoch;
    player?.dispose();
    player = null;
    previewPaused = true;
    previewBusy = false;
    el('preview-host').replaceChildren();
    el('preview-host').hidden = true;
    el('cover').hidden = !current()?.cover;
    previewState();
  }
  async function togglePreview() {
    if (previewBusy) return;
    if (player) {
      if (previewPaused) player.resume();
      else player.pause();
      previewPaused = !previewPaused;
      previewState();
      return;
    }
    const id = playbackId();
    if (!id) return;
    const epoch = ++previewEpoch;
    previewBusy = true;
    previewState();
    try {
      const p = await options.call('preview-payload', id);
      if (epoch !== previewEpoch) return;
      const canvas = document.createElement('canvas');
      el('preview-host').append(canvas);
      el('preview-host').hidden = false;
      el('cover').hidden = true;
      const update = (m: any) => {
        if (epoch !== previewEpoch) return;
        previewPaused = !!m.paused;
        previewState();
        if (m.fault) {
          stopPreview();
          options.report(Error('主题播放遇到问题，请重新设为壁纸。'));
        }
      };
      if (p.kind === 'video') player = new LoopPlayer(canvas, p.url, p.label, update);
      else {
        validateRelease(p.data);
        player = new VideoPlayer(p.data, canvas, (rel) => p.baseUrl + rel, update);
      }
      player.setVolume(Number(el<HTMLInputElement>('preview-volume').value));
      await player.start();
    } catch (e) {
      if (epoch === previewEpoch) {
        stopPreview();
        throw e;
      }
    } finally {
      if (epoch === previewEpoch) {
        previewBusy = false;
        previewState();
      }
    }
  }
  function renderCards() {
    const list = el('list');
    list.replaceChildren();
    for (const item of choices()) {
      const card = document.createElement('button');
      card.dataset.id = item.id;
      card.className =
        'wallpaper-card' +
        (item.id === selected ? ' selected' : '') +
        (isActive(item, metrics) ? ' active-wallpaper' : '');
      card.setAttribute('aria-pressed', String(item.id === selected));
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      if (item.cover) image.src = item.cover;
      else image.hidden = true;
      const text = document.createElement('span');
      text.className = 'wallpaper-card-text';
      const name = document.createElement('strong');
      name.textContent = item.title;
      const note = document.createElement('small');
      note.textContent = t(
        isActive(item, metrics) ? '当前壁纸' : item.ready ? '已保存到本机' : item.official || item.market ? '选择规格下载' : '预览尚未生成',
      );
      text.append(name, note);
      card.append(image, text);
      card.onclick = () => select(item.id);
      list.append(card);
    }
  }
  function showVolume(value: number) {
    const percent = `${Math.round(value * 100)}%`;
    const slider = el<HTMLInputElement>('volume');
    slider.value = String(value);
    slider.style.setProperty('--volume-progress', percent);
    if (el('volume-value').textContent !== percent) el('volume-value').textContent = percent;
  }
  function playback(value: any) {
    const previousActive = items.find((item) => isActive(item, metrics))?.id;
    metrics = value ?? { stopped: true };
    // Keep keyboard focus and image elements stable during periodic frame reports.
    if (previousActive !== items.find((item) => isActive(item, metrics))?.id) renderCards();
    el('status').textContent = t(
      metrics.fault
        ? '播放遇到问题'
        : metrics.loading
          ? '正在启动'
          : metrics.stopped
            ? '已停止'
            : metrics.paused
              ? '已暂停'
              : '正在播放',
    );
    el('status').classList.toggle('is-playing', !metrics.stopped && !metrics.paused && !metrics.fault);
    const resume = metrics.paused || metrics.stopped;
    el('desktop-toggle-label').textContent = t(resume ? '继续壁纸' : '暂停壁纸');
    const actionIcon = el('desktop-toggle-icon');
    const action = resume ? 'play' : 'pause';
    if (actionIcon.dataset.action !== action) {
      actionIcon.innerHTML = icon(action);
      actionIcon.dataset.action = action;
    }
    button('desktop-toggle').disabled = !!metrics.loading;
    button('stop').disabled = !!metrics.stopped;
    showVolume(metrics.volume ?? 0);
    const item=current();
    const active=!!item&&isActive(item,metrics)&&metrics.selectionId===playbackId();
    el('apply-label').textContent=t(applying?'正在启动':active?'当前壁纸':'设为壁纸');
    button('apply').disabled = applying || !item?.ready || active;
    const preset=current()?.presets.find(p=>p.id===playbackId());
    if(preset)el('quality-label').textContent=preset.presentation.variantLabel+(metrics.selectionId!==preset.id||metrics.stopped?' · '+t('待应用'):'');
    for(const row of el('qualities').querySelectorAll<HTMLElement>('[data-quality-id]')){
      const used=row.dataset.qualityId===metrics.selectionId&&!metrics.stopped&&!metrics.fault&&!metrics.loading;
      row.classList.toggle('desktop-quality',used);
      row.querySelector<HTMLElement>('.quality-active')!.hidden=!used;
    }
  }
  function render() {
    const visible = choices();
    if (!visible.some((w) => w.id === selected)) {
      stopPreview();
      selected = visible[0]?.id ?? '';
      selectedQuality = '';
    }
    el('count').textContent =
      visible.length === items.length ? String(items.length) : `${visible.length} / ${items.length}`;
    el('empty').hidden = !!visible.length;
    const searching = !!el<HTMLInputElement>('query').value.trim();
    el('empty-title').textContent = t(searching ? '没有找到匹配的壁纸' : featured ? '精选主题尚未安装' : '收藏一段喜欢的画面');
    el('empty-description').textContent = t(searching ? '试试其他名字，或清空搜索查看全部。' : '可以先导入自己的视频，或从分享市场下载壁纸。');
    el('empty-actions').hidden = searching;
    el('detail').hidden = !visible.length;
    renderCards();
    const item = current();
    if (!item || !visible.length) return;
    const preset = item.presets.find((p) => p.id === playbackId()) ?? item.presets[0];
    el('title').textContent = item.title;
    el('position').textContent = `${visible.findIndex((w) => w.id === selected) + 1} / ${visible.length}`;
    const cover = el<HTMLImageElement>('cover');
    if (item.cover) cover.src = item.cover;
    else cover.removeAttribute('src');
    cover.hidden = !item.cover || !!player;
    el('description').textContent = item.video
      ? `${item.video.info.width} × ${item.video.info.height} · ${Math.floor(item.video.info.duration / 60)}:${Math.floor(
          item.video.info.duration % 60,
        )
          .toString()
          .padStart(2, '0')} · ${(item.video.bytes / 1024 ** 2).toFixed(1)} MB`
      : `${item.author ? item.author + ' · ' : ''}${item.description}`;
    button('make-cover').hidden = item.ready || !item.video;
    button('share').disabled = !item.video || !item.ready;
    button('share').title = item.video ? t('分享') : t('精选主题暂不支持分享');
    button('previous').disabled = button('next').disabled = visible.length < 2;
    el('quality').hidden = !preset && !item.official && !item.market;
    if(item.market){
      el('quality-label').textContent=`${item.market.info.width} × ${item.market.info.height}`;
      const download=document.createElement('button');download.textContent=t(item.ready?'已安装':'下载壁纸');download.disabled=item.ready;
      download.onclick=()=>{if(options.downloadMarket)void options.downloadMarket(item.market!.id).catch(options.report);};
      el('qualities').replaceChildren(download);
    }
    if (preset || item.official) {
      el('quality-label').textContent = preset?.presentation.variantLabel ?? t('分辨率与下载');
      el('qualities').replaceChildren();
      for (const variant of item.official?.variants ?? preset!.presentation.variants) {
        const installed = item.presets.find((p) => p.presentation.variantLabel === variant.label);
        const row = document.createElement('div');
        row.className = 'quality-row';
        if(installed)row.dataset.qualityId=installed.id;
        const choice = document.createElement('button');
        choice.className = 'quality-choice';
        choice.disabled = !installed;
        choice.setAttribute('aria-pressed', String(!!installed && installed.id === playbackId()));
        const label = document.createElement('strong');
        label.textContent = variant.label;
        const check=document.createElement('span');check.className='quality-check';check.textContent='✓';check.setAttribute('aria-hidden','true');
        label.prepend(check);
        const activeBadge=document.createElement('span');activeBadge.className='quality-active';activeBadge.textContent=t('桌面使用中');activeBadge.hidden=true;
        const note = document.createElement('small');
        note.textContent = t(
          installed ? (installed.id === playbackId() ? '当前选择 · 已安装' : '已安装') : ('bytes' in variant ? `${(variant.bytes/1024**2).toFixed(0)} MB` : variant.state),
        );
        choice.append(label, note, activeBadge);
        choice.onclick = () => {
          stopPreview();
          selectedQuality = installed!.id;
          el<HTMLDetailsElement>('quality').open = false;
          render();
          if(metrics.selectionId!==installed!.id||metrics.stopped)actionNotice(t('已选择画质，点击“设为壁纸”应用到当前显示器。'));
        };
        const download = document.createElement('button');
        download.textContent = t(installed ? '已安装' : '下载');
        const available='availability' in variant && variant.availability==='ready' && variant.access==='free';
        download.disabled = !!installed || !available || !options.download;
        download.title = t(installed ? '此规格已可离线使用' : available ? '下载' : '暂不可下载');
        download.onclick=()=>{if('id' in variant && options.download){download.disabled=true;void options.download(variant.id).catch(options.report).finally(()=>render());}};
        row.append(choice, download);
        el('qualities').append(row);
      }
    }
    previewState();
    playback(metrics);
  }
  function select(id: string) {
    stopPreview();
    selected = id;
    selectedQuality = current()?.playbackIds.includes(metrics.selectionId) ? metrics.selectionId : '';
    render();
  }
  on('preview-toggle', togglePreview);
  on('sheet', stopPreview);
  on('previous', () => browse(-1));
  on('next', () => browse(1));
  function browse(step: number) {
    const visible = choices();
    if (visible.length < 2) return;
    select(
      visible[(visible.findIndex((w) => w.id === selected) + step + visible.length) % visible.length].id,
    );
  }
  el('query').addEventListener('input', () => {
    stopPreview();
    render();
  });
  on('apply', async () => {
    const id = playbackId();
    if (!id || applying) return;
    stopPreview();
    applying = true;
    playback(metrics);
    try {
      await options.apply(id);
    } finally {
      applying = false;
      playback(metrics);
    }
  });
  on('stop', async () => {
    el<HTMLDetailsElement>('desktop-menu').open = false;
    await options.stop();
  });
  on('desktop-toggle', async () => {
    el<HTMLDetailsElement>('desktop-menu').open = false;
    await options.call(metrics.stopped || metrics.paused ? 'resume' : 'pause');
  });
  on('desktop', () => {
    stopPreview();
    return options.call('panel-close');
  });
  on('share', () => {
    const video = current()?.video;
    if (video) return options.share(video);
  });
  on('make-cover', () => {
    const video = current()?.video;
    if (video) return options.cover(video);
  });
  el('preview-volume').addEventListener('input', () =>
    player?.setVolume(Number(el<HTMLInputElement>('preview-volume').value)),
  );
  el('volume').addEventListener('input', () => {
    const value = Number(el<HTMLInputElement>('volume').value);
    showVolume(value);
    void options.call('volume', value).catch(options.report);
  });
  document.addEventListener('click', (e) => {
    for (const key of ['quality', 'desktop-menu'])
      if (!el(key).contains(e.target as Node)) el<HTMLDetailsElement>(key).open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')
      for (const key of ['quality', 'desktop-menu']) el<HTMLDetailsElement>(key).open = false;
  });
  return {
    actionNotice,
    displays: (data:any) => {
      const select=el<HTMLSelectElement>('monitor');
      const options=data.monitors.map((m:any,i:number)=>new Option(`${i+1} · ${m.label} · ${m.width}×${m.height}${m.primary?' · '+t('主屏'):''}`,m.id));
      select.replaceChildren(...options);select.value=data.target;
      el<HTMLSelectElement>('fit').value=data.monitors.find((m:any)=>m.id===data.target)?.fit??'cover';
    },
    setItems(next: Wallpaper[]) {
      items = next;
      render();
    },
    playback,
    stopPreview,
    select(id: string) {
      el<HTMLInputElement>('query').value = '';
      select(id);
    },
    setApplying(value: boolean) {
      applying = value;
      playback(metrics);
    },
  };
}
