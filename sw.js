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
// Yeni bir sw.js sürümü yayınlandığında, tarayıcı normalde eski sürüm
// tüm sekmelerde/uygulama örneklerinde tamamen kapanana kadar yenisini
// beklemede tutar. iOS'ta PWA'yı kapatıp açmak bazen bunu tetiklemeyebiliyor.
// skipWaiting + clients.claim ile yeni sürüm kayıt olur olmaz hemen
// devreye girer, böylece bildirimlerdeki değişiklikler (ör. aksiyon
// düğmeleri) bir sonraki uygulama açılışında değil, mümkün olan en kısa
// sürede aktif olur.
self.addEventListener("install", function (event) {
  self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(clients.claim());
});

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
      data: { url: url, carId: data.carId || null, fieldKey: data.fieldKey || null, multiAppt: data.multiAppt || null },
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
//
// ÖNEMLİ (iOS/WebKit sınırlaması): iOS Safari, Web Push bildirimlerinde
// tanımlanan özel "actions" (Evet/Hayır) düğmelerini GÖSTERMİYOR — bu,
// Apple'ın kendi geliştirici forumunda da doğrulanmış, yıllardır çözülmemiş
// bilinen bir WebKit kısıtlaması. iOS'ta bildirime dokunulduğunda event.action
// her zaman boş/undefined gelir (Android/Chrome'da ise seçilen aksiyon gelir).
// Bu yüzden, actionable bir bildirimde "action" tanımsızsa (yani muhtemelen
// iOS'tayız ve kullanıcının Evet/Hayır seçme şansı hiç olmadı), en faydalı
// varsayılanı seçip DOĞRUDAN randevu formunu açıyoruz. "Hayır" isteyen
// kullanıcı, açılan formun içindeki "Randevu istemiyorum" linkinden harici
// siteye gidebilir (bkz. index.html buildQuickApptModal).
self.addEventListener("notificationclick", function (event) {
  var action = event.action;
  var data = event.notification.data || {};
  event.notification.close();

  // "Hayır" ve bu alan için bilinen harici bir site varsa: uygulamayı hiç
  // uğraştırmadan doğrudan o siteyi yeni sekmede aç. (Sadece Android/Chrome
  // gibi actions'ı destekleyen tarayıcılarda event.action "appt-no" olabilir.)
  if (action === "appt-no") {
    var externalUrl = data.fieldKey && APPT_EXTERNAL_LINKS[data.fieldKey];
    if (externalUrl) {
      event.waitUntil(clients.openWindow(externalUrl));
      return;
    }
  }

  // "Evet" ile AYNI davranış: hem gerçek "appt-yes" aksiyonu seçildiğinde
  // (Android/Chrome), hem de hiç aksiyon seçilmeden düz bir dokunma
  // olduğunda (iOS'ta her zaman, çünkü düğmeler hiç gösterilmiyor) —
  // actionable bir bildirimse doğrudan randevu formunu aç.
  var targetUrl = data.url || "/aracim/";
  if ((action === "appt-yes" || !action) && data.carId && data.fieldKey) {
    targetUrl = "/aracim/?openAppt=" + encodeURIComponent(data.carId) + ":" + encodeURIComponent(data.fieldKey);
  } else if (!action && data.multiAppt) {
    // Birden fazla farklı tarihe bağlı işlem aynı bildirimde tetiklendiyse
    // (bu yüzden tek bir carId/fieldKey yok), uygulamayı açıp kullanıcının
    // hangisi için randevu/tarih gireceğini seçebileceği bir liste ekranı
    // göstermesi için tüm listeyi URL'e koyuyoruz.
    targetUrl = "/aracim/?openAppts=" + encodeURIComponent(data.multiAppt);
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var wc = windowClients[i];
        if (wc.url.indexOf("/aracim/") !== -1 && "focus" in wc) {
          if (targetUrl.indexOf("/aracim/?open") !== -1 && "navigate" in wc) {
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
