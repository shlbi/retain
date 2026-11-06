import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHandler } from '../server/workspace-handler.js';
const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const port=Number(option('--port',process.env.PORT||'3000'));
const host=option('--host','127.0.0.1');
const qaModule=option('--qa-module',null);
if(qaModule && (process.env.VERCEL || process.env.NODE_ENV==='production'))throw new Error('QA modules cannot run in production.');
// An explicitly selected local test module is never loaded by the production API.
const database=qaModule?(await import(pathToFileURL(path.resolve(qaModule)).href)).default:undefined;
const handler=createHandler({env:{...process.env,NODE_ENV:'development'},database});
const root=path.resolve('dist');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/workspace')return handler(req,res);
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  try{
    const requested=decodeURIComponent(url.pathname)==='/'?'index.html':decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file=path.resolve(root,requested);
    if(!file.startsWith(root+path.sep))throw new Error();
    const bytes=await readFile(file);
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:bytes);
  }catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');}
}).listen(port,host,()=>console.log(`Local workspace: http://${host}:${port}${qaModule?' (test database)':''}`));
