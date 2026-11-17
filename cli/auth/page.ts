/** 本机页只启动受控窗口和显示脱敏状态，不收集或接收Tripo凭据。 */
export function loginPage(nonce: string): string {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>ai-modeling · 连接 Tripo Studio</title>
<style>body{font:18px system-ui;max-width:640px;margin:72px auto;padding:24px;background:#102027;color:#edf4f7}button{font:inherit;padding:12px 20px;border:0;border-radius:8px;cursor:pointer;background:#64d8bf}p{line-height:1.65}</style>
<h1>连接 Tripo Studio</h1><p>点击下面的按钮打开登录窗口，使用本人的 Tripo 账号完成登录。登录成功后，等待中的命令会继续。</p>
<form method="post" action="/${nonce}/start"><button>打开登录窗口</button></form><p id="state">等待登录</p>
<script nonce="${nonce}">const labels={checking:'正在检查会话',waiting_for_login:'请在打开的窗口完成登录',verifying:'正在验证登录',authenticated:'连接成功，可以返回终端继续',cancelled:'登录已取消',expired:'登录已过期，请重新运行登录命令',failed:'登录未完成，请返回终端查看原因'};
const timer=setInterval(async()=>{try{const r=await fetch('/${nonce}/status');const s=await r.json();document.getElementById('state').textContent=labels[s.status]||'等待登录';if(['authenticated','cancelled','expired','failed'].includes(s.status))clearInterval(timer)}catch{}},400);</script></html>`;
}
