import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../worker/index.js',import.meta.url),'utf8');
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const env={BUCKET:{get:async()=>null}};
createServer(async(req,res)=>{try{const response=await worker.fetch(new Request('http://127.0.0.1:8018'+req.url,{method:req.method,headers:req.headers}),env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end('Preview unavailable');}}).listen(8018,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:8018'));
