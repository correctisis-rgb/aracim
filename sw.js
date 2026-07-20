// ---------- Push Bildirimleri ----------
// DEĞİŞİKLİK NOTU (bkz. konuşma): Firebase SDK'sını SW içinde push almak
// için ARTIK KULLANMIYORUZ. Önceki sürümde firebase.messaging() başarıyla
// başlatıldığında (firebaseMessagingActive=true) native "push" dinleyicisi
// KAYIT OLMUYORDU ve gösterim tamamen firebase'in kendi iç
// onBackgroundMessage mekanizmasına bırakılıyordu. Bu mekanizma, gelen
// payload kendi beklediği zarf formatıyla tam eşleşmezse (ör. DevTools'tan
// atılan ham test push'ları, ya da bazı SDK sürümlerinde bilinen
// importScripts/format sorunları: https://github.com/firebase/firebase-js-sdk/issues/8409)
// sessizce hiçbir şey yapmıyordu — ve devreye girecek bir yedek de yoktu.
//
// ÇÖZÜM: FCM web push'u zaten standart Push API üzerinden çalışır; firebase
// SDK olmadan da native "push" event'i her zaman tetiklenir. Bu yüzden
// firebase SDK'yı tamamen kaldırdık ve tek, koşulsuz bir native dinleyici
// kullanıyoruz. Bu hem gerçek FCM mesajlarını hem DevTools test push'larını
// güvenilir şekilde yakalar.
self.addEventListener("push", function (event) {
  var payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      payload = { notification: { body: event.data.text() } };
    }
  }
  var n = payload.notification || {};
  var title = n.title || "Garaj Defteri";
  var body = n.body || "Yaklaşan bir işlemin var.";
  var data = payload.data || {};
  var url = data.url || "/aracim/";

  // Sunucu (trigger-reminder) tekil, tarihe bağlı bir işlem için bildirim
  // gönderdiğinde data.actionable="true" ve data.carId/data.fieldKey dolu
  // gelir. Bu durumda bildirime "Evet / Hayır" aksiyon düğmeleri ekliyoruz.
  var actions = [];
  if (data.actionable === "true" && data.carId && data.fieldKey) {
    actions = [
      { action: "appt-yes", title: "✅ Evet, aldım" },
      { action: "appt-no", title: "❌ Hayır" }
    ];
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: "/aracim/icon-192.png",
      badge: "/aracim/icon-192.png",
      data: { url: url, carId: data.carId || null, fieldKey: data.fieldKey || null },
      actions: actions
    })
  );
});

// Bildirimin "Hayır" aksiyonunda, ilgili işlem için doğrudan yönlendirilecek
// harici bir site varsa burada tanımlanır (şimdilik sadece Muayene ->
// TÜVTÜRK). Eşleşme yoksa "Hayır" da uygulamayı açar.
var APPT_EXTERNAL_LINKS = {
  inspectionDate: "https://www.tuvturk.com.tr"
};

// Bildirime (veya bir aksiyon düğmesine) tıklanınca uygulamayı öne getir / aç
self.addEventListener("notificationclick", function (event) {
  var action = event.action;
  var data = event.notification.data || {};
  event.notification.close();

  // "Hayır" ve bu alan için bilinen harici bir site varsa: uygulamayı hiç
  // uğraştırmadan doğrudan o siteyi yeni sekmede aç.
  if (action === "appt-no") {
    var externalUrl = data.fieldKey && APPT_EXTERNAL_LINKS[data.fieldKey];
    if (externalUrl) {
      event.waitUntil(clients.openWindow(externalUrl));
      return;
    }
  }

  // "Evet" ise uygulamayı, ilgili aracın randevu formu otomatik açılacak
  // şekilde bir deep-link ile aç/odakla.
  var targetUrl = data.url || "/aracim/";
  if (action === "appt-yes" && data.carId && data.fieldKey) {
    targetUrl = "/aracim/?openAppt=" + encodeURIComponent(data.carId) + ":" + encodeURIComponent(data.fieldKey);
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var wc = windowClients[i];
        if (wc.url.indexOf("/aracim/") !== -1 && "focus" in wc) {
          if (action === "appt-yes" && "navigate" in wc) {
            return wc.navigate(targetUrl).then(function (navigated) { return navigated.focus(); });
          }
          return wc.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ---------- Mevcut PWA fetch handler (değiştirilmedi) ----------
self.addEventListener('fetch', (event) => {
  // Boş fetch handler - PWA kurulum kriterini karşılamak için yeterlidir.
});
