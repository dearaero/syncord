import type {Locale} from './core';
const names:Record<Locale,readonly [string,string,string,string]>={
 "en-US":["Long Messages", "Virtual Servers", "Platform Spoofer", "Fake DM"],
 "es-ES":["Mensajes largos", "Servidores virtuales", "Simulación de plataforma", "MD simulados"],
 "de":["Lange Nachrichten", "Virtuelle Server", "Plattform-Simulation", "Simulierte Direktnachrichten"],
 "ja":["長文メッセージ", "仮想サーバー", "プラットフォーム偽装", "模擬DM"],
 "fr":["Messages longs", "Serveurs virtuels", "Simulation de plateforme", "Faux MP"],
 "pt-BR":["Mensagens longas", "Servidores virtuais", "Simulação de plataforma", "DMs simuladas"],
 "ru":["Длинные сообщения", "Виртуальные серверы", "Подмена платформы", "Имитация ЛС"],
 "it":["Messaggi lunghi", "Server virtuali", "Simulazione piattaforma", "Messaggi diretti simulati"],
 "nl":["Lange berichten", "Virtuele servers", "Platformsimulatie", "Gesimuleerde privéberichten"],
 "pl":["Długie wiadomości", "Wirtualne serwery", "Symulacja platformy", "Symulowane wiadomości prywatne"],
 "tr":["Uzun Mesajlar", "Sanal Sunucular", "Platform Taklitçisi", "Sahte DM"],
 "zh-CN":["长消息", "虚拟服务器", "平台伪装", "模拟私信"],
 "id":["Pesan Panjang", "Server Virtual", "Penyamaran Platform", "DM Simulasi"],
 "fa":["پیام‌های طولانی", "سرورهای مجازی", "جعل پلتفرم", "پیام خصوصی شبیه‌سازی‌شده"],
 "cs":["Dlouhé zprávy", "Virtuální servery", "Simulace platformy", "Simulované soukromé zprávy"],
 "vi":["Tin nhắn dài", "Máy chủ ảo", "Giả lập nền tảng", "Tin nhắn riêng mô phỏng"],
 "ko":["긴 메시지", "가상 서버", "플랫폼 위장", "모의 DM"],
 "uk":["Довгі повідомлення", "Віртуальні сервери", "Підміна платформи", "Імітація ПП"],
};
export function pluginNamesCatalog(locale:Locale){
 const [long,virtual,platform,fake]=names[locale];
 return {'long.name':long,'virtual.pluginName':virtual,'ps.name':platform,'fd.name':fake};
}
