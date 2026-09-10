let me=null;
let pricingTiers=[];
let userCache=new Map();
let balanceUserId=null;
const PANEL=location.pathname.startsWith("/reseller")?"reseller":"admin";
const DEVICE_LIMITS=[1,10,100,500,1000,2000];
const $=id=>document.getElementById(id);

async function api(url,opt={}){
  const r=await fetch(url,{headers:{"Content-Type":"application/json"},...opt});
  let d={};try{d=await r.json()}catch{}
  if(!r.ok){const e=Error(d.error||"Request failed");e.code=d.code;e.status=r.status;throw e}
  return d;
}
function routeForRole(role){return role==="reseller"?"/reseller":"/admin"}
function formatDate(value){return value?new Date(value).toLocaleString():"LIFETIME"}
function escapeAttr(value){return String(value??"").replace(/\\/g,"\\\\").replace(/'/g,"\\'")}
function panelStatus(user){
  if(!user.active)return "BLOCKED";
  if(user.panel_expires_at&&new Date(user.panel_expires_at)<=new Date())return "EXPIRED";
  return "ACTIVE";
}
function applyRoleUI(){
  document.querySelectorAll(".admin-only").forEach(el=>el.classList.toggle("hidden",me?.role!=="admin"));
  document.querySelectorAll(".reseller-only").forEach(el=>el.classList.toggle("hidden",me?.role!=="reseller"));
  const brandRole=$("brandRole");
  if(brandRole) brandRole.textContent=me?.role==="reseller"?"RESELLER PANEL":"ADMIN PANEL";
}
async function boot(){
  try{
    const d=await api("/api/me");
    if(d.user){
      me=d.user;
      window.rntxSettings=d.settings||{};
      if(me.role!=="admin"&&PANEL!=="reseller"||me.role==="admin"&&PANEL!=="admin"){location.href=routeForRole(me.role);return}
      const brand=document.querySelector(".brand b"); if(brand&&window.rntxSettings.panel_name) brand.textContent=window.rntxSettings.panel_name;
      const game=$("game"); if(game&&window.rntxSettings.default_game) game.value=window.rntxSettings.default_game;
      $("login").classList.add("hidden");$("app").classList.remove("hidden");applyRoleUI();show("dashboard");
    }
  }catch(e){if(e.code)$("loginMsg").textContent=e.message}
}
async function login(){
  try{
    const d=await api("/api/login",{method:"POST",body:JSON.stringify({username:$("user").value,password:$("pass").value,panel:PANEL})});
    me=d.user;location.href=routeForRole(me.role);
  }catch(e){$("loginMsg").textContent=e.message}
}
async function logout(){await api("/api/logout",{method:"POST"});location.href=routeForRole(PANEL==="reseller"?"reseller":"admin")}
function togglePassword(){const input=$("pass"),button=document.querySelector(".password-toggle");if(!input)return;const visible=input.type==="text";input.type=visible?"password":"text";if(button)button.textContent=visible?"◉":"◌";if(button)button.setAttribute("aria-label",visible?"Show password":"Hide password")}
function toggleNav(){$("nav").classList.toggle("navopen")}
function show(id){
  if(id==="users"&&me?.role!=="admin")return;
  document.querySelectorAll(".page").forEach(x=>x.classList.add("hidden"));
  $(id).classList.remove("hidden");$("nav").classList.remove("navopen");
  if(id==="dashboard")loadDash();
  if(id==="keys")loadKeys();
  if(id==="create")loadCreate();
  if(id==="users")loadUsers();
  if(id==="pricing")loadPricing();
  if(id==="transactions")loadTransactions();
  if(id==="referrals")loadRefs();
  if(id==="audit"&&me?.role==="admin")loadAudit();
  if(id==="settings"&&me?.role==="admin")loadSettings();
}
async function loadDash(){
  const d=await api("/api/dashboard");
  $("stats").innerHTML=[["🔑",d.total,"Total Keys"],["🔓",d.used,"Used Keys"],["🔒",d.unused,"Unused Keys"],["👥",d.users,"Total Users"],["⛔",d.blocked,"Blocked Keys"],["🏷️",d.resellers,"Resellers"]].map(x=>`<div class="stat"><div>${x[0]}</div><b>${x[1]}</b><span>${x[2]}</span></div>`).join("");
  $("usage").innerHTML=`${d.total?Math.round(d.used/d.total*100):0}% used — ${d.used} / ${d.total} keys`;
  $("walletSummary").innerHTML=me.role==="reseller"?`<h3>WALLET BALANCE</h3><div class="wallet-amount">₹${Number(d.wallet||0).toLocaleString("en-IN")}</div><p>Available for license purchases. Panel days and license expiry are separate.</p>`:"<h3>ADMIN CONTROL</h3><p>Manage reseller panel days, wallet balances, and maximum device limits from Manage Users.</p>";
  if(me.role==="reseller")$("recentTransactions").innerHTML=d.recentTransactions?.length?d.recentTransactions.map(transactionLine).join(""):"<p>No transactions yet.</p>";
}
async function loadKeys(){
  const rows=await api("/api/keys?q="+encodeURIComponent($("search")?.value||""));
  $("keysBody").innerHTML=rows.map(k=>`<tr><td>${esc(k.license_key)}</td><td>${esc(k.game)}</td><td>${formatDate(k.expires_at)}</td><td><span class="pill">${esc(k.status)}</span></td><td>${k.devices_used}/${k.max_devices}</td><td>${me.role==="admin"?`<button class="small" onclick="toggleKey(${k.id},'${k.status==="BLOCKED"?"UNUSED":"BLOCKED"}')">${k.status==="BLOCKED"?"UNBLOCK":"BLOCK"}</button><button class="small danger" onclick="delKey(${k.id})">DELETE</button>`:`<span class="muted-action">VIEW ONLY</span>`}</td></tr>`).join("")||"<tr><td colspan=6>No generated keys yet.</td></tr>";
}
async function loadCreate(){
  try{pricingTiers=await api("/api/pricing-tiers");renderCreateOptions()}catch(e){$("copyMsg").textContent=e.message}
}
function renderCreateOptions(){
  const durations=[...new Set(pricingTiers.filter(x=>x.active).map(x=>x.duration))];
  const oldDuration=$("duration").value;const oldDevices=$("devices").value;
  $("duration").innerHTML=durations.map(x=>`<option>${esc(x)}</option>`).join("");
  if(durations.includes(oldDuration))$("duration").value=oldDuration;
  $("duration").onchange=()=>renderDeviceOptions();
  renderDeviceOptions(oldDevices);
}
function renderDeviceOptions(preferred){
  const duration=$("duration").value;
  const max=me?.role==="reseller"?Number(me.max_device_limit||2000):2000;
  const options=pricingTiers.filter(x=>x.active&&x.duration===duration&&x.device_limit<=max).sort((a,b)=>a.device_limit-b.device_limit);
  $("devices").innerHTML=options.map(x=>`<option value="${x.device_limit}">${x.device_limit} device${x.device_limit===1?"":"s"} — ₹${Number(x.price).toLocaleString("en-IN")}</option>`).join("");
  if(preferred&&options.some(x=>String(x.device_limit)===String(preferred)))$("devices").value=preferred;
}
function fillLimitSelect(id,value=2000){
  const max=me?.role==="reseller"?Number(me.max_device_limit||2000):2000;
  $(id).innerHTML=DEVICE_LIMITS.filter(n=>n<=max).map(n=>`<option value="${n}" ${Number(value)===n?"selected":""}>${n}</option>`).join("");
}
async function createKey(){
  try{
    const d=await api("/api/keys",{method:"POST",body:JSON.stringify({game:$("game").value,duration:$("duration").value,maxDevices:Number($("devices").value)})});
    const keys=d.keys?.length?d.keys:[{key:d.key}];
    $("newKey").classList.remove("hidden");
    $("newKey").innerHTML=keys.map(item=>`<div class="copy-row"><code>${esc(item.key)}</code><button class="copy-button" onclick="copyKey('${escapeAttr(item.key)}',this)">COPY KEY</button></div>`).join("");
    $("copyMsg").textContent="";toastCopyMessage("License generated successfully.");loadKeys();loadDash();
  }catch(e){$("copyMsg").textContent=e.message}
}
async function copyKey(key,button){
  try{
    if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(key);
    else{const area=document.createElement("textarea");area.value=key;area.setAttribute("readonly","");area.style.position="fixed";area.style.opacity="0";document.body.appendChild(area);area.select();document.execCommand("copy");area.remove()}
    button.textContent="COPIED";$("copyMsg").textContent="License key copied!";setTimeout(()=>{if(button.isConnected)button.textContent="COPY KEY"},1800);
  }catch(e){$("copyMsg").textContent="Unable to copy key. Please copy it manually."}
}
function toastCopyMessage(message){$("copyMsg").textContent=message;setTimeout(()=>{if($("copyMsg"))$("copyMsg").textContent=""},2200)}
async function toggleKey(id,status){
  if(me?.role!=="admin"){alert("Only admin can block or unblock license keys.");return}
  try{await api("/api/keys/"+id,{method:"PATCH",body:JSON.stringify({status})});loadKeys()}catch(e){alert(e.message)}
}
async function delKey(id){if(me?.role!=="admin"){alert("Only admin can delete license keys.");return}if(confirm("Delete this key?")){await api("/api/keys/"+id,{method:"DELETE"});loadKeys()}}
async function loadUsers(){
  if(me.role!=="admin")return;
  fillLimitSelect("nmax",2000);
  const rows=await api("/api/users");userCache=new Map(rows.map(u=>[u.id,u]));
  $("usersBody").innerHTML=rows.map(u=>`<tr><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td><span class="pill ${panelStatus(u)==="ACTIVE"?"":"danger-pill"}">${panelStatus(u)}</span></td><td>${formatDate(u.panel_expires_at)}</td><td>₹${Number(u.balance||0).toLocaleString("en-IN")}</td><td>${u.role==="reseller"?u.max_device_limit:"—"}</td><td>${u.role==="reseller"?`<button class="small" onclick="openBalance(${u.id})">ADD/EDIT BALANCE</button><button class="small" onclick="openEdit(${u.id})">EDIT</button><button class="small ${u.active?"danger":""}" onclick="userActive(${u.id},${u.active?0:1})">${u.active?"BLOCK PANEL":"UNBLOCK PANEL"}</button><button class="small danger" onclick="deleteReseller(${u.id})">DELETE</button>`:"—"}</td></tr>`).join("")||"<tr><td colspan=7>No resellers yet.</td></tr>";
}
async function createUser(){
  try{const d=await api("/api/users",{method:"POST",body:JSON.stringify({username:$("nu").value,password:$("np").value,days:$("nd").value||null,maxDeviceLimit:Number($("nmax").value)})});alert("Reseller created. Referral: "+d.referral_code);$("nu").value=$("np").value=$("nd").value="";loadUsers()}
  catch(e){alert(e.message)}
}
async function userActive(id,active){try{await api("/api/users/"+id,{method:"PATCH",body:JSON.stringify({active})});loadUsers()}catch(e){alert(e.message)}}
function openBalance(id){
  const u=userCache.get(id);if(!u)return;
  balanceUserId=id;$("balanceFor").textContent=`Reseller: ${u.username}`;$("balanceCurrent").textContent=`₹${Number(u.balance||0).toLocaleString("en-IN")}`;$("balanceAmount").value="";$("balanceExact").value="";$("balanceMsg").textContent="";$("balanceModal").classList.remove("hidden");$("balanceAmount").focus();
}
async function addBalance(){
  try{
    const d=await api(`/api/users/${balanceUserId}/balance`,{method:"POST",body:JSON.stringify({amount:Number($("balanceAmount").value),description:$("balanceDescription").value})});
    closeModal("balanceModal");alert(`New balance: ₹${Number(d.balanceAfter).toLocaleString("en-IN")}`);loadUsers();loadDash();
  }catch(e){$("balanceMsg").textContent=e.message}
}
async function setBalance(){
  const value=Number($("balanceExact").value);
  if(!Number.isInteger(value)||value<0){$("balanceMsg").textContent="Enter a valid non-negative balance.";return}
  if(!confirm("Confirm setting this reseller's exact wallet balance?"))return;
  try{
    const d=await api(`/api/users/${balanceUserId}/balance`,{method:"PATCH",body:JSON.stringify({balance:value,description:$("balanceDescription").value||"Admin wallet balance adjustment"})});
    closeModal("balanceModal");alert(`New balance: ₹${Number(d.balanceAfter).toLocaleString("en-IN")}`);loadUsers();loadDash();
  }catch(e){$("balanceMsg").textContent=e.message}
}
function openEdit(id){
  const u=userCache.get(id);if(!u)return;
  $("editUserId").value=id;$("editUsername").value=u.username;$("editPassword").value="";
  const days=u.panel_expires_at?Math.max(1,Math.ceil((new Date(u.panel_expires_at)-Date.now())/86400000)):"";
  $("editPanelDays").value=days;fillLimitSelect("editMaxDevices",u.max_device_limit);$("editMsg").textContent="";$("editModal").classList.remove("hidden");
}
async function saveUserEdit(){
  const id=Number($("editUserId").value),u=userCache.get(id),username=$("editUsername").value.trim(),password=$("editPassword").value;
  const usernameChanged=username!==u.username,passwordReset=Boolean(password);
  if((usernameChanged||passwordReset)&&!confirm(`Confirm ${usernameChanged&&passwordReset?"changing the username and resetting the password":usernameChanged?"changing the username":"resetting the password"} for ${u.username}?`))return;
  const body={username,panelDays:$("editPanelDays").value,maxDeviceLimit:Number($("editMaxDevices").value)};
  if(passwordReset)body.password=password;
  try{await api(`/api/users/${id}`,{method:"PATCH",body:JSON.stringify(body)});closeModal("editModal");loadUsers()}catch(e){$("editMsg").textContent=e.message}
}
async function deleteReseller(id=Number($("editUserId").value)){
  const u=userCache.get(id);if(!u)return;
  if(!confirm(`Permanently delete reseller "${u.username}" and all of their license/order data? This cannot be undone.`))return;
  try{await api(`/api/users/${id}`,{method:"DELETE"});closeModal("editModal");alert("Reseller deleted.");loadUsers()}catch(e){alert(e.message)}
}
function closeModal(id){$(id).classList.add("hidden")}
async function loadPricing(){
  try{
    const rows=await api("/api/pricing-tiers");
    $("pricingBody").innerHTML=rows.map(t=>`<tr><td>${esc(t.duration)}</td><td>${t.device_limit}</td><td>${me.role==="admin"?`<input class="price-edit" id="tier-${t.id}" type="number" min="0" value="${t.price}">`:`₹${Number(t.price).toLocaleString("en-IN")}`}</td>${me.role==="admin"?`<td><button class="small" onclick="saveTier(${t.id})">SAVE</button></td>`:""}</tr>`).join("");
  }catch(e){alert(e.message)}
}
async function saveTier(id){try{await api("/api/pricing-tiers/"+id,{method:"PATCH",body:JSON.stringify({price:Number($("tier-"+id).value)})});alert("Pricing updated.");loadPricing();if(!$("create").classList.contains("hidden"))loadCreate()}catch(e){alert(e.message)}}
async function loadAudit(){
  if(me?.role!=="admin")return;
  try{
    const rows=await api("/api/audit-logs?limit=200");
    $("auditBody").innerHTML=rows.map(x=>`<tr><td>${formatDate(x.created_at)}</td><td><span class="pill">${esc(x.event_type)}</span></td><td>${esc(x.username||"SYSTEM")}</td><td>${esc(x.ip_address||"—")}</td><td class="audit-meta">${esc(x.metadata||"{}")}</td></tr>`).join("")||"<tr><td colspan=5>No audit events yet.</td></tr>";
  }catch(e){alert(e.message)}
}
function transactionLine(t){return `<div class="transaction-line"><span>${formatDate(t.created_at)}</span><b class="${t.amount<0?"debit":"credit"}">${t.amount<0?"":"+"}₹${Math.abs(Number(t.amount)).toLocaleString("en-IN")}</b><span>${esc(t.type)} — ${esc(t.description)}</span></div>`}
async function loadTransactions(){
  const rows=await api("/api/transactions");
  $("transactionsBody").innerHTML=rows.map(t=>`<tr><td>${formatDate(t.created_at)}</td><td>${esc(t.username||"SYSTEM")}</td><td>${esc(t.type)}</td><td class="${t.amount<0?"debit":"credit"}">${t.amount<0?"":"+"}₹${Math.abs(Number(t.amount)).toLocaleString("en-IN")}</td><td>₹${Number(t.balance_before).toLocaleString("en-IN")}</td><td>₹${Number(t.balance_after).toLocaleString("en-IN")}</td><td>${esc(t.description)}</td></tr>`).join("")||"<tr><td colspan=7>No transactions yet.</td></tr>";
}
async function loadSettings(){
  if(me?.role!=="admin")return;
  try{
    const s=await api("/api/settings");
    $("settingPanelName").value=s.panel_name||"";
    $("settingDefaultGame").value=s.default_game||"";
    $("settingMaintenance").value=s.maintenance_mode==="1"?"1":"0";
  }catch(e){$("settingsMsg").textContent=e.message}
}
async function saveSettings(){
  try{
    await api("/api/settings",{method:"PATCH",body:JSON.stringify({panel_name:$("settingPanelName").value,default_game:$("settingDefaultGame").value,maintenance_mode:$("settingMaintenance").value})});
    $("settingsMsg").textContent="Settings saved.";
    setTimeout(()=>{if($("settingsMsg"))$("settingsMsg").textContent=""},2200);
  }catch(e){$("settingsMsg").textContent=e.message}
}

async function loadRefs(){
  const rows=await api("/api/referrals");
  $("myRef").textContent=me?.username==="admin"?"RNTXADMIN":"Your reseller referral code is shown in your account";
  $("refBody").innerHTML=rows.length?rows.map(x=>`<p>👤 ${esc(x.username)} — ${x.active?"ACTIVE":"BLOCKED"} — ${esc(x.referral_code)}</p>`).join(""):"<p>No referred users yet.</p>";
}
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
boot();