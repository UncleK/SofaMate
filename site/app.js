const $ = id => document.getElementById(id);
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(response.status === 429 ? '操作太频繁，请稍后再试。' : '服务暂时不可用，请稍后重试。');
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '暂时无法连接，请稍后重试。');
  return value;
}
if ($('email-form')) {
  let challengeId = '', resendAt = 0;
  const desktop = new URLSearchParams(location.search).get('desktop');
  const validDesktop = desktop && /^[a-f0-9]{64}$/.test(desktop) ? desktop : '';
  const status = (text, error = false) => { $('auth-status').textContent = text; $('auth-status').classList.toggle('error', error); };
  const run = async fn => { try { await fn(); } catch (error) { status(error.message, true); } };
  function updateResend() { const seconds = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)); $('resend-code').disabled = seconds > 0; $('resend-code').textContent = seconds ? `${seconds} 秒后重新发送` : '重新发送'; }
  async function send() {
    $('send-code').disabled = true; $('change-email').disabled = true; status('正在发送验证码…');
    try {
      const result = await api('/v1/auth/email/start', { email: $('email').value, name: $('name').value });
      challengeId = result.challengeId; resendAt = Date.now() + result.retryAfter * 1000;
      $('email-form').hidden = true; $('code-form').hidden = false; $('code').focus(); updateResend();
      status('验证码已发送，请查看邮箱。10 分钟内有效。');
    } finally { $('send-code').disabled = false; $('change-email').disabled = false; }
  }
  async function showUser(user) {
    $('sign-in').hidden = true; $('signed-in').hidden = false;
    $('auth-title').textContent = '很高兴，再见到你。'; $('user-name').textContent = user.name; $('user-email').textContent = user.email;
    status('');
    if (validDesktop) {
      const pair = await api('/v1/auth/desktop/info?id=' + validDesktop);
      $('pairing').hidden = false; $('pair-code').textContent = pair.code; $('account-actions').hidden = true;
    }
  }
  $('email-form').addEventListener('submit', event => { event.preventDefault(); void run(send); });
  $('resend-code').onclick = () => void run(send);
  $('change-email').onclick = () => {
    challengeId = ''; $('code').value = ''; $('code-form').hidden = true;
    $('email-form').hidden = false; status(''); $('email').focus();
  };
  setInterval(updateResend, 1000);
  $('code-form').addEventListener('submit', event => { event.preventDefault(); void run(async () => {
    const button = $('code-form').querySelector('button'); button.disabled = true; $('change-email').disabled = true;
    try { const result = await api('/v1/auth/email/verify', { challengeId, code: $('code').value }); await showUser(result.user); }
    finally { button.disabled = false; $('change-email').disabled = false; }
  }); });
  $('approve-desktop').onclick = () => void run(async () => {
    $('approve-desktop').disabled = true;
    try { await api('/v1/auth/desktop/approve', { id: validDesktop }); $('pairing').hidden = true; status('已连接。可以返回 SofaMate 客户端了。'); }
    finally { $('approve-desktop').disabled = false; }
  });
  $('sign-out').onclick = () => void run(async () => { await api('/v1/auth/logout', {}); location.reload(); });
  void run(async () => {
    const config = await api('/v1/auth/config');
    for (const provider of ['github', 'google']) {
      const button = $(provider + '-login'), link = $('link-' + provider);
      if (!config[provider]) { button.removeAttribute('href'); button.setAttribute('aria-disabled', 'true'); button.style.opacity = '.45'; button.title = '正在配置，暂未开放'; link.hidden = true; }
      else if (validDesktop) button.href += '?desktop=' + validDesktop;
    }
    if (!config.email) { $('send-code').disabled = true; status('邮箱服务正在配置，请使用其他登录方式。'); }
    try { await showUser((await api('/v1/auth/me')).user); }
    catch { if (new URLSearchParams(location.search).get('error') === 'link-required') status('此邮箱已有账号。请先用邮箱验证码登录，再选择绑定第三方账号。'); }
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
