(function(){
  const $=id=>document.getElementById(id);
  async function api(url,opt={}){const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opt});let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||'Request failed');return d}
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]||m));
  function inject(){
    const nav=document.getElementById('nav'), main=document.querySelector('main');
    if(!nav||!main||document.getElementById('masterCommand')) return;
    const btn=document.createElement('button');btn.className='admin-only';btn.textContent='🧠 MASTER CENTER';btn.onclick=()=>show('masterCommand');nav.insertBefore(btn,nav.querySelector('button[onclick*="logout"]'));
    const sec=document.createElement('section');sec.id='masterCommand';sec.className='page hidden admin-only';
    sec.innerHTML='<div class="row"><h2>🧠 MASTER COMMAND CENTER</h2><button class="small" id="mcRefresh">↻ REFRESH</button></div>'+
      '<div class="mc-grid">'+
      '<div class="card mc-card"><div class="mc-icon">🛡️</div><h3>SECURITY SNAPSHOT</h3><div id="mcSecurity" class="mc-list">Loading...</div></div>'+
      '<div class="card mc-card"><div class="mc-icon">💾</div><h3>BACKUP CENTER</h3><p class="muted">Export the current master data as a portable JSON backup.</p><button id="mcBackup">DOWNLOAD BACKUP</button><div id="mcBackupMsg" class="copy-msg"></div></div>'+
      '<div class="card mc-card"><div class="mc-icon">⚡</div><h3>QUICK ACTIONS</h3><div class="mc-actions"><button onclick="location.href=\'/owner\'">👑 OWNER CONTROL</button><button onclick="show(\'users\')">👥 RESELLERS</button><button onclick="show(\'keys\')">🔑 ALL KEYS</button><button onclick="show(\'audit\')">🛡️ AUDIT LOGS</button><button onclick="show(\'transactions\')">💳 TRANSACTIONS</button></div></div>'+
      '</div>'+
      '<div class="card"><div class="row"><h3>🚦 SYSTEM STATUS</h3><span id="mcStatus" class="health-ok">READY</span></div><div id="mcStatusGrid" class="mc-status-grid"></div></div>'+
      '<div class="card"><div class="row"><h3>🧾 RECENT SECURITY EVENTS</h3><button class="small" id="mcAuditRefresh">↻ REFRESH</button></div><div id="mcEvents" class="mc-events">Loading...</div></div>';
    main.insertBefore(sec,main.firstElementChild);
    $('mcRefresh').onclick=load;
    $('mcAuditRefresh').onclick=loadAudit;
    $('mcBackup').onclick=downloadBackup;
  }
  async function load(){
    const status=$('mcStatus'); if(status) status.textContent='SYNCING...';
    try{
      const [a,u,p,logs]=await Promise.all([api('/api/master/analytics'),api('/api/users'),api('/api/owner/panels'),api('/api/audit-logs?limit=80')]);
      const activeRes=u.filter(x=>x.role==='reseller'&&x.active).length, blockedRes=u.filter(x=>x.role==='reseller'&&!x.active).length;
      const activePanels=p.filter(x=>x.active).length, blockedPanels=p.filter(x=>!x.active).length;
      const since=Date.now()-86400000;
      const recent=logs.filter(x=>new Date(x.created_at).getTime()>=since);
      const ips=new Set(recent.map(x=>x.ip_address).filter(Boolean));
      $('mcSecurity').innerHTML='<div>Active resellers <b>'+activeRes+'</b></div><div>Blocked resellers <b>'+blockedRes+'</b></div><div>Active customer panels <b>'+activePanels+'</b></div><div>Blocked panels <b>'+blockedPanels+'</b></div><div>Audit events / 24h <b>'+recent.length+'</b></div><div>Unique IPs / 24h <b>'+ips.size+'</b></div>';
      $('mcStatusGrid').innerHTML='<div><span>Keys</span><b>'+esc(a.keys?.total??0)+'</b></div><div><span>Resellers</span><b>'+esc(a.resellers?.total??0)+'</b></div><div><span>Customer Panels</span><b>'+esc(a.panels?.total??0)+'</b></div><div><span>Wallet Credits</span><b>₹'+esc(a.money?.credits??0)+'</b></div><div><span>License Debits</span><b>₹'+esc(a.money?.license_debits??0)+'</b></div><div><span>Today Debits</span><b>₹'+esc(a.today?.license_debits??0)+'</b></div>';
      renderEvents(logs.slice(0,12));
      status.textContent='ONLINE · '+new Date().toLocaleTimeString();
      status.className='health-ok';
    }catch(e){status.textContent='ERROR';status.className='health-bad';$('mcSecurity').textContent=e.message}
  }
  async function loadAudit(){try{const logs=await api('/api/audit-logs?limit=80');renderEvents(logs.slice(0,12))}catch(e){$('mcEvents').textContent=e.message}}
  function renderEvents(rows){$('mcEvents').innerHTML=rows.map(x=>'<div class="mc-event"><div><b>'+esc(x.event_type)+'</b><span>'+esc(x.username||'system')+'</span></div><time>'+esc(new Date(x.created_at).toLocaleString())+'</time><small>'+esc(x.ip_address||'—')+'</small></div>').join('')||'<span class="muted">No audit events.</span>'}
  async function downloadBackup(){
    const msg=$('mcBackupMsg');msg.textContent='Collecting data...';
    try{
      const [analytics,users,panels,keys,transactions,audit]=await Promise.all([
        api('/api/master/analytics'),api('/api/users'),api('/api/owner/panels'),api('/api/keys?limit=500'),api('/api/transactions?limit=500'),api('/api/audit-logs?limit=500')
      ]);
      const payload={backup_type:'DANGER_MASTER_PANEL_JSON',version:1,created_at:new Date().toISOString(),analytics,users,customer_panels:panels,keys,transactions,audit_logs:audit};
      const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='danger-master-backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
      msg.textContent='Backup downloaded ✅';
    }catch(e){msg.textContent='Backup failed: '+e.message}
  }
  window.addEventListener('load',()=>{inject();setTimeout(()=>{if(document.getElementById('masterCommand'))load()},500)});
})();