import type {Catalog,Locale} from './core';
const keys=['heading','always','always_desc','options'] as const;
const messages:Record<Locale,readonly string[]>={
'en-US':['Reading','Always read','Marks every new message, mention and DM as read the moment it arrives.','Mark All as Read options'],
'es-ES':['Lectura','Siempre leído','Marca como leído cada mensaje, mención y MD nuevo en cuanto llega.','Opciones de Marcar todo como leído'],
de:['Lesen','Immer gelesen','Markiert jede neue Nachricht, Erwähnung und DN sofort beim Eintreffen als gelesen.','Optionen für „Alles als gelesen markieren“'],
ja:['既読','常に既読','新しいメッセージ、メンション、DMを届いた瞬間に既読にします。','すべて既読にするのオプション'],
fr:['Lecture','Toujours lu','Marque comme lu chaque nouveau message, mention et MP dès son arrivée.','Options de Tout marquer comme lu'],
'pt-BR':['Leitura','Sempre lido','Marca como lida cada nova mensagem, menção e DM assim que chega.','Opções de Marcar tudo como lido'],
ru:['Чтение','Всегда прочитано','Отмечает каждое новое сообщение, упоминание и ЛС прочитанным сразу после получения.','Настройки «Отметить всё как прочитанное»'],
it:['Lettura','Sempre letto','Segna come letto ogni nuovo messaggio, menzione e DM appena arriva.','Opzioni di Segna tutto come letto'],
nl:['Lezen','Altijd gelezen','Markeert elk nieuw bericht, elke vermelding en DM direct als gelezen zodra het binnenkomt.','Opties voor Alles als gelezen markeren'],
pl:['Czytanie','Zawsze przeczytane','Oznacza każdą nową wiadomość, wzmiankę i DM jako przeczytane od razu po nadejściu.','Opcje Oznacz wszystko jako przeczytane'],
tr:['Okuma','Her zaman okundu','Yeni gelen her mesajı, etiketi ve DM’i geldiği anda okundu olarak işaretler.','Tümünü okundu olarak işaretle seçenekleri'],
'zh-CN':['已读','始终已读','新消息、提及和私信一到达就标记为已读。','全部标为已读选项'],
id:['Membaca','Selalu dibaca','Menandai setiap pesan, sebutan, dan DM baru sebagai sudah dibaca saat tiba.','Opsi Tandai Semua Sudah Dibaca'],
fa:['خواندن','همیشه خوانده‌شده','هر پیام، اشاره و پیام خصوصی تازه را همان لحظهٔ رسیدن خوانده‌شده علامت می‌زند.','گزینه‌های علامت‌گذاری همه به‌عنوان خوانده‌شده'],
cs:['Čtení','Vždy přečteno','Každou novou zprávu, zmínku a DM označí jako přečtenou hned po doručení.','Možnosti Označit vše jako přečtené'],
vi:['Đọc','Luôn đã đọc','Đánh dấu mọi tin nhắn, lượt nhắc và tin nhắn riêng mới là đã đọc ngay khi đến.','Tùy chọn Đánh dấu tất cả là đã đọc'],
ko:['읽음','항상 읽음','새 메시지, 멘션, DM이 도착하는 즉시 읽음으로 표시합니다.','모두 읽음으로 표시 옵션'],
uk:['Читання','Завжди прочитано','Позначає кожне нове повідомлення, згадку й ОП прочитаним одразу після надходження.','Параметри «Позначити все прочитаним»'],
};
export function markReadCatalog(locale:Locale):Catalog{return Object.fromEntries(keys.map((key,index)=>['markread.'+key,messages[locale][index]]));}
