// ---------- Çevrimdışı Uygulama Kabuğu (App Shell) Önbellekleme ----------
// AMAÇ: Uygulama daha önce hiç açılmamış olsa bile (ör. "Ana Ekrana Ekle"
// yapıldıktan hemen sonra internet kapatılıp uygulama ilk kez açıldığında),
// sayfanın HTML/CSS/JS'i ve çalışması için zorunlu harici script'ler (Firebase
// SDK'ları, Chart.js, Google Fonts) önbellekten servis edilebilsin.
//
// ÖNEMLİ SINIRLAMA: Bir web sayfası, tarayıcıya HİÇBİR ZAMAN internet
// üzerinden bir kez bile yüklenmeden önbellekten açılamaz — bu tarayıcıların
// temel çalışma prensibidir. Yani gerçek "hiç internete girmeden ilk kez
// aç" senaryosu mümkün değil. Ama şu senaryo tam olarak çözülür: kullanıcı
// siteyi bir KEZ online açar (ör. "Ana Ekrana Ekle" sırasında), bu sırada
// service worker kurulur ve aşağıdaki dosyaları önbelleğe alır; kullanıcı
// bundan SONRA — ister hemen ister günler sonra — internetsiz açtığında
// uygulama sorunsuz yüklenir.
//
// Cache sürümünü (CACHE_NAME) her index.html/sw.js güncellemesinde bir artırın
// (v1 -> v2 ...) ki eski önbellek temizlenip yeni dosyalar önbelleğe alınsın.
var CACHE_NAME = "garaj-defteri-shell-v1";

var APP_SHELL_URLS = [
  "/aracim/",
  "/aracim/index.html",
  "/aracim/manifest.json",
  "/aracim/icon-192.png",
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js",
  "https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;700&display=swap"
];

// Tek bir dosyanın önbelleklenmesi başarısız olsa bile (ör. geçici ağ
// hatası ya da CORS izni vermeyen bir kaynak) TÜM kurulumun başarısız
// olmaması için her URL ayrı ayrı, kendi try/catch'i ile önbelleklenir.
// (cache.addAll() kullanılmıyor çünkü o, tek dosya hatasında bile hepsini
// iptal eden "hep ya da hiç" bir API.)
function safePrecache(cache, url) {
  return fetch(url, { cache: "reload" }).then(function (res) {
    if (!res.ok && res.type !== "opaque") throw new Error("HTTP " + res.status);
    return cache.put(url, res);
  }).catch(function () {
    // CORS reddi gibi durumlarda en azından opak bir kopya almayı dene.
    return fetch(url, { mode: "no-cors", cache: "reload" }).then(function (res) {
      return cache.put(url, res);
    }).catch(function (err) {
      console.warn("[SW] Önbelleklenemedi (offline modda bu dosya eksik kalabilir):", url, err);
    });
  });
}


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
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(APP_SHELL_URLS.map(function (url) {
        return safePrecache(cache, url);
      }));
    })
  );
});
self.addEventListener("activate", function (event) {
  event.waitUntil(
    Promise.all([
      clients.claim(),
      caches.keys().then(function (keys) {
        return Promise.all(keys.filter(function (key) {
          return key !== CACHE_NAME;
        }).map(function (key) { return caches.delete(key); }));
      })
    ])
  );
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

// ---------- Çevrimdışı çalışma için fetch stratejisi ----------
// - Firestore/Auth/FCM gibi gerçek zamanlı veri istekleri: SW hiç araya
//   girmez, her zaman doğrudan ağa gider (yoksa online iken bile eski/yanlış
//   veri servis edilebilir; ayrıca Firestore'un kendi offline persistence
//   mekanizması zaten localStorage/IndexedDB üzerinden bunu yönetiyor).
// - Diğer her şey (HTML kabuğu, JS, CSS, fontlar, ikonlar, Chart.js, Firebase
//   SDK dosyaları): "stale-while-revalidate" — önbellekte varsa ANINDA ondan
//   servis edilir (offline dahil çalışır), arka planda ağdan güncel sürüm
//   çekilip bir sonraki açılış için önbellek tazelenir.
var NO_INTERCEPT_HOSTS = [
  "firestore.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "fcmregistrations.googleapis.com",
  "firebaseinstallations.googleapis.com"
];

self.addEventListener('fetch', (event) => {
  var request = event.request;

  // Sadece GET istekleri önbelleklenir/servis edilir; auth/firestore
  // yazma istekleri (POST/PUT vb.) hiç dokunulmadan ağa gider.
  if (request.method !== "GET") return;

  var reqUrl;
  try { reqUrl = new URL(request.url); } catch (e) { return; }

  if (NO_INTERCEPT_HOSTS.indexOf(reqUrl.hostname) !== -1) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(request).then(function (cached) {
        var networkFetch = fetch(request).then(function (response) {
          if (response && (response.ok || response.type === "opaque")) {
            cache.put(request, response.clone());
          }
          return response;
        }).catch(function () {
          // Ağ yok. Zaten önbellek varsa aşağıda o döndürülecek; navigasyon
          // (sayfa açma) isteğiyse ve o URL için önbellek yoksa, uygulama
          // kabuğuna (ana sayfa) düş — böylece hiçbir zaman boş/hata sayfası
          // görünmez.
          if (request.mode === "navigate") {
            return cache.match("/aracim/").then(function (shell) {
              return shell || cache.match("/aracim/index.html");
            });
          }
          return undefined;
        });
        return cached || networkFetch;
      });
    })
  );
});
