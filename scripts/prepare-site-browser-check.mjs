import {mkdir,readFile,writeFile} from 'node:fs/promises';
import verifySite from '../tests/browser/site-account.mjs';

const assets={};
for(const prefix of ['','en/','ja/'])for(const page of ['index','market','about','download','login','privacy']){
  const body=await readFile(`site/${prefix}${page}.html`,'utf8');
  assets[`/${prefix}${page==='index'?'':page}`]={body,contentType:'text/html; charset=utf-8'};
}
for(const name of ['app.js','i18n.js','style.css'])assets['/'+name]={body:await readFile('site/'+name,'utf8'),contentType:name.endsWith('.css')?'text/css':'application/javascript'};
await mkdir('output/playwright',{recursive:true});
await writeFile('output/playwright/site-account-check.js',`async page => (${verifySite.toString()})(page,${JSON.stringify(assets)})`);
console.log('Prepared fixture browser check: playwright-cli run-code --filename output/playwright/site-account-check.js');
