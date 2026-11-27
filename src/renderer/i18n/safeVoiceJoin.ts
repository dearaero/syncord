import type {Catalog,Locale} from './core';
const keys=['name','description','hint'] as const;
const messages:Record<Locale,readonly [string,string,string]>={
  'en-US':['Safe Voice Join','Server voice channels need a double-click to join, so a stray click never pulls you into voice.','Double-click to join this voice channel'],
  tr:['Güvenli Ses Girişi','Sunucudaki ses kanallarına girmek için çift tıklamak gerekir; yanlışlıkla tıklayıp sese girmezsin.','Bu ses kanalına girmek için çift tıkla'],
  'es-ES':['Unión segura a voz','Los canales de voz del servidor requieren doble clic para unirse, así un clic accidental nunca te mete en voz.','Haz doble clic para unirte a este canal de voz'],
  de:['Sicherer Sprachbeitritt','Server-Sprachkanäle brauchen einen Doppelklick zum Beitreten, damit ein versehentlicher Klick dich nie in den Sprachchat holt.','Doppelklicke, um diesem Sprachkanal beizutreten'],
  ja:['安全なボイス参加','サーバーのボイスチャンネルへの参加にダブルクリックが必要になり、誤クリックで参加することを防ぎます。','ダブルクリックでこのボイスチャンネルに参加'],
  fr:['Connexion vocale sécurisée','Les salons vocaux du serveur demandent un double-clic pour les rejoindre, pour éviter qu’un clic accidentel vous y connecte.','Double-cliquez pour rejoindre ce salon vocal'],
  'pt-BR':['Entrada segura em voz','Canais de voz do servidor exigem clique duplo para entrar, para que um clique acidental nunca coloque você na voz.','Clique duas vezes para entrar neste canal de voz'],
  ru:['Безопасный вход в голос','Для входа в голосовые каналы сервера нужен двойной щелчок, чтобы случайный клик не подключал вас.','Дважды щёлкните, чтобы войти в этот голосовой канал'],
  it:['Accesso vocale sicuro','Per entrare nei canali vocali del server serve un doppio clic, così un clic accidentale non ti fa mai entrare.','Fai doppio clic per entrare in questo canale vocale'],
  nl:['Veilig spraak joinen','Spraakkanalen van servers vereisen een dubbelklik om te joinen, zodat een verkeerde klik je nooit in spraak zet.','Dubbelklik om dit spraakkanaal te joinen'],
  pl:['Bezpieczne dołączanie do głosu','Aby dołączyć do kanału głosowego serwera, trzeba kliknąć dwukrotnie, więc przypadkowe kliknięcie cię nie połączy.','Kliknij dwukrotnie, aby dołączyć do tego kanału głosowego'],
  'zh-CN':['安全加入语音','加入服务器语音频道需要双击，避免误点进入语音。','双击以加入此语音频道'],
  id:['Gabung Suara Aman','Saluran suara server perlu klik dua kali untuk bergabung, jadi klik tak sengaja tidak akan memasukkanmu.','Klik dua kali untuk bergabung ke saluran suara ini'],
  fa:['ورود امن به صدا','برای ورود به کانال‌های صوتی سرور باید دوبار کلیک کنید تا با کلیک اشتباهی وارد نشوید.','برای پیوستن به این کانال صوتی دوبار کلیک کنید'],
  cs:['Bezpečné připojení k hlasu','K hlasovým kanálům serveru se připojíte dvojklikem, takže vás náhodné kliknutí nepřipojí.','Dvojklikem se připojíte k tomuto hlasovému kanálu'],
  vi:['Vào kênh thoại an toàn','Cần nhấp đúp để vào kênh thoại của máy chủ, tránh vô tình nhấp là vào thoại.','Nhấp đúp để vào kênh thoại này'],
  ko:['안전한 음성 참가','서버 음성 채널에 들어가려면 더블 클릭해야 해서 실수로 클릭해도 참가하지 않아요.','이 음성 채널에 참가하려면 더블 클릭하세요'],
  uk:['Безпечний вхід у голос','Щоб увійти в голосовий канал сервера, потрібен подвійний клік, тож випадковий клік вас не підключить.','Двічі клацніть, щоб увійти в цей голосовий канал'],
};
export function safeVoiceCatalog(locale:Locale):Catalog{return Object.fromEntries(keys.map((key,index)=>['safeVoice.'+key,messages[locale][index]]));}
