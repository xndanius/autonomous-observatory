import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {publicState} from '../lab.mjs';
const root=new URL('../',import.meta.url);
createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;let content,type='text/html; charset=utf-8';if(path==='/api/state'){content=JSON.stringify(await publicState());type='application/json';}else if(path==='/engine.mjs'){content=await readFile(new URL('engine.mjs',root),'utf8');type='text/javascript';}else if(path==='/'||path==='/index.html')content=await readFile(new URL('viewer.html',root),'utf8');else{res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(content);}catch(error){res.writeHead(500);res.end(error.message);}}).listen(8017,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:8017'));
