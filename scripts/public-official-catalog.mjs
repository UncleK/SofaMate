import fs from 'node:fs/promises';

// Public distribution policy is separate from locally completed/installed media.
export function publicCatalog(source) {
  const catalog=structuredClone(source);
  for(const theme of catalog.themes)for(const variant of theme.variants){
    if(variant.height>=2160){variant.availability='local-only';variant.downloadNote='4K 暂不开放公网下载';}
  }
  return catalog;
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/public-official-catalog.mjs')){
  const catalog=publicCatalog(JSON.parse(await fs.readFile('official-store/catalog.json','utf8')));
  await fs.writeFile('assets/official-catalog.json',JSON.stringify(catalog,null,2)+'\n');
  await fs.writeFile('reports/official-collection/20260922/public-catalog.json',JSON.stringify(catalog,null,2)+'\n');
}
