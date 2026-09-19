import { t } from './i18n';

export async function mountAccount(root: HTMLElement, call: (action: string, value?: unknown) => Promise<any>, report: (error: unknown) => void) {
  const info = await call('market-info');
  let user = await call('market-profile');
  const button = document.createElement('button');
  button.id = 'account-button'; button.className = 'account-button';
  button.hidden = !info.public;
  root.querySelector('.header-actions')!.insertBefore(button, root.querySelector('#language'));
  const dialog = document.createElement('dialog');
  dialog.className = 'account-dialog'; dialog.setAttribute('aria-labelledby', 'account-heading');
  dialog.innerHTML = `<h2 id="account-heading">${t('登录 SofaMate')}</h2><p class="muted" data-account="description"></p><div class="account-code" data-account="code" hidden></div><p data-account="status" role="status"></p><div class="actions"><button data-account="close">${t('关闭')}</button><button data-account="logout" hidden>${t('退出登录')}</button><button class="primary" data-account="continue">${t('在浏览器中登录')}</button></div>`;
  root.append(dialog);
  const get = <T extends HTMLElement = HTMLElement>(name: string) => dialog.querySelector<T>(`[data-account="${name}"]`)!;
  let polling = false, epoch = 0;
  function render() {
    button.textContent = user?.name ?? t('登录');
    button.title = user?.name ?? t('登录 SofaMate');
    dialog.querySelector('h2')!.textContent = user?.name ?? t('登录 SofaMate');
    get('description').textContent = user ? t('已登录，可以分享和管理你的壁纸。') : t('支持邮箱、GitHub 和 Google。登录后即可分享壁纸。');
    get('logout').hidden = !user;
    get('continue').textContent = t(user ? '管理账号' : '在浏览器中登录');
    get('code').hidden = true; get('status').textContent = '';
  }
  render();
  button.onclick = () => { render(); dialog.showModal(); };
  get('close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { polling = false; ++epoch; get<HTMLButtonElement>('continue').disabled = false; });
  get('logout').onclick = () => void call('account-logout').then(() => { user = null; render(); dialog.close(); }).catch(report);
  get('continue').onclick = () => void (async () => {
    if (user) { await call('account-manage'); return; }
    if (polling) return;
    polling = true; const run = ++epoch; get<HTMLButtonElement>('continue').disabled = true;
    try {
      const login = await call('account-start');
      get('code').hidden = false; get('code').textContent = login.code;
      get('status').textContent = t('请核对浏览器中的配对码，完成登录后确认连接。');
      const end = Date.now() + 600000;
      while (polling && run === epoch && Date.now() < end) {
        await new Promise(r => setTimeout(r, 2000));
        if (!polling || run !== epoch) return;
        const result = await call('account-poll');
        if (result.user) { user = result.user; render(); dialog.close(); return; }
      }
    } catch (e) { if (run === epoch) report(e); }
    finally { if (run === epoch) { polling = false; get<HTMLButtonElement>('continue').disabled = false; } }
  })();
  return { public: info.public, async requireLogin() { user = await call('market-profile'); if (info.public && !user) { render(); dialog.showModal(); return false; } return true; } };
}
