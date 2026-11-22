import {readCatalogs,coverage} from './i18n/catalogs.mjs';
import {sourceIssues} from './i18n/source.mjs';
const catalogs=await readCatalogs(),report=coverage(catalogs);
const issues=await sourceIssues(catalogs['en-US']);
if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
else for(const [locale,entry]of Object.entries(report))console.log(`${locale}: ${entry.translated}/${entry.total}; missing=${entry.missing.length}; invalid=${entry.invalid.length}`);
if(issues.length)console.error(JSON.stringify({sourceIssues:issues},null,2));
if(issues.length||Object.values(report).some(entry=>entry.missing.length||entry.invalid.length))process.exitCode=1;
