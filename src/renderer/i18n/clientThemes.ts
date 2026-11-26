import type {Catalog,Locale} from './core';
const keys=['name','description'] as const;
const messages:Record<Locale,readonly string[]>={
'en-US':['Free Color Themes','Use Discord’s color themes without Nitro. While enabled, your theme is kept on this device instead of being synced.'],
'es-ES':['Temas de color gratis','Usa los temas de color de Discord sin Nitro. Mientras esté activo, el tema se guarda en este dispositivo en lugar de sincronizarse.'],
de:['Kostenlose Farbthemen','Nutze Discords Farbthemen ohne Nitro. Solange aktiv, bleibt dein Design auf diesem Gerät, statt synchronisiert zu werden.'],
ja:['無料カラーテーマ','Nitroなしで Discord のカラーテーマを使えます。有効な間、テーマは同期されずこのデバイスに保存されます。'],
fr:['Thèmes de couleur gratuits','Utilise les thèmes de couleur de Discord sans Nitro. Tant qu’il est actif, ton thème reste sur cet appareil au lieu d’être synchronisé.'],
'pt-BR':['Temas de cor grátis','Use os temas de cor do Discord sem Nitro. Enquanto ativo, seu tema fica neste dispositivo em vez de ser sincronizado.'],
ru:['Бесплатные цветовые темы','Цветовые темы Discord без Nitro. Пока плагин включён, тема хранится на этом устройстве и не синхронизируется.'],
it:['Temi colore gratuiti','Usa i temi colore di Discord senza Nitro. Finché è attivo, il tema resta su questo dispositivo invece di essere sincronizzato.'],
nl:['Gratis kleurthema’s','Gebruik de kleurthema’s van Discord zonder Nitro. Zolang dit aanstaat, blijft je thema op dit apparaat in plaats van gesynchroniseerd te worden.'],
pl:['Darmowe motywy kolorów','Używaj motywów kolorów Discorda bez Nitro. Gdy wtyczka jest włączona, motyw zostaje na tym urządzeniu zamiast być synchronizowany.'],
tr:['Ücretsiz Renk Temaları','Discord’un renk temalarını Nitro olmadan kullan. Açıkken tema senkronize edilmez, bu cihazda saklanır.'],
'zh-CN':['免费颜色主题','无需 Nitro 即可使用 Discord 的颜色主题。启用期间，主题保存在此设备上，不会同步。'],
id:['Tema Warna Gratis','Gunakan tema warna Discord tanpa Nitro. Selama aktif, tema disimpan di perangkat ini dan tidak disinkronkan.'],
fa:['تم‌های رنگی رایگان','از تم‌های رنگی دیسکورد بدون نیترو استفاده کنید. تا وقتی فعال است، تم روی همین دستگاه ذخیره می‌شود و همگام‌سازی نمی‌شود.'],
cs:['Barevné motivy zdarma','Používej barevné motivy Discordu bez Nitra. Dokud je zapnuto, motiv zůstává na tomto zařízení a nesynchronizuje se.'],
vi:['Chủ đề màu miễn phí','Dùng chủ đề màu của Discord mà không cần Nitro. Khi bật, chủ đề được lưu trên thiết bị này thay vì đồng bộ.'],
ko:['무료 색상 테마','Nitro 없이 Discord 색상 테마를 사용합니다. 켜져 있는 동안 테마는 동기화되지 않고 이 기기에 저장됩니다.'],
uk:['Безкоштовні колірні теми','Колірні теми Discord без Nitro. Поки плагін увімкнено, тема зберігається на цьому пристрої й не синхронізується.'],
};
export function clientThemesCatalog(locale:Locale):Catalog{return Object.fromEntries(keys.map((key,index)=>['clientthemes.'+key,messages[locale][index]]));}
