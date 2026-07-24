import fs from 'node:fs';
const url=process.env.SUPABASE_URL||'';
const key=process.env.SUPABASE_ANON_KEY||'';
fs.writeFileSync('public/runtime-config.js',`window.RUNTIME_CONFIG=${JSON.stringify({supabaseUrl:url,supabaseAnonKey:key})};\n`);
fs.mkdirSync('public/vendor',{recursive:true});
fs.copyFileSync('node_modules/papaparse/papaparse.min.js','public/vendor/papaparse.min.js');
console.log('Runtime config generated.');
