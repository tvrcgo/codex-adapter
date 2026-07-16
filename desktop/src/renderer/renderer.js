const statusDot=document.getElementById("statusDot"),statusLabel=document.getElementById("statusLabel"),statusPort=document.getElementById("statusPort"),logArea=document.getElementById("logArea"),btnStart=document.getElementById("btnStart"),btnStop=document.getElementById("btnStop"),btnRestart=document.getElementById("btnRestart"),btnConfig=document.getElementById("btnConfig");
let logLines=[];
const MAX_LOG=500;
function appendLog(l){logLines.push(l);while(logLines.length>MAX_LOG)logLines.shift();logArea.textContent=logLines.join("\n"),logArea.scrollTop=logArea.scrollHeight}
function updateUI(r,p){statusDot.className="status-dot "+(r?"running":"stopped"),statusLabel.textContent=r?"服务运行中":"服务未运行",statusPort.textContent=r?"端口: "+p:"",btnStart.disabled=r,btnStop.disabled=!r,btnRestart.disabled=!r}
btnStart.onclick=async()=>{const s=await window.electronAPI.startServer();updateUI(s.running,s.port)};
btnStop.onclick=async()=>{const s=await window.electronAPI.stopServer();updateUI(s.running,s.port)};
btnRestart.onclick=async()=>{const s=await window.electronAPI.restartServer();updateUI(s.running,s.port)};
btnConfig.onclick=()=>window.electronAPI.openConfigDir();
window.electronAPI.onServerLog(l=>appendLog(l));
window.electronAPI.onServerStatus(s=>updateUI(s.running,s.port));
(async()=>{const s=await window.electronAPI.getStatus();updateUI(s.running,s.port);const l=await window.electronAPI.getLogs();logLines=l,logArea.textContent=l.join("\n"),logArea.scrollTop=logArea.scrollHeight})();
