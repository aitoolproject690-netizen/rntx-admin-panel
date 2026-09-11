// Reseller-only key controls. Admin keeps the existing full controls.
(function(){
  const $id=id=>document.getElementById(id);
  const escHtml=value=>String(value??"").replace(/[&<>\"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));

  window.loadKeys = async function(){
    try {
      const rows = await api("/api/keys?q=" + encodeURIComponent($id("search")?.value || ""));
      $id("keysBody").innerHTML = rows.map(k => {
        const isBlocked = k.status === "BLOCKED";
        const action = me?.role === "admin"
          ? `<button class="small" onclick="toggleKey(${k.id},'${isBlocked ? "UNUSED" : "BLOCKED"}')">${isBlocked ? "UNBLOCK" : "BLOCK"}</button><button class="small danger" onclick="delKey(${k.id})">DELETE</button>`
          : me?.role === "reseller"
            ? `<button class="small" onclick="toggleResellerKey(${k.id},'${isBlocked ? "UNUSED" : "BLOCKED"}')">${isBlocked ? "UNBLOCK" : "BLOCK"}</button>`
            : `<span class="muted-action">VIEW ONLY</span>`;
        return `<tr><td>${escHtml(k.license_key)}</td><td>${escHtml(k.game)}</td><td>${formatDate(k.expires_at)}</td><td><span class="pill">${escHtml(k.status)}</span></td><td>${k.devices_used}/${k.max_devices}</td><td>${action}</td></tr>`;
      }).join("") || "<tr><td colspan=6>No generated keys yet.</td></tr>";
    } catch(e) {
      $id("keysBody").innerHTML = `<tr><td colspan=6>${escHtml(e.message)}</td></tr>`;
    }
  };

  window.toggleResellerKey = async function(id, status){
    if (me?.role !== "reseller") return;
    const action = status === "BLOCKED" ? "block" : "unblock";
    if (!confirm(`Confirm ${action} this license key?`)) return;
    try {
      await api("/api/keys/" + id, {method:"PATCH", body:JSON.stringify({status})});
      await loadKeys();
    } catch(e) {
      alert(e.message);
    }
  };
})();
