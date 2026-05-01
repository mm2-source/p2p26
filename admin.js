/* eslint-disable no-console */

// ------------------------------------------------------------
// admin.js — Admin Control Panel
// ------------------------------------------------------------
// Watches: withdrawals (pending), Orders (pending_admin_release),
//          and Orders (completed) for audit/visibility.
// ------------------------------------------------------------

// ---------- Helpers ----------
function shortAddr(a) {
  if (!a) return "—";
  const s = String(a);
  return s.length > 12 ? s.slice(0, 6) + "…" + s.slice(-4) : s;
}
function escapeAttr(s) { return String(s || "").replace(/"/g, "&quot;"); }
function fmtDate(ts) {
  if (!ts) return "—";
  let d;
  if (typeof ts.toDate === "function") d = ts.toDate();
  else if (typeof ts === "number") d = new Date(ts);
  else if (ts.seconds) d = new Date(ts.seconds * 1000);
  else return "—";
  const pad = (n) => (n < 10 ? "0" + n : n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function setBadge(id, count) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(count);
}

// ---------- Modal لعرض إثبات الدفع ----------
window.openProofModal = function (src) {
  const modal = document.getElementById("proofModal");
  const img = document.getElementById("proofModalImg");
  if (!modal || !img || !src) return;
  img.src = src;
  modal.classList.add("show");
};
window.closeProofModal = function () {
  const modal = document.getElementById("proofModal");
  if (modal) modal.classList.remove("show");
};

// ---------- TronLink ----------
async function getUSDTContractAddress() {
  const network = window.tronWeb.fullNode.host;
  if (network.includes("nile")) return "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
  return "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
}

async function checkTronLink() {
  if (!window.tronWeb) {
    alert("من فضلك افتح محفظة TronLink وسجل الدخول أولاً!");
    return false;
  }
  try {
    await window.tronLink.request({ method: "tron_requestAccounts" });
    return true;
  } catch (e) {
    alert("يرجى الموافقة على اتصال المحفظة بالصفحة.");
    return false;
  }
}

// ---------------------------------------------------------
// 1) سحب الأرباح (Withdrawals — pending)
// ---------------------------------------------------------
db.collection("withdrawals")
  .where("status", "==", "pending")
  .onSnapshot((snap) => {
    const body = document.querySelector("#withdrawTable tbody");
    if (!body) return;
    setBadge("withdrawCount", snap.size);
    if (snap.empty) {
      body.innerHTML = `<tr class="empty-row"><td colspan="3">لا توجد طلبات سحب معلقة حالياً</td></tr>`;
      return;
    }
    body.innerHTML = "";
    snap.forEach((doc) => {
      const d = doc.data();
      body.innerHTML += `
        <tr>
          <td class="addr-cell">${d.userAddress}</td>
          <td>${d.amount} USDT</td>
          <td>
            <button class="btn-withdraw"
              onclick="approveWithdraw('${doc.id}', '${escapeAttr(d.userAddress)}', ${d.amount})">
              توقيع وإرسال
            </button>
          </td>
        </tr>`;
    });
  });

async function approveWithdraw(id, address, amount) {
  const isReady = await checkTronLink();
  if (!isReady) return;
  if (!confirm(`هل تريد إرسال ${amount} USDT فعلياً إلى ${address}؟`)) return;
  try {
    const contractAddr = await getUSDTContractAddress();
    const contract = await window.tronWeb.contract().at(contractAddr);
    const decimals = 1e6;
    const tx = await contract.transfer(address, amount * decimals).send();
    if (tx) {
      await db.collection("withdrawals").doc(id).update({
        status: "completed",
        txHash: tx,
        approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      alert("تم التحويل بنجاح!");
    }
  } catch (err) {
    alert("فشلت العملية: " + (err.message || "خطأ في التوقيع"));
  }
}
window.approveWithdraw = approveWithdraw;

// ---------------------------------------------------------
// 2) تحرير العملات اليدوي (Orders pending_admin_release)
// ---------------------------------------------------------
db.collection("Orders")
  .where("status", "==", "pending_admin_release")
  .onSnapshot((snap) => {
    const body = document.querySelector("#releaseTable tbody");
    if (!body) return;
    setBadge("releaseCount", snap.size);
    if (snap.empty) {
      body.innerHTML = `<tr class="empty-row"><td colspan="3">لا توجد طلبات تحت المراجعة حالياً</td></tr>`;
      return;
    }
    body.innerHTML = "";
    snap.forEach((doc) => {
      const order = doc.data();
      const usdtToRelease = order.usdtAmount || order.cryptoAmount || order.quantity || (order.amount / (order.price || 50));
      const totalEGP = order.amount;
      body.innerHTML += `
        <tr>
          <td>${doc.id}</td>
          <td>
            <strong>${Number(usdtToRelease).toFixed(2)} USDT</strong><br>
            <small style="color:gray;">القيمة: ${totalEGP} EGP</small>
          </td>
          <td>
            <button class="btn-release"
              onclick="approveRelease('${doc.id}', '${escapeAttr(order.buyerAddress)}', ${usdtToRelease})">
              تحرير العملات
            </button>
          </td>
        </tr>`;
    });
  });

async function approveRelease(id, buyerAddress, usdtAmount) {
  console.log("%c[ADMIN] بدء التحرير للطلب: " + id, "color:white;background:blue;padding:5px;");
  try {
    const orderRef = db.collection("Orders").doc(id);
    const orderSnap = await orderRef.get();
    const orderData = orderSnap.data();

    let actualSellerUID = null;
    if (String(orderData.adType || "").toLowerCase() === "sell") {
      actualSellerUID = orderData.merchantAddress;
    } else if (String(orderData.adType || "").toLowerCase() === "buy") {
      actualSellerUID = orderData.userAddress || orderData.sellerAddress;
    }
    console.log("🕵️ البائع الحقيقي:", actualSellerUID, "| 💰", usdtAmount);

    if (!confirm(`تحرير ${usdtAmount} USDT للمشتري؟ الخصم سيتم من البائع.`)) return;

    const contractAddr = await getUSDTContractAddress();
    const contract = await window.tronWeb.contract().at(contractAddr);
    const tx = await contract.transfer(buyerAddress, usdtAmount * 1e6).send();

    if (tx) {
      console.log("✅ نجح التحويل على الشبكة:", tx);
      await orderRef.update({
        status: "completed",
        released: true,
        releasedByAdmin: true,
        adminReleaseTxHash: tx,
        releasedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      if (actualSellerUID) {
        await db.collection("users").doc(actualSellerUID).update({
          availableBalance: firebase.firestore.FieldValue.increment(-Number(usdtAmount)),
          usdtBalance: firebase.firestore.FieldValue.increment(-Number(usdtAmount)),
        });
        console.log("📉 تم خصم الرصيد من البائع.");
      } else {
        console.error("❌ sellerAddress غير موجود في الأوردر!");
      }
      alert("تم التحرير والخصم بنجاح.");
    }
  } catch (err) {
    console.error("❌ خطأ فني:", err);
    alert("فشلت العملية، راجع الكنسول.");
  }
}
window.approveRelease = approveRelease;

// ---------------------------------------------------------
// 3) الطلبات المنفّذة (Orders completed) — Audit Trail
// ---------------------------------------------------------
db.collection("Orders")
  .where("status", "==", "completed")
  .onSnapshot((snap) => {
    const body = document.querySelector("#completedTable tbody");
    if (!body) return;
    setBadge("completedCount", snap.size);

    if (snap.empty) {
      body.innerHTML = `<tr class="empty-row"><td colspan="9">لا توجد طلبات منفّذة حتى الآن</td></tr>`;
      return;
    }

    // ترتيب من الأحدث للأقدم حسب releasedAt (مع fallback لـ paymentConfirmedAt ثم timestamp)
    const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    orders.sort((a, b) => {
      const ta = (a.releasedAt?.seconds || a.paymentConfirmedAt?.seconds || a.timestamp?.seconds || 0);
      const tb = (b.releasedAt?.seconds || b.paymentConfirmedAt?.seconds || b.timestamp?.seconds || 0);
      return tb - ta;
    });

    body.innerHTML = orders.map((o) => {
      const releaseTag = o.releasedByAdmin
        ? `<span class="tag tag-admin">يدوي (أدمن)</span>`
        : `<span class="tag tag-auto">تلقائي (بائع)</span>`;

      const proofBtn = o.proofImage
        ? `<button class="btn-view" onclick="openProofModal('${escapeAttr(o.proofImage)}')">عرض</button>`
        : `<span style="color:#aaa;">—</span>`;

      const qty = Number(o.quantity || o.usdtAmount || o.cryptoAmount || 0).toFixed(2);
      const amt = Number(o.amount || 0).toFixed(2);

      return `
        <tr>
          <td title="${o.id}"><code style="font-size:11px;">${o.id.slice(0, 10)}…</code></td>
          <td class="addr-cell" title="${escapeAttr(o.sellerAddress)}">${shortAddr(o.sellerAddress)}</td>
          <td class="addr-cell" title="${escapeAttr(o.buyerAddress)}">${shortAddr(o.buyerAddress)}</td>
          <td><strong>${qty}</strong> USDT</td>
          <td>${amt} ${o.currency || "EGP"}</td>
          <td>${o.paymentMethod || "—"}</td>
          <td style="font-size:12px;">${fmtDate(o.releasedAt || o.paymentConfirmedAt || o.timestamp)}</td>
          <td>${releaseTag}</td>
          <td>${proofBtn}</td>
        </tr>`;
    }).join("");
  });