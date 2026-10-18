import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const root = new URL('../', import.meta.url)
const server = http.createServer((req,res)=>{
 const name = req.url.split('/').pop()
 if (name === 'detection.json') { res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({detected:true,configuredPath:'',platform:'test',arch:'x64',source:'auto'})) }
 if (name === 'widget.js') { res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(new URL('widget.js',root))) }
 if (name === 'quota.json') { res.setHeader('Content-Type','application/json');return res.end('{"ok":true,"windows":[]}') }
 if (name === 'quotes.json') { res.setHeader('Content-Type','application/json');return res.end('{"quotes":[{"text":"BUILTIN","weight":1}]}') }
 if (name.endsWith('.wav') || name === 'niang.png') { res.statusCode=404;return res.end() }
 res.setHeader('Content-Type','text/html; charset=utf-8')
 res.end('<div data-composer-card style="position:fixed;left:300px;bottom:40px;width:600px;height:60px"><div data-composer-input>Test</div></div><script src="/widget.js"></script>')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'niang-quotes-test-'))
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']})
let log='';child.stderr.on('data',d=>log+=d)
const delay=ms=>new Promise(r=>setTimeout(r,ms))
let ws
try {
 for(let i=0;i<100&&!log.includes('DevTools listening on');i++)await delay(100)
 const endpoint=log.match(/ws:\/\/127\.0\.0\.1:(\d+)\//)
 assert.ok(endpoint,'Chrome DevTools started')
 const tabs=await(await fetch(`http://127.0.0.1:${endpoint[1]}/json/list`)).json()
 ws=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl)
 await new Promise(r=>ws.addEventListener('open',r))
 let id=0;const pending=new Map()
 ws.addEventListener('message',e=>{let m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}})
 const cmd=(method,params={})=>new Promise(r=>{pending.set(++id,r);ws.send(JSON.stringify({id,method,params}))})
 const ev=async expression=>{let m=await cmd('Runtime.evaluate',{expression,returnByValue:true});assert.ok(!m.result.exceptionDetails,JSON.stringify(m.result.exceptionDetails));return m.result.result.value}
 await cmd('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await delay(600)
 const open=`[...document.querySelectorAll('.dgn-tbtn')].find(x=>x.textContent==='设置').click()`
 await ev(open)
 assert.equal(await ev(`!!document.querySelector('[role=dialog] textarea')`),true)
 assert.equal(await ev(`document.querySelector('textarea').value`),'BUILTIN')
 assert.equal(await ev(`[...document.querySelectorAll('.dgn-tbtn')].some(x=>x.textContent==='复位')`),false)
 assert.equal(await ev(`[...document.querySelectorAll('.dgn-tbtn')].some(x=>x.textContent==='♫')`),true)
 await ev(`document.querySelector('textarea').value='  HELLO  \\nWORLD';document.querySelector('.dgn-settings input').checked=true;[...document.querySelectorAll('.dgn-settings button')].find(x=>x.textContent==='保存').click()`)
 assert.equal(await ev(`JSON.parse(localStorage.getItem('dgn-cfg')).customQuotes`),'HELLO\nWORLD')
 await cmd('Page.reload');await delay(600);await ev(open)
 assert.equal(await ev(`document.querySelector('textarea').value`),'HELLO\nWORLD')
 await ev(`[...document.querySelectorAll('.dgn-settings button')].find(x=>x.textContent==='取消').click()`)
 await ev(`(()=>{let c=document.querySelector('.dgn-char'),r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent('pointerdown',{clientX:r.x+r.width/2,clientY:r.y+r.height*.6,pointerId:1}));c.dispatchEvent(new PointerEvent('pointerup',{pointerId:1}));})()`)
 assert.ok(['HELLO','WORLD'].includes(await ev(`document.querySelector('.dgn-quote').textContent`)))
 assert.equal(await ev(`getComputedStyle(document.querySelector('.dgn-tools')).display`),'none')
 await ev(open)
 await ev(`[...document.querySelectorAll('.dgn-settings button')].find(x=>x.textContent==='恢复内置回复').click();[...document.querySelectorAll('.dgn-settings button')].find(x=>x.textContent==='保存').click()`)
 assert.equal(await ev(`JSON.parse(localStorage.getItem('dgn-cfg')).customQuotes`),'BUILTIN')
 await ev(open)
 await ev(`document.querySelector('.dgn-settings input[type=checkbox]').checked=false;document.querySelector('.dgn-settings input[type=number]').value='30';[...document.querySelectorAll('.dgn-settings button')].find(x=>x.textContent==='保存').click()`)
 assert.equal(await ev(`JSON.parse(localStorage.getItem('dgn-cfg')).quotaEnabled`),false)
 assert.equal(await ev(`JSON.parse(localStorage.getItem('dgn-cfg')).quotaInterval`),30)
 assert.equal(await ev(`getComputedStyle(document.querySelector('.dgn-badge')).display`),'none')
 console.log('PASS settings categories, prefilled builtins, editing/save/reload, quota toggle/interval, no reset, sound label, overlay exclusion')
 await cmd('Browser.close')
} finally {
 ws?.close();child.kill();server.close()
 // Deliberately retain isolated temp profile for inspection; no user profile is modified.
}
