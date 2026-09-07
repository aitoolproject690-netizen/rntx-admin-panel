let me = null;
let plans = [];
let users = [];
let selectedUserId = null;
const $ = id => document.getElementById(id);
const money = n => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const date = value => value ? new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z")).toLocaleString([], {dateStyle:"medium",timeStyle:"short"}) : "—";
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));

async function api(url, opt = {}) {
  const r = await fetch(url, {headers: {"Content-Type":"application/json", ...(opt.headers || {})}, ...opt});
  let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) throw Error(d.error || "Request failed");
  return d;
}
function toast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-mark">${type === "success" ? "✓" : "!"}</span><span>${esc(message)}</span>`;
  $("toastStack").appendChild(el);
  setTimeout(() => el.classList.add("out"), 3200);
  setTimeout(() => el.remove(), 3600);
}
function setLoading(el, loading) { if (el) { el.disabled = loading; el.classList.toggle("loading", loading); } }
async function boot() {
  try {
    const d = await api("/api/me");
    if (d.user) enterApp(d.user);
  } catch {}
}
function enterApp(user) {
  me = user;
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("currentUser").textContent = user.username;
  $("helloName").textContent = user.username;
  $("currentRole").textContent = user.role === "admin" ? "Administrator" : "Reseller";
  document.querySelectorAll(".admin-only").forEach(x => x.classList.toggle("hidden", user.role !== "admin"));
  show("dashboard");
}
async function login() {
  const button = document.querySelector("#login .button");
  setLoading(button, true);
  $("loginMsg").textContent = "";
  try {
    const d = await api("/api/login", {method:"POST", body:JSON.stringify({username:$("user").value.trim(),password:$("pass").value})});
    enterApp(d.user);
  } catch (e) { $("loginMsg").textContent = e.message; }
  finally { setLoading(button, false); }
}
async function logout() { await api("/api/logout", {method:"POST"}); location.reload(); }
function toggleNav() { $("nav").classList.toggle("navopen"); $("mobileOverlay").classList.toggle("visible"); }
function show(id) {
  if (id === "users" && me.role !== "admin") return toast("Admin access required", "error");
  document.querySelectorAll(".page").forEach(x => x.classList.add("hidden"));
  $(id).classList.remove("hidden");
  document.querySelectorAll(".nav-item[data-page]").forEach(x => x.classList.toggle("active", x.dataset.page === id));
  const title = document.querySelector(`[data-page="${id}"]`);
  $("pageTitle").textContent = title ? title.textContent.trim() : id;
  if ($("nav").classList.contains("navopen")) toggleNav();
  if (id === "dashboard") loadDash();
  if (id === "keys") loadKeys();
  if (id === "create") loadCreate();
  if (id === "users") loadUsers();
  if (id === "pricing") loadPricing();
  if (id === "transactions") loadTransactions();
  if (id === "referrals") loadRefs();
}
async function loadDash() {
  try {
    const d = await api("/api/dashboard");
    if (me?.role === "reseller") me.balance = d.wallet || 0;
    $("stats").innerHTML = [
      ["◈", d.total, "Total licenses", "purple"], ["✓", d.used, "Active licenses", "green"],
      ["○", d.unused, "Available keys", "blue"], ["♙", d.resellers, "Active resellers", "orange"]
    ].map(x => `<div class="stat-card"><div class="stat-top"><span class="stat-icon ${x[3]}">${x[0]}</span><span class="stat-trend">LIVE</span></div><strong>${x[1]}</strong><span>${x[2]}</span></div>`).join("");
    const usedPercent = d.total ? Math.round(d.used / d.total * 100) : 0;
    $("usagePercent").textContent = `${usedPercent}%`;
    $("usageCount").textContent = `${d.used} / ${d.total}`;
    $("walletAmount").textContent = d.wallet === null ? "Admin account" : money(d.wallet);
    document.querySelector(".usage-panel").style.setProperty("--usage", `${usedPercent * 3.6}deg`);
    $("recentBody").innerHTML = d.recentTransactions?.length ? d.recentTransactions.map(transactionRow).join("") : emptyRow(5, "No transactions recorded yet");
  } catch (e) { toast(e.message, "error"); }
}
function transactionRow(t) {
  const positive = t.type === "CREDIT";
  return `<tr><td class="mono">${esc(t.transaction_id)}</td><td>${esc(t.username || "—")}</td><td><span class="type-pill ${positive ? "credit" : "debit"}">${positive ? "＋ CREDIT" : "− LICENSE DEBIT"}</span></td><td class="${positive ? "amount-positive" : "amount-negative"}">${positive ? "+" : "−"}${money(Math.abs(t.amount))}</td><td>${date(t.created_at)}</td></tr>`;
}
function emptyRow(cols, text) { return `<tr><td colspan="${cols}" class="empty-row"><span>◌</span>${text}</td></tr>`; }
async function loadKeys() {
  try {
    const rows = await api("/api/keys?q=" + encodeURIComponent($("search")?.value || ""));
    $("keysBody").innerHTML = rows.length ? rows.map(k => `<tr><td class="mono key-cell">${esc(k.license_key)}<small>${esc(k.owner || "Unassigned")}</small></td><td>${esc(k.game)}</td><td><b>${esc(k.duration)}</b><small>${k.price_paid ? money(k.price_paid) : "Admin issued"}</small></td><td>${k.expires_at ? date(k.expires_at) : '<span class="lifetime">LIFETIME</span>'}</td><td><span class="status-pill ${k.status.toLowerCase()}"><i></i>${k.status}</span></td><td>${k.devices_used}/${k.max_devices}</td><td class="actions"><button class="icon-button" title="Toggle block" onclick="toggleKey(${k.id},'${k.status === "BLOCKED" ? "UNUSED" : "BLOCKED"}')">${k.status === "BLOCKED" ? "↗" : "⊘"}</button><button class="icon-button danger-icon" title="Delete key" onclick="delKey(${k.id})">⌫</button></td></tr>`).join("") : emptyRow(7, "No licenses match your search");
  } catch (e) { toast(e.message, "error"); }
}
async function loadPlans() { plans = await api("/api/plans"); }
async function loadCreate() {
  try { await loadPlans(); renderPlans(); updatePurchaseSummary(); } catch (e) { toast(e.message, "error"); }
}
function renderPlans() {
  $("planCards").innerHTML = plans.filter(p => p.active).map((p, i) => `<button type="button" class="plan-card ${i === 0 ? "selected" : ""}" data-duration="${esc(p.duration)}" onclick="selectPlan('${esc(p.duration)}')"><span>${p.duration}</span><strong>${money(p.price)}</strong><small>per license / key</small></button>`).join("");
}
function selectPlan(duration) {
  document.querySelectorAll(".plan-card").forEach(x => x.classList.toggle("selected", x.dataset.duration === duration));
  updatePurchaseSummary();
}
function selectedPlan() { return plans.find(p => p.duration === document.querySelector(".plan-card.selected")?.dataset.duration); }
function updatePurchaseSummary() {
  const p = selectedPlan(), quantity = Math.max(1, Number($("quantity")?.value || 1)), admin = me?.role === "admin";
  if (!p) return;
  const unit = admin ? 0 : p.price, total = unit * quantity;
  $("purchasePlan").innerHTML = `<span class="summary-icon">✦</span><div><b>${esc(p.duration)}</b><small>${admin ? "Admin-issued license" : "Current reseller price"}</small></div>`;
  $("unitPrice").textContent = admin ? "No charge" : money(unit);
  $("summaryQuantity").textContent = quantity;
  $("totalPrice").textContent = admin ? "No charge" : money(total);
  $("currentBalance").textContent = admin ? "Admin account" : (me.balance !== undefined ? money(me.balance) : "Loading…");
  const balance = Number(me.balance || 0);
  $("afterBalance").textContent = admin ? "—" : money(balance - total);
  $("purchaseHint").textContent = admin ? "Admin-created keys are issued without a wallet deduction." : (balance < total ? "Insufficient balance — add funds before generating." : "Price is verified on the server before purchase.");
  $("purchaseHint").className = `muted small-copy ${!admin && balance < total ? "warning-text" : ""}`;
  $("selectedPlanNote").innerHTML = `<span>✓</span> ${esc(p.duration)} selected · ${money(p.price)} per key`;
}
async function createKey() {
  const button = document.querySelector("#create .button.primary");
  const p = selectedPlan(), quantity = Number($("quantity").value);
  if (!p) return toast("Choose a license duration", "error");
  setLoading(button, true);
  try {
    const d = await api("/api/keys", {method:"POST",body:JSON.stringify({game:$("game").value,duration:p.duration,quantity,maxDevices:Number($("devices").value)})});
    $("newKey").classList.remove("hidden");
    $("newKey").innerHTML = `<b>${d.keys.length} license${d.keys.length === 1 ? "" : "s"} generated</b><span>${d.keys.map(k => esc(k.key)).join("<br>")}</span>`;
    if (me.role === "reseller") me.balance = d.balanceAfter;
    toast(`${d.keys.length} license${d.keys.length === 1 ? "" : "s"} generated successfully`);
    updatePurchaseSummary();
    loadKeys();
  } catch (e) { toast(e.message, "error"); }
  finally { setLoading(button, false); }
}
async function toggleKey(id, status) { try { await api(`/api/keys/${id}`, {method:"PATCH",body:JSON.stringify({status})}); toast(`License ${status === "BLOCKED" ? "blocked" : "unblocked"}`); loadKeys(); } catch(e) { toast(e.message,"error"); } }
async function delKey(id) { if (!confirm("Delete this license permanently?")) return; try { await api(`/api/keys/${id}`,{method:"DELETE"}); toast("License deleted"); loadKeys(); } catch(e) { toast(e.message,"error"); } }
async function loadUsers() {
  if (me.role !== "admin") return;
  try { users = await api("/api/users"); renderUsers(); const credits = users.reduce((n,u)=>n+Number(u.total_credits||0),0), debits = users.reduce((n,u)=>n+Number(u.total_debits||0),0); $("resellerOverview").innerHTML = `<div class="mini-stat"><span>Active resellers</span><b>${users.filter(u=>u.role==="reseller"&&u.active).length}</b></div><div class="mini-stat"><span>Total credited</span><b>${money(credits)}</b></div><div class="mini-stat"><span>License deductions</span><b>${money(debits)}</b></div>`; } catch(e) { toast(e.message,"error"); }
}
function renderUsers() {
  const q = ($("resellerSearch")?.value || "").toLowerCase();
  const rows = users.filter(u => u.role === "reseller" && (!q || u.username.toLowerCase().includes(q)));
  $("usersBody").innerHTML = rows.length ? rows.map(u => `<tr><td><div class="person-cell"><span class="avatar">${esc(u.username[0]).toUpperCase()}</span><div><b>${esc(u.username)}</b><small>Joined ${date(u.created_at).split(",")[0]}</small></div></div></td><td><span class="status-pill ${u.active ? "active" : "blocked"}"><i></i>${u.active ? "ACTIVE" : "BLOCKED"}</span></td><td class="balance-cell">${money(u.balance)}</td><td>${money(u.total_credits)}</td><td>${money(u.total_debits)}</td><td class="actions"><button class="button small-button credit-button" onclick="openCredit(${u.id},'${esc(u.username)}')">＋ Add balance</button><button class="icon-button" onclick="userActive(${u.id},${u.active ? 0 : 1})">${u.active ? "⊘" : "✓"}</button></td></tr>`).join("") : emptyRow(6,"No resellers found");
}
async function createUser() {
  try { const d = await api("/api/users",{method:"POST",body:JSON.stringify({username:$("nu").value.trim(),password:$("np").value,days:$("nd").value||null})}); closeModal("createUserModal"); $("nu").value=$("np").value=$("nd").value=""; toast(`Reseller ${d.referral_code} created`); loadUsers(); } catch(e) { toast(e.message,"error"); }
}
async function userActive(id, active) { try { await api(`/api/users/${id}`,{method:"PATCH",body:JSON.stringify({active})}); toast(active ? "Reseller activated" : "Reseller blocked"); loadUsers(); } catch(e) { toast(e.message,"error"); } }
async function loadPricing() { try { await loadPlans(); $("pricingGrid").innerHTML = plans.map(p => `<div class="pricing-card"><div class="pricing-card-top"><span class="plan-symbol">✦</span><span class="status-pill ${p.active ? "active" : "blocked"}"><i></i>${p.active ? "ACTIVE" : "INACTIVE"}</span></div><h3>${esc(p.duration)}</h3><label>Price per license</label><div class="price-input"><span>₹</span><input type="number" min="0" id="price-${p.id}" value="${p.price}"></div><small class="muted">Future purchases only</small><button class="button ghost wide" onclick="savePrice(${p.id})">Save price <span>→</span></button></div>`).join(""); } catch(e) { toast(e.message,"error"); } }
async function savePrice(id) { const input = $(`price-${id}`); try { await api(`/api/plans/${id}`,{method:"PATCH",body:JSON.stringify({price:Number(input.value)})}); toast("Pricing updated for future purchases"); loadPricing(); } catch(e) { toast(e.message,"error"); } }
async function openCredit(id, username) { selectedUserId=id; $("creditUserName").textContent=username; $("creditAmount").value=""; openModal("creditModal"); }
async function confirmCredit() { const amount=Number($("creditAmount").value); if (!amount) return toast("Enter a credit amount","error"); try { const d=await api(`/api/users/${selectedUserId}/balance`,{method:"POST",body:JSON.stringify({amount,description:$("creditDescription").value})}); closeModal("creditModal"); toast(`${money(amount)} added to ${d.username}`); loadUsers(); } catch(e) { toast(e.message,"error"); } }
async function loadTransactions() { try { const rows=await api("/api/transactions"); $("transactionsBody").innerHTML=rows.length?rows.map(t=>`<tr><td class="mono">${esc(t.transaction_id)}</td><td>${esc(t.username||"—")}</td><td><span class="type-pill ${t.type==="CREDIT"?"credit":"debit"}">${t.type==="CREDIT"?"＋ CREDIT":"− LICENSE DEBIT"}</span></td><td class="${t.amount>0?"amount-positive":"amount-negative"}">${t.amount>0?"+":"−"}${money(Math.abs(t.amount))}</td><td>${money(t.balance_before)} → ${money(t.balance_after)}</td><td>${esc(t.description)}</td><td>${date(t.created_at)}</td></tr>`).join(""):emptyRow(7,"No transactions yet"); } catch(e) { toast(e.message,"error"); } }
async function loadRefs() { try { const rows=await api("/api/referrals"); $("myRef").textContent=me?.username==="admin"?"RNTXADMIN":"Your reseller referral code is shown in Manage Users"; $("refBody").innerHTML=rows.length?rows.map(x=>`<div class="ref-row"><span class="avatar">${esc(x.username[0]).toUpperCase()}</span><div><b>${esc(x.username)}</b><small>${esc(x.referral_code)}</small></div><span class="status-pill ${x.active?"active":"blocked"}"><i></i>${x.active?"ACTIVE":"BLOCKED"}</span></div>`).join(""):'<div class="empty-state">No referred users yet.</div>'; } catch(e) { toast(e.message,"error"); } }
function openModal(id) { $(id).classList.remove("hidden"); setTimeout(() => $(id).classList.add("open"), 10); }
function closeModal(id) { $(id).classList.remove("open"); setTimeout(() => $(id).classList.add("hidden"), 180); }
document.addEventListener("click", e => { if (e.target.classList.contains("modal")) closeModal(e.target.id); });
boot();