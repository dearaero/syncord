import type {Catalog, Locale, PluralMessage} from './core';
const units = ['messages','events','words','characters','badges','notes','conversations','servers','dms','minutes','hours','days','files','plugins'] as const;
// One/few/many/other forms are explicit: appending English suffixes is invalid
// for Slavic languages, and numeric nouns stay singular in Turkish/Persian.
const nouns: Record<Locale, readonly string[]> = {
 'en-US':['message|messages','event|events','word|words','character|characters','badge|badges','note|notes','conversation|conversations','server|servers','DM|DMs','minute|minutes','hour|hours','day|days','file|files'],
 'es-ES':['mensaje|mensajes','evento|eventos','palabra|palabras','carácter|caracteres','insignia|insignias','nota|notas','conversación|conversaciones','servidor|servidores','MD|MD','minuto|minutos','hora|horas','día|días','archivo|archivos'],
 de:['Nachricht|Nachrichten','Ereignis|Ereignisse','Wort|Wörter','Zeichen|Zeichen','Abzeichen|Abzeichen','Notiz|Notizen','Gespräch|Gespräche','Server|Server','DM|DMs','Minute|Minuten','Stunde|Stunden','Tag|Tage','Datei|Dateien'],
 fr:['message|messages','événement|événements','mot|mots','caractère|caractères','badge|badges','note|notes','conversation|conversations','serveur|serveurs','MP|MP','minute|minutes','heure|heures','jour|jours','fichier|fichiers'],
 'pt-BR':['mensagem|mensagens','evento|eventos','palavra|palavras','caractere|caracteres','insígnia|insígnias','nota|notas','conversa|conversas','servidor|servidores','MD|MD','minuto|minutos','hora|horas','dia|dias','arquivo|arquivos'],
 it:['messaggio|messaggi','evento|eventi','parola|parole','carattere|caratteri','distintivo|distintivi','nota|note','conversazione|conversazioni','server|server','MD|MD','minuto|minuti','ora|ore','giorno|giorni','file|file'],
 nl:['bericht|berichten','gebeurtenis|gebeurtenissen','woord|woorden','teken|tekens','badge|badges','notitie|notities','gesprek|gesprekken','server|servers',"DM|DM's",'minuut|minuten','uur|uur','dag|dagen','bestand|bestanden'],
 ru:['сообщение|сообщения|сообщений|сообщения','событие|события|событий|события','слово|слова|слов|слова','символ|символа|символов|символа','значок|значка|значков|значка','заметка|заметки|заметок|заметки','разговор|разговора|разговоров|разговора','сервер|сервера|серверов|сервера','личное сообщение|личных сообщения|личных сообщений|личного сообщения','минута|минуты|минут|минуты','час|часа|часов|часа','день|дня|дней|дня','файл|файла|файлов|файла'],
 pl:['wiadomość|wiadomości|wiadomości|wiadomości','zdarzenie|zdarzenia|zdarzeń|zdarzenia','słowo|słowa|słów|słowa','znak|znaki|znaków|znaku','odznaka|odznaki|odznak|odznaki','notatka|notatki|notatek|notatki','rozmowa|rozmowy|rozmów|rozmowy','serwer|serwery|serwerów|serwera','wiadomość prywatna|wiadomości prywatne|wiadomości prywatnych|wiadomości prywatnej','minuta|minuty|minut|minuty','godzina|godziny|godzin|godziny','dzień|dni|dni|dnia','plik|pliki|plików|pliku'],
 uk:['повідомлення|повідомлення|повідомлень|повідомлення','подія|події|подій|події','слово|слова|слів|слова','символ|символи|символів|символу','значок|значки|значків|значка','нотатка|нотатки|нотаток|нотатки','розмова|розмови|розмов|розмови','сервер|сервери|серверів|сервера','приватне повідомлення|приватні повідомлення|приватних повідомлень|приватного повідомлення','хвилина|хвилини|хвилин|хвилини','година|години|годин|години','день|дні|днів|дня','файл|файли|файлів|файла'],
 cs:['zpráva|zprávy|zprávy|zpráv','událost|události|události|událostí','slovo|slova|slova|slov','znak|znaky|znaku|znaků','odznak|odznaky|odznaku|odznaků','poznámka|poznámky|poznámky|poznámek','konverzace|konverzace|konverzace|konverzací','server|servery|serveru|serverů','soukromá zpráva|soukromé zprávy|soukromé zprávy|soukromých zpráv','minuta|minuty|minuty|minut','hodina|hodiny|hodiny|hodin','den|dny|dne|dní','soubor|soubory|souboru|souborů'],
 tr:['mesaj','olay','kelime','karakter','rozet','not','konuşma','sunucu','DM','dakika','saat','gün','dosya'],
 id:['pesan','kejadian','kata','karakter','lencana','catatan','percakapan','server','DM','menit','jam','hari','file'],
 fa:['پیام','رویداد','واژه','نویسه','نشان','یادداشت','گفت‌وگو','سرور','پیام خصوصی','دقیقه','ساعت','روز','پرونده'],
 vi:['tin nhắn','sự kiện','từ','ký tự','huy hiệu','ghi chú','cuộc trò chuyện','máy chủ','tin nhắn trực tiếp','phút','giờ','ngày','tệp'],
 ja:['{count}件のメッセージ','{count}件のイベント','{count}語','{count}文字','{count}個のバッジ','{count}件のノート','{count}件の会話','{count}個のサーバー','{count}件のDM','{count}分','{count}時間','{count}日','{count}個のファイル'],
 'zh-CN':['{count}条消息','{count}个事件','{count}个词','{count}个字符','{count}枚徽章','{count}篇笔记','{count}个会话','{count}个服务器','{count}条私信','{count}分钟','{count}小时','{count}天','{count}个文件'],
 ko:['{count}개의 메시지','{count}개의 이벤트','{count}단어','{count}자','{count}개의 배지','{count}개의 노트','{count}개의 대화','{count}개의 서버','{count}개의 DM','{count}분','{count}시간','{count}일','{count}개의 파일'],
};
const pluginNouns: Record<Locale,string>={'en-US':'plugin|plugins','es-ES':'complemento|complementos',de:'Plugin|Plugins',fr:'plugin|plugins','pt-BR':'plugin|plugins',it:'plugin|plugin',nl:'plugin|plug-ins',ru:'плагин|плагина|плагинов|плагина',pl:'wtyczka|wtyczki|wtyczek|wtyczki',uk:'плагін|плагіни|плагінів|плагіна',cs:'plugin|pluginy|pluginu|pluginů',tr:'eklenti',id:'plugin',fa:'افزونه',vi:'tiện ích',ja:'{count}個のプラグイン','zh-CN':'{count}个插件',ko:'{count}개의 플러그인'};
const relationshipForms: Record<Locale,readonly [PluralMessage,PluralMessage]> = {
  "en-US": [
    {
      "one": "{count} relationship change was detected after reconnecting.",
      "other": "{count} relationship changes were detected after reconnecting."
    },
    {
      "one": "{count} additional change.",
      "other": "{count} additional changes."
    }
  ],
  "es-ES": [
    {
      "one": "Se detectó {count} cambio en las relaciones al volver a conectar.",
      "other": "Se detectaron {count} cambios en las relaciones al volver a conectar."
    },
    {
      "one": "{count} cambio adicional.",
      "other": "{count} cambios adicionales."
    }
  ],
  "de": [
    {
      "one": "Nach dem Wiederverbinden wurde {count} Beziehungsänderung erkannt.",
      "other": "Nach dem Wiederverbinden wurden {count} Beziehungsänderungen erkannt."
    },
    {
      "one": "{count} weitere Änderung.",
      "other": "{count} weitere Änderungen."
    }
  ],
  "ja": [
    {
      "one": "再接続後、関係の変更が{count}件見つかりました。",
      "other": "再接続後、関係の変更が{count}件見つかりました。"
    },
    {
      "one": "ほかに{count}件の変更があります。",
      "other": "ほかに{count}件の変更があります。"
    }
  ],
  "fr": [
    {
      "one": "{count} changement de relation a été détecté après la reconnexion.",
      "other": "{count} changements de relations ont été détectés après la reconnexion."
    },
    {
      "one": "{count} changement supplémentaire.",
      "other": "{count} changements supplémentaires."
    }
  ],
  "pt-BR": [
    {
      "one": "Foi detectada {count} alteração nas relações após a reconexão.",
      "other": "Foram detectadas {count} alterações nas relações após a reconexão."
    },
    {
      "one": "{count} alteração adicional.",
      "other": "{count} alterações adicionais."
    }
  ],
  "ru": [
    {
      "one": "После подключения обнаружено {count} изменение в отношениях.",
      "few": "После подключения обнаружено {count} изменения в отношениях.",
      "many": "После подключения обнаружено {count} изменений в отношениях.",
      "other": "После подключения обнаружено {count} изменения в отношениях."
    },
    {
      "one": "Ещё {count} изменение.",
      "few": "Ещё {count} изменения.",
      "many": "Ещё {count} изменений.",
      "other": "Ещё {count} изменения."
    }
  ],
  "it": [
    {
      "one": "È stata rilevata {count} modifica alle relazioni dopo la riconnessione.",
      "other": "Sono state rilevate {count} modifiche alle relazioni dopo la riconnessione."
    },
    {
      "one": "{count} altra modifica.",
      "other": "{count} altre modifiche."
    }
  ],
  "nl": [
    {
      "one": "Na het opnieuw verbinden is {count} wijziging in relaties gevonden.",
      "other": "Na het opnieuw verbinden zijn {count} wijzigingen in relaties gevonden."
    },
    {
      "one": "{count} extra wijziging.",
      "other": "{count} extra wijzigingen."
    }
  ],
  "pl": [
    {
      "one": "Po ponownym połączeniu wykryto {count} zmianę w relacjach.",
      "few": "Po ponownym połączeniu wykryto {count} zmiany w relacjach.",
      "many": "Po ponownym połączeniu wykryto {count} zmian w relacjach.",
      "other": "Po ponownym połączeniu wykryto {count} zmiany w relacjach."
    },
    {
      "one": "Jeszcze {count} zmiana.",
      "few": "Jeszcze {count} zmiany.",
      "many": "Jeszcze {count} zmian.",
      "other": "Jeszcze {count} zmiany."
    }
  ],
  "tr": [
    {
      "one": "Yeniden bağlanıldığında {count} ilişki değişikliği algılandı.",
      "other": "Yeniden bağlanıldığında {count} ilişki değişikliği algılandı."
    },
    {
      "one": "{count} ek değişiklik.",
      "other": "{count} ek değişiklik."
    }
  ],
  "zh-CN": [
    {
      "one": "重新连接后检测到{count}项关系变更。",
      "other": "重新连接后检测到{count}项关系变更。"
    },
    {
      "one": "还有{count}项变更。",
      "other": "还有{count}项变更。"
    }
  ],
  "id": [
    {
      "one": "{count} perubahan hubungan terdeteksi setelah tersambung kembali.",
      "other": "{count} perubahan hubungan terdeteksi setelah tersambung kembali."
    },
    {
      "one": "{count} perubahan tambahan.",
      "other": "{count} perubahan tambahan."
    }
  ],
  "fa": [
    {
      "one": "پس از اتصال دوباره، {count} تغییر در ارتباط‌ها شناسایی شد.",
      "other": "پس از اتصال دوباره، {count} تغییر در ارتباط‌ها شناسایی شد."
    },
    {
      "one": "{count} تغییر دیگر.",
      "other": "{count} تغییر دیگر."
    }
  ],
  "cs": [
    {
      "one": "Po opětovném připojení byla zjištěna {count} změna vztahů.",
      "few": "Po opětovném připojení byly zjištěny {count} změny vztahů.",
      "many": "Po opětovném připojení bylo zjištěno {count} změny vztahů.",
      "other": "Po opětovném připojení bylo zjištěno {count} změn vztahů."
    },
    {
      "one": "Ještě {count} změna.",
      "few": "Ještě {count} změny.",
      "many": "Ještě {count} změny.",
      "other": "Ještě {count} změn."
    }
  ],
  "vi": [
    {
      "one": "Đã phát hiện {count} thay đổi về mối quan hệ sau khi kết nối lại.",
      "other": "Đã phát hiện {count} thay đổi về mối quan hệ sau khi kết nối lại."
    },
    {
      "one": "Còn {count} thay đổi khác.",
      "other": "Còn {count} thay đổi khác."
    }
  ],
  "ko": [
    {
      "one": "다시 연결한 후 관계 변경 {count}건이 감지되었습니다.",
      "other": "다시 연결한 후 관계 변경 {count}건이 감지되었습니다."
    },
    {
      "one": "추가 변경 {count}건이 있습니다.",
      "other": "추가 변경 {count}건이 있습니다."
    }
  ],
  "uk": [
    {
      "one": "Після повторного підключення виявлено {count} зміну у зв’язках.",
      "few": "Після повторного підключення виявлено {count} зміни у зв’язках.",
      "many": "Після повторного підключення виявлено {count} змін у зв’язках.",
      "other": "Після повторного підключення виявлено {count} зміни у зв’язках."
    },
    {
      "one": "Ще {count} зміна.",
      "few": "Ще {count} зміни.",
      "many": "Ще {count} змін.",
      "other": "Ще {count} зміни."
    }
  ]
};
const otherEvents:Record<Locale,PluralMessage>={
 'en-US':{one:'{count} other event',other:'{count} other events'},
 'es-ES':{one:'{count} evento más',other:'{count} eventos más'},
 de:{one:'{count} weiteres Ereignis',other:'{count} weitere Ereignisse'},
 ja:{other:'その他{count}件のイベント'},fr:{one:'{count} autre événement',other:'{count} autres événements'},
 'pt-BR':{one:'{count} outro evento',other:'{count} outros eventos'},
 ru:{one:'ещё {count} событие',few:'ещё {count} события',many:'ещё {count} событий',other:'ещё {count} события'},
 it:{one:'{count} altro evento',other:'{count} altri eventi'},nl:{one:'{count} andere gebeurtenis',other:'{count} andere gebeurtenissen'},
 pl:{one:'{count} inne zdarzenie',few:'{count} inne zdarzenia',many:'{count} innych zdarzeń',other:'{count} innego zdarzenia'},
 tr:{other:'{count} diğer olay'},'zh-CN':{other:'其他{count}个事件'},id:{other:'{count} peristiwa lainnya'},fa:{other:'{count} رویداد دیگر'},
 cs:{one:'{count} další událost',few:'{count} další události',many:'{count} další události',other:'{count} dalších událostí'},
 vi:{other:'{count} sự kiện khác'},ko:{other:'그 외 이벤트 {count}개'},
 uk:{one:'ще {count} подія',few:'ще {count} події',many:'ще {count} подій',other:'ще {count} події'},
};
export function pluralCatalog(locale: Locale): Catalog {
 const result: Record<string,PluralMessage> = {};
 units.forEach((unit,index) => {
  const forms = (unit==='plugins'?pluginNouns[locale]:(nouns[locale][index] ?? nouns['en-US'][index]!)).split('|');
  const render = (noun: string): string => noun.includes('{count}') ? noun : '{count} '+noun;
  result['count.'+unit] = forms.length === 4
   ? {one:render(forms[0]!),few:render(forms[1]!),many:render(forms[2]!),other:render(forms[3]!)}
   : {one:render(forms[0]!),other:render(forms[1] ?? forms[0]!)};
 });
 result['count.other_events']=otherEvents[locale];
 result['relationship.offline_changes']=relationshipForms[locale][0];
 result['relationship.additional_changes']=relationshipForms[locale][1];
 return result;
}
