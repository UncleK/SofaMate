// Fixture-only browser regression. Run through scripts/prepare-site-browser-check.mjs
// and playwright-cli run-code --filename. No production account is created or changed.
export default async function verifySite(page, assets) {
  const origin='https://sofamate.aveniqa.com';
  let user=null, hold=false;
  const pending=[], results=[], errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const check=(condition,label)=>{if(!condition)throw new Error(label);results.push(label);};
  const context=page.context();
  await context.route(origin+'/**',async route=>{
    const pathname=route.request().url().slice(origin.length).split('?')[0];
    if(pathname==='/v1/auth/me'){
      const current=user ? {...user} : null;
      if(hold){pending.push({route,user:current});return;}
      return route.fulfill({status:current?200:401,json:current?{user:current}:{error:'unauthorized'}});
    }
    if(pathname==='/v1/auth/logout'){user=null;return route.fulfill({json:{loggedOut:true}});}
    if(pathname==='/v1/auth/config')return route.fulfill({json:{unified:true}});
    if(pathname.startsWith('/v1/auth/'))return route.fulfill({status:404,json:{error:'fixture only'}});
    if(pathname==='/v1/items')return route.fulfill({json:{items:[],total:0,nextOffset:null}});
    const asset=assets[pathname];
    if(asset)return route.fulfill({body:asset.body,contentType:asset.contentType});
    return route.continue();
  });
  for(const prefix of ['','/en','/ja']){
    await page.goto(origin+prefix+'/about');
    await page.waitForFunction(()=>document.querySelector('#site-account')?.textContent===window.sofaCopy.login);
    const href=await page.locator('#site-account').getAttribute('href'); check(href===prefix+'/login',prefix+' anonymous account link: '+href);
  }
  user={id:'fixture-user',name:'SofaMate_fixture',email:'fixture@example.test'};
  for(const prefix of ['','/en','/ja'])for(const name of ['','market','about','download','login','privacy']){
    // Keep the saved locale consistent with this navigation, as the actual selector does.
    await page.evaluate(locale=>localStorage.setItem('sofamate-language',locale),prefix.slice(1)||'zh');
    await page.goto(origin+prefix+'/'+name);
    await page.waitForFunction(()=>document.querySelector('#site-account')?.textContent==='SofaMate_fixture');
    check(await page.locator('#site-account').getAttribute('href')===prefix+'/login',prefix+'/'+name+' shows verified nickname');
  }
  await page.goto(origin+'/en/download?theme=living-room-night');
  await page.locator('#selected-scene').waitFor({state:'visible'});
  check(await page.locator('#selected-download').getAttribute('href')==='/en/market','full theme keeps locale and does not download an excerpt');
  check(!(await page.locator('#selected-description').textContent()).includes('ready to download too'),'full theme description');
  await page.goto(origin+'/download?scene=night');
  await page.locator('#selected-scene').waitFor({state:'visible'});
  check(!(await page.locator('#selected-download').getAttribute('href')).includes('.mp4'),'legacy scene link resolves to complete theme');
  user.name='<img src=x onerror=alert(1)>';
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.querySelector('#site-account')?.textContent==='<img src=x onerror=alert(1)>');
  check(await page.locator('#site-account img').count()===0,'nickname remains text');
  user.name='A creator with an extremely long nickname for mobile layout';
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.querySelector('#site-account')?.textContent.startsWith('A creator'));
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'long nickname does not overflow mobile');
  await page.screenshot({path:'output/playwright/site-download-mobile.png',fullPage:true});
  await page.setViewportSize({width:1366,height:900});
  await page.screenshot({path:'output/playwright/site-download-desktop.png',fullPage:true});
  user=null;
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await page.waitForFunction(()=>document.querySelector('#site-account')?.textContent===window.sofaCopy.login);
  check(true,'expired session clears nickname after back-forward restore');
  user={id:'fixture-user',name:'SofaMate_fixture',email:'fixture@example.test'};
  await page.evaluate(()=>localStorage.setItem('sofamate-language','zh'));
  await page.goto(origin+'/login');
  await page.locator('#signed-in').waitFor({state:'visible'});
  const other=await context.newPage();
  await other.goto(origin+'/market');
  await other.waitForFunction(()=>document.querySelector('#site-account')?.textContent==='SofaMate_fixture');
  hold=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  for(let i=0;i<20 && pending.length===0;i++)await page.waitForTimeout(50);
  check(pending.some(p=>p.user),'delayed signed-in response captured');
  await page.locator('#sign-out').click();
  await page.locator('#unified-sign-in').waitFor({state:'visible'});
  hold=false;
  for(const item of pending.splice(0))await item.route.fulfill({status:item.user?200:401,json:item.user?{user:item.user}:{error:'unauthorized'}});
  await other.waitForFunction(()=>document.querySelector('#site-account')?.textContent===window.sofaCopy.login);
  await page.waitForTimeout(100);
  check(await page.locator('#site-account').textContent()===await page.evaluate(()=>window.sofaCopy.login),'logout wins over stale signed-in response');
  check(await page.locator('#signed-in').isHidden(),'logout removes account details');
  check(true,'logout propagates to another open page');
  check(await page.evaluate(()=>!Object.keys(localStorage).some(key=>/token|email|user/.test(key))),'no identity or token stored in localStorage');
  check(errors.length===0,'no page script errors');
  await other.close();
  await context.unrouteAll({behavior:'wait'});
  return {passed:results.length,checks:results};
}
