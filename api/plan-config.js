/**
 * Garaj Defteri — Plan / Lisans Tanımları
 * Süre, araç/kullanıcı limiti ve modül erişimleri TEK NOKTADAN buradan yönetilir.
 * Fiyat değişse bile kod tarafında sadece bu dosya güncellenir.
 */

const PLANS = {
  free: {
    label: "Ücretsiz",
    days: 30,               // otomatik yenilenir (bkz. activate-free-plan.js)
    maxVehicles: 1,
    maxUsers: 1,
    features: ["expense_tracking", "reminders_basic"]
  },
  standard: {
    label: "Standart",
    days: 365,
    maxVehicles: null,      // null = sınırsız
    maxUsers: 2,
    features: ["expense_tracking", "reminders_full", "pdf_export", "excel_export"]
  },
  fleet: {
    label: "Filo / Kurumsal",
    days: 365,
    maxVehicles: null,      // create-license.js içinde body.maxVehicles ile özelleştirilebilir
    maxUsers: null,
    features: [
      "expense_tracking",
      "reminders_full",
      "pdf_export",
      "excel_export",
      "team_management",
      "priority_support",
      "custom_reports"
    ]
  }
};

function isValidPlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLANS, plan);
}

module.exports = { PLANS, isValidPlan };
