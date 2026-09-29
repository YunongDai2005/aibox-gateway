import fs from 'node:fs';
const template=fs.readFileSync(new URL('./viewer.template.html',import.meta.url),'utf8');
const trace=JSON.parse(fs.readFileSync(new URL('../docs/demo/trace.json',import.meta.url),'utf8'));
const html=template.replace('__TRACE_JSON__',JSON.stringify(trace).replaceAll('<','\\u003c'));
fs.writeFileSync(new URL('../docs/demo/index.html',import.meta.url),html);
console.log('Built standalone demo: docs/demo/index.html');
