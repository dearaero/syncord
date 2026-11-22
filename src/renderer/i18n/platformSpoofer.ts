import {pluginNamesCatalog} from './pluginNames';
import type {Catalog,Locale} from './core';
const keys=['description','risk','limitation','platforms','presence','requiresSession','unsupported','verification','saved','restored','enable','noAccount','unavailable','reported','session','apply','restore','invalid','failed'] as const;
const rows:Record<Locale,string[]>={
'en-US':[
 'Customize your Discord platform presence with supported device identities.',
 'Experimental platform identity changes can put your account at risk. Enabling this plugin never changes your connection automatically.',
 'Platform switching is unavailable in this build. Apply saves choices only; extra platforms require real sessions. VR and Console cannot be activated here.',
 'Select platforms','Current presence','Requires an active session','Unsupported here',
 'Local Discord data is not independent proof of visibility. Verify your profile from another account.',
 'Choices saved. Discord presence was not changed.','Default choices restored. Discord connection was not changed.',
 'Enable the plugin to view reports and save choices.','Wait for Discord to identify your current account.','Discord platform data is unavailable or disconnected.',
 'Reported by Discord','Native session info · verification required','Apply choices','Restore default','Invalid platform selection.','Choices could not be saved. Try again.'
],
tr:[
 'Desteklenen cihaz kimlikleriyle Discord platform görünürlüğünüzü özelleştirin.',
 'Deneysel platform kimliği değişiklikleri hesabınızı riske atabilir. Eklentiyi açmak bağlantınızı otomatik olarak değiştirmez.',
 'Bu sürümde platform değiştirme kullanılamıyor. Uygula yalnızca seçimleri kaydeder; ek platformlar gerçek oturum gerektirir. VR ve Konsol buradan etkinleştirilemez.',
 'Platformları seçin','Mevcut görünürlük','Aktif oturum gerekiyor','Burada desteklenmiyor',
 'Yerel Discord verisi dışarıdan görünürlüğün bağımsız kanıtı değildir. Profilinizi başka bir hesaptan doğrulayın.',
 'Seçimler kaydedildi. Discord görünürlüğü değiştirilmedi.','Varsayılan seçimlere dönüldü. Discord bağlantısı değiştirilmedi.',
 'Raporları görmek ve seçimleri kaydetmek için eklentiyi açın.','Discord’un mevcut hesabınızı belirlemesini bekleyin.','Discord platform verisi kullanılamıyor veya bağlantı kesik.',
 'Discord tarafından bildirilen','Yerel oturum bilgisi · doğrulama gerekli','Seçimleri uygula','Varsayılana dön','Geçersiz platform seçimi.','Seçimler kaydedilemedi. Tekrar deneyin.'
],
'es-ES':[
 'Personaliza tu presencia de plataforma en Discord con identidades compatibles.',
 'Los cambios experimentales de identidad pueden poner tu cuenta en riesgo. Activar el plugin nunca cambia la conexión automáticamente.',
 'Cambiar la plataforma no está disponible en esta versión. Aplicar solo guarda preferencias; otras plataformas requieren sesiones reales. VR y Consola no pueden activarse aquí.',
 'Seleccionar plataformas','Presencia actual','Requiere una sesión activa','No compatible aquí',
 'Los datos locales de Discord no prueban la visibilidad externa. Comprueba tu perfil desde otra cuenta.',
 'Preferencias guardadas. La presencia de Discord no ha cambiado.','Preferencias predeterminadas restauradas. La conexión no ha cambiado.',
 'Activa el plugin para ver los datos y guardar preferencias.','Espera a que Discord identifique tu cuenta actual.','Los datos de plataforma no están disponibles o no hay conexión.',
 'Informado por Discord','Información de sesión nativa · requiere verificación','Aplicar preferencias','Restaurar valores','Selección de plataformas no válida.','No se pudieron guardar las preferencias. Inténtalo de nuevo.'
],
de:[
 'Passe deine Discord-Plattformpräsenz mit unterstützten Geräteidentitäten an.',
 'Experimentelle Identitätsänderungen können dein Konto gefährden. Das Aktivieren ändert die Verbindung niemals automatisch.',
 'Ein Plattformwechsel ist in dieser Version nicht verfügbar. Anwenden speichert nur die Auswahl; weitere Plattformen benötigen echte Sitzungen. VR und Konsole lassen sich hier nicht aktivieren.',
 'Plattformen auswählen','Aktuelle Präsenz','Aktive Sitzung erforderlich','Hier nicht unterstützt',
 'Lokale Discord-Daten sind kein unabhängiger Sichtbarkeitsnachweis. Prüfe dein Profil mit einem anderen Konto.',
 'Auswahl gespeichert. Die Discord-Präsenz wurde nicht geändert.','Standardauswahl wiederhergestellt. Die Verbindung wurde nicht geändert.',
 'Aktiviere das Plugin, um Berichte zu sehen und die Auswahl zu speichern.','Warte, bis Discord dein aktuelles Konto erkennt.','Plattformdaten sind nicht verfügbar oder die Verbindung ist getrennt.',
 'Von Discord gemeldet','Native Sitzungsdaten · Bestätigung erforderlich','Auswahl anwenden','Standard wiederherstellen','Ungültige Plattformauswahl.','Auswahl konnte nicht gespeichert werden. Versuche es erneut.'
],
fr:[
 'Personnalisez votre présence de plateforme Discord avec les identités compatibles.',
 'Les changements expérimentaux d’identité peuvent mettre votre compte en danger. Activer le plugin ne modifie jamais automatiquement la connexion.',
 'Le changement de plateforme est indisponible dans cette version. Appliquer enregistre seulement vos choix ; les autres plateformes exigent de vraies sessions. VR et Console ne peuvent pas être activées ici.',
 'Choisir les plateformes','Présence actuelle','Session active requise','Non pris en charge ici',
 'Les données locales de Discord ne prouvent pas la visibilité externe. Vérifiez votre profil depuis un autre compte.',
 'Choix enregistrés. La présence Discord reste inchangée.','Choix par défaut rétablis. La connexion reste inchangée.',
 'Activez le plugin pour afficher les rapports et enregistrer vos choix.','Attendez que Discord identifie votre compte actuel.','Les données de plateforme sont indisponibles ou déconnectées.',
 'Signalé par Discord','Informations de session native · vérification requise','Appliquer les choix','Rétablir par défaut','Choix de plateforme invalide.','Impossible d’enregistrer les choix. Réessayez.'
],
'pt-BR':[
 'Personalize sua presença de plataforma no Discord com identidades compatíveis.',
 'Mudanças experimentais de identidade podem colocar sua conta em risco. Ativar o plugin nunca altera a conexão automaticamente.',
 'A troca de plataforma não está disponível nesta versão. Aplicar apenas salva escolhas; outras plataformas exigem sessões reais. VR e Console não podem ser ativados aqui.',
 'Selecionar plataformas','Presença atual','Requer sessão ativa','Não suportado aqui',
 'Dados locais do Discord não comprovam a visibilidade externa. Verifique seu perfil usando outra conta.',
 'Escolhas salvas. A presença no Discord não foi alterada.','Escolhas padrão restauradas. A conexão não foi alterada.',
 'Ative o plugin para ver relatórios e salvar escolhas.','Aguarde o Discord identificar sua conta atual.','Dados de plataforma indisponíveis ou conexão interrompida.',
 'Informado pelo Discord','Informações da sessão nativa · verificação necessária','Aplicar escolhas','Restaurar padrão','Seleção de plataforma inválida.','Não foi possível salvar as escolhas. Tente novamente.'
],
it:[
 'Personalizza la presenza della tua piattaforma Discord con identità supportate.',
 'Le modifiche sperimentali all’identità possono mettere a rischio l’account. Attivare il plugin non modifica mai automaticamente la connessione.',
 'Il cambio di piattaforma non è disponibile in questa versione. Applica salva solo le scelte; altre piattaforme richiedono sessioni reali. VR e Console non si possono attivare qui.',
 'Seleziona piattaforme','Presenza attuale','Richiede una sessione attiva','Non supportato qui',
 'I dati locali di Discord non provano la visibilità esterna. Verifica il profilo da un altro account.',
 'Scelte salvate. La presenza Discord non è cambiata.','Scelte predefinite ripristinate. La connessione non è cambiata.',
 'Attiva il plugin per visualizzare i dati e salvare le scelte.','Attendi che Discord identifichi l’account attuale.','Dati di piattaforma non disponibili o connessione interrotta.',
 'Segnalato da Discord','Dati della sessione nativa · verifica richiesta','Applica scelte','Ripristina predefiniti','Selezione di piattaforma non valida.','Impossibile salvare le scelte. Riprova.'
],
nl:[
 'Pas je Discord-platformaanwezigheid aan met ondersteunde apparaatidentiteiten.',
 'Experimentele identiteitswijzigingen kunnen je account in gevaar brengen. Inschakelen wijzigt nooit automatisch je verbinding.',
 'Platformwisseling is in deze versie niet beschikbaar. Toepassen slaat alleen keuzes op; extra platforms vereisen echte sessies. VR en Console zijn hier niet te activeren.',
 'Platforms kiezen','Huidige aanwezigheid','Actieve sessie vereist','Hier niet ondersteund',
 'Lokale Discord-gegevens bewijzen geen zichtbaarheid voor anderen. Controleer je profiel met een ander account.',
 'Keuzes opgeslagen. Discord-aanwezigheid is niet gewijzigd.','Standaardkeuzes hersteld. De verbinding is niet gewijzigd.',
 'Schakel de plugin in om gegevens te bekijken en keuzes op te slaan.','Wacht tot Discord je huidige account herkent.','Platformgegevens zijn niet beschikbaar of de verbinding is verbroken.',
 'Door Discord gemeld','Native sessiegegevens · verificatie vereist','Keuzes toepassen','Standaard herstellen','Ongeldige platformkeuze.','Keuzes konden niet worden opgeslagen. Probeer opnieuw.'
],
pl:[
 'Dostosuj obecność platformy Discord za pomocą obsługiwanych tożsamości urządzeń.',
 'Eksperymentalne zmiany tożsamości mogą narazić konto. Włączenie wtyczki nigdy nie zmienia automatycznie połączenia.',
 'Zmiana platformy jest niedostępna w tej wersji. Zastosuj tylko zapisuje wybór; dodatkowe platformy wymagają prawdziwych sesji. VR i Konsoli nie można tu aktywować.',
 'Wybierz platformy','Bieżąca obecność','Wymaga aktywnej sesji','Tutaj nieobsługiwane',
 'Lokalne dane Discord nie dowodzą widoczności dla innych. Sprawdź profil z innego konta.',
 'Zapisano wybór. Obecność Discord nie została zmieniona.','Przywrócono domyślny wybór. Połączenie nie zostało zmienione.',
 'Włącz wtyczkę, aby zobaczyć dane i zapisać wybór.','Poczekaj, aż Discord rozpozna bieżące konto.','Dane platformy są niedostępne lub połączenie przerwane.',
 'Zgłoszone przez Discord','Dane natywnej sesji · wymagana weryfikacja','Zastosuj wybór','Przywróć domyślne','Nieprawidłowy wybór platformy.','Nie udało się zapisać wyboru. Spróbuj ponownie.'
],
ru:[
 'Настройте платформу присутствия Discord с поддерживаемыми идентификаторами устройств.',
 'Экспериментальная смена идентификатора может поставить аккаунт под угрозу. Включение плагина никогда не меняет соединение автоматически.',
 'Смена платформы недоступна в этой версии. Применение только сохраняет выбор; другие платформы требуют реальных сеансов. VR и консоль здесь не активируются.',
 'Выбрать платформы','Текущее присутствие','Нужен активный сеанс','Здесь не поддерживается',
 'Локальные данные Discord не доказывают видимость для других. Проверьте профиль с другого аккаунта.',
 'Выбор сохранён. Присутствие Discord не изменилось.','Выбор по умолчанию восстановлен. Соединение не изменилось.',
 'Включите плагин для просмотра данных и сохранения выбора.','Дождитесь определения текущего аккаунта Discord.','Данные платформы недоступны или соединение прервано.',
 'Сообщено Discord','Данные родного сеанса · нужна проверка','Применить выбор','Восстановить по умолчанию','Недопустимый выбор платформы.','Не удалось сохранить выбор. Попробуйте снова.'
],
uk:[
 'Налаштуйте платформу присутності Discord із підтримуваними ідентифікаторами пристроїв.',
 'Експериментальна зміна ідентифікатора може наразити акаунт на ризик. Увімкнення плагіна ніколи не змінює з’єднання автоматично.',
 'Зміна платформи недоступна в цій версії. Застосування лише зберігає вибір; інші платформи потребують справжніх сеансів. VR і консоль тут не активуються.',
 'Вибрати платформи','Поточна присутність','Потрібен активний сеанс','Тут не підтримується',
 'Локальні дані Discord не доводять видимості для інших. Перевірте профіль з іншого акаунта.',
 'Вибір збережено. Присутність Discord не змінено.','Типовий вибір відновлено. З’єднання не змінено.',
 'Увімкніть плагін для перегляду даних і збереження вибору.','Зачекайте визначення поточного акаунта Discord.','Дані платформи недоступні або з’єднання перервано.',
 'Повідомлено Discord','Дані рідного сеансу · потрібна перевірка','Застосувати вибір','Відновити типові','Неприпустимий вибір платформи.','Не вдалося зберегти вибір. Спробуйте ще раз.'
],
cs:[
 'Přizpůsobte přítomnost platformy Discord pomocí podporovaných identit zařízení.',
 'Experimentální změny identity mohou ohrozit účet. Zapnutí pluginu nikdy automaticky nemění připojení.',
 'Změna platformy není v této verzi dostupná. Použití jen uloží výběr; další platformy vyžadují skutečné relace. VR ani Konzoli zde nelze aktivovat.',
 'Vybrat platformy','Aktuální přítomnost','Vyžaduje aktivní relaci','Zde nepodporováno',
 'Místní data Discordu nejsou důkazem viditelnosti pro ostatní. Ověřte profil z jiného účtu.',
 'Výběr uložen. Přítomnost Discordu se nezměnila.','Výchozí výběr obnoven. Připojení se nezměnilo.',
 'Zapněte plugin pro zobrazení dat a uložení výběru.','Počkejte, než Discord rozpozná aktuální účet.','Data platformy nejsou dostupná nebo je připojení přerušeno.',
 'Hlášeno Discordem','Údaje nativní relace · nutné ověření','Použít výběr','Obnovit výchozí','Neplatný výběr platformy.','Výběr se nepodařilo uložit. Zkuste to znovu.'
],
ja:[
 '対応するデバイス識別情報でDiscordのプラットフォーム表示を設定します。',
 '実験的な識別情報の変更にはアカウントのリスクがあります。有効化だけで接続が自動変更されることはありません。',
 'このバージョンではプラットフォームを変更できません。適用は選択の保存のみで、追加のプラットフォームには実際のセッションが必要です。VRとコンソールはここから有効化できません。',
 'プラットフォームを選択','現在のプレゼンス','有効なセッションが必要','ここでは未対応',
 'ローカルのDiscordデータだけでは他者からの表示を証明できません。別のアカウントでプロフィールを確認してください。',
 '選択を保存しました。Discordのプレゼンスは変更していません。','既定の選択に戻しました。接続は変更していません。',
 'データの確認と選択の保存にはプラグインを有効にしてください。','Discordが現在のアカウントを認識するまでお待ちください。','プラットフォーム情報が利用できないか、接続が切れています。',
 'Discordによる報告','ネイティブセッション情報・検証が必要','選択を適用','既定に戻す','プラットフォームの選択が無効です。','選択を保存できませんでした。再試行してください。'
],
'zh-CN':[
 '使用受支持的设备身份自定义 Discord 平台状态。',
 '实验性身份更改可能带来账号风险。启用插件绝不会自动更改连接。',
 '此版本不支持切换平台。应用仅保存选择；其他平台需要真实会话。无法在此启用 VR 或主机。',
 '选择平台','当前状态','需要活跃会话','此处不支持',
 '本地 Discord 数据不能独立证明他人看到的状态。请使用其他账号检查你的资料。',
 '已保存选择。未更改 Discord 状态。','已恢复默认选择。未更改连接。',
 '启用插件以查看数据并保存选择。','请等待 Discord 识别当前账号。','平台数据不可用或连接已断开。',
 'Discord 报告','原生会话信息 · 需要验证','应用选择','恢复默认','无效的平台选择。','无法保存选择，请重试。'
],
ko:[
 '지원되는 기기 ID로 Discord 플랫폼 상태를 설정합니다.',
 '실험적인 ID 변경은 계정에 위험을 초래할 수 있습니다. 플러그인을 켜도 연결은 자동 변경되지 않습니다.',
 '이 버전에서는 플랫폼을 변경할 수 없습니다. 적용은 선택 사항만 저장하며 다른 플랫폼은 실제 세션이 필요합니다. 여기서는 VR 및 콘솔을 활성화할 수 없습니다.',
 '플랫폼 선택','현재 상태','활성 세션 필요','여기서는 지원하지 않음',
 '로컬 Discord 데이터만으로는 다른 사람에게 보이는 상태를 증명할 수 없습니다. 다른 계정에서 프로필을 확인하세요.',
 '선택 사항을 저장했습니다. Discord 상태는 변경하지 않았습니다.','기본 선택으로 복원했습니다. 연결은 변경하지 않았습니다.',
 '데이터를 보고 선택 사항을 저장하려면 플러그인을 켜세요.','Discord가 현재 계정을 인식할 때까지 기다리세요.','플랫폼 데이터가 없거나 연결이 끊어졌습니다.',
 'Discord에서 보고됨','네이티브 세션 정보 · 검증 필요','선택 적용','기본값 복원','잘못된 플랫폼 선택입니다.','선택 사항을 저장할 수 없습니다. 다시 시도하세요.'
],
id:[
 'Sesuaikan kehadiran platform Discord dengan identitas perangkat yang didukung.',
 'Perubahan identitas eksperimental dapat membahayakan akun. Mengaktifkan plugin tidak pernah mengubah koneksi secara otomatis.',
 'Pergantian platform tidak tersedia di versi ini. Terapkan hanya menyimpan pilihan; platform tambahan memerlukan sesi nyata. VR dan Konsol tidak dapat diaktifkan di sini.',
 'Pilih platform','Kehadiran saat ini','Memerlukan sesi aktif','Tidak didukung di sini',
 'Data Discord lokal bukan bukti visibilitas yang independen. Periksa profil dari akun lain.',
 'Pilihan tersimpan. Kehadiran Discord tidak diubah.','Pilihan bawaan dipulihkan. Koneksi tidak diubah.',
 'Aktifkan plugin untuk melihat laporan dan menyimpan pilihan.','Tunggu Discord mengenali akun saat ini.','Data platform tidak tersedia atau koneksi terputus.',
 'Dilaporkan Discord','Info sesi bawaan · perlu verifikasi','Terapkan pilihan','Pulihkan bawaan','Pilihan platform tidak valid.','Pilihan tidak dapat disimpan. Coba lagi.'
],
fa:[
 'حضور پلتفرم Discord را با شناسه‌های دستگاه پشتیبانی‌شده تنظیم کنید.',
 'تغییرات آزمایشی شناسه ممکن است حساب را به خطر بیندازد. فعال‌سازی افزونه هرگز اتصال را خودکار تغییر نمی‌دهد.',
 'تغییر پلتفرم در این نسخه در دسترس نیست. اعمال فقط انتخاب‌ها را ذخیره می‌کند؛ پلتفرم‌های دیگر به نشست واقعی نیاز دارند. VR و کنسول اینجا فعال نمی‌شوند.',
 'انتخاب پلتفرم‌ها','حضور فعلی','نیازمند نشست فعال','اینجا پشتیبانی نمی‌شود',
 'دادهٔ محلی Discord مدرک مستقل نمایش برای دیگران نیست. نمایه را از حساب دیگری بررسی کنید.',
 'انتخاب‌ها ذخیره شد. حضور Discord تغییر نکرد.','انتخاب‌های پیش‌فرض بازیابی شد. اتصال تغییر نکرد.',
 'برای مشاهدهٔ داده‌ها و ذخیرهٔ انتخاب‌ها افزونه را فعال کنید.','منتظر شناسایی حساب فعلی توسط Discord بمانید.','دادهٔ پلتفرم در دسترس نیست یا اتصال قطع است.',
 'گزارش‌شده توسط Discord','اطلاعات نشست بومی · نیازمند تأیید','اعمال انتخاب‌ها','بازیابی پیش‌فرض','انتخاب پلتفرم نامعتبر است.','ذخیرهٔ انتخاب‌ها ممکن نشد. دوباره تلاش کنید.'
],
vi:[
 'Tùy chỉnh trạng thái nền tảng Discord bằng danh tính thiết bị được hỗ trợ.',
 'Thay đổi danh tính thử nghiệm có thể gây rủi ro cho tài khoản. Bật tiện ích không bao giờ tự động thay đổi kết nối.',
 'Phiên bản này không hỗ trợ đổi nền tảng. Áp dụng chỉ lưu lựa chọn; nền tảng bổ sung cần phiên thực. Không thể bật VR và Console tại đây.',
 'Chọn nền tảng','Trạng thái hiện tại','Cần phiên đang hoạt động','Không hỗ trợ tại đây',
 'Dữ liệu Discord cục bộ không chứng minh độc lập khả năng hiển thị. Kiểm tra hồ sơ từ tài khoản khác.',
 'Đã lưu lựa chọn. Trạng thái Discord không thay đổi.','Đã khôi phục lựa chọn mặc định. Kết nối không thay đổi.',
 'Bật tiện ích để xem dữ liệu và lưu lựa chọn.','Chờ Discord xác định tài khoản hiện tại.','Dữ liệu nền tảng không khả dụng hoặc đã ngắt kết nối.',
 'Discord báo cáo','Thông tin phiên gốc · cần xác minh','Áp dụng lựa chọn','Khôi phục mặc định','Lựa chọn nền tảng không hợp lệ.','Không lưu được lựa chọn. Vui lòng thử lại.'
]
};
const identityKeys=['identityReady','identityUnavailable','identityArmed','identityPrepared','identityMultiple','identityConsole','identityConnected','identityFailed'] as const;
const updates:Record<Locale,string[]>={
 "en-US": [
  "Apply briefly reconnects Discord to send the selected identity. One connection supports one platform; extra platforms require real sessions.",
  "Choices saved. Check the identity status below.",
  "Experimental · apply with reconnect",
  "Native adapter unavailable. Restart after installing this build; if still unavailable, this client version is unsupported.",
  "Reconnecting Discord for {platform}…",
  "Identify for {platform} handed to Discord. Waiting for the native connection.",
  "One connection can prepare one identity. Multiple platforms require real sessions.",
  "Console identity support is unverified.",
  "Discord reconnected. Verify platform visibility from another account.",
  "Could not apply the platform. Wait 15 seconds before retrying; check your Discord connection."
 ],
 "tr": [
  "Uygula, seçilen kimliği göndermek için Discord bağlantısını kısa süreli yeniler. Tek bağlantıda tek platform kullanılır; ek platformlar gerçek oturum gerektirir.",
  "Seçimler kaydedildi. Aşağıdaki kimlik durumunu kontrol edin.",
  "Deneysel · bağlantı yenilenerek uygulanır",
  "Native adaptör kullanılamıyor. Bu build’i uyguladıktan sonra yeniden başlatın; hâlâ kullanılamıyorsa istemci sürümü desteklenmiyordur.",
  "{platform} için Discord bağlantısı yenileniyor…",
  "{platform} kimliği Discord’a iletildi. Native bağlantı bekleniyor.",
  "Bir bağlantıda tek kimlik hazırlanabilir. Çoklu platform gerçek oturum gerektirir.",
  "Konsol kimliği desteği doğrulanmadı.",
  "Discord yeniden bağlandı. Platform görünürlüğünü başka bir hesaptan doğrulayın.",
  "Platform uygulanamadı. Tekrar denemeden önce 15 saniye bekleyin ve Discord bağlantısını kontrol edin."
 ],
 "es-ES": [
  "Aplicar reconecta Discord brevemente para enviar la identidad elegida. Una conexión admite una plataforma; las demás requieren sesiones reales.",
  "Preferencias guardadas. Comprueba el estado de identidad debajo.",
  "Experimental · aplicar reconectando",
  "Adaptador nativo no disponible. Reinicia tras instalar esta versión; si persiste, el cliente no es compatible.",
  "Reconectando Discord para {platform}…",
  "Identify de {platform} entregado a Discord. Esperando la conexión nativa.",
  "Una conexión prepara una identidad. Varias plataformas requieren sesiones reales.",
  "Compatibilidad de identidad de consola sin verificar.",
  "Discord se ha reconectado. Comprueba la visibilidad desde otra cuenta.",
  "No se pudo aplicar. Espera 15 segundos antes de reintentar y comprueba la conexión."
 ],
 "de": [
  "Anwenden verbindet Discord kurz neu, um die gewählte Identität zu senden. Eine Verbindung unterstützt eine Plattform; weitere benötigen echte Sitzungen.",
  "Auswahl gespeichert. Prüfe unten den Identitätsstatus.",
  "Experimentell · mit Neuverbindung anwenden",
  "Nativer Adapter nicht verfügbar. Nach Installation neu starten; bleibt er nicht verfügbar, wird diese Clientversion nicht unterstützt.",
  "Discord wird für {platform} neu verbunden…",
  "Identify für {platform} an Discord übergeben. Native Verbindung wird erwartet.",
  "Eine Verbindung bereitet eine Identität vor. Mehrere Plattformen erfordern echte Sitzungen.",
  "Konsolenidentität ist nicht verifiziert.",
  "Discord neu verbunden. Sichtbarkeit mit einem anderen Konto prüfen.",
  "Plattform konnte nicht angewendet werden. Vor dem nächsten Versuch 15 Sekunden warten und Verbindung prüfen."
 ],
 "fr": [
  "Appliquer reconnecte brièvement Discord pour envoyer l’identité choisie. Une connexion accepte une plateforme ; les autres exigent de vraies sessions.",
  "Choix enregistrés. Vérifiez l’état de l’identité ci-dessous.",
  "Expérimental · appliquer avec reconnexion",
  "Adaptateur natif indisponible. Redémarrez après installation ; si cela persiste, cette version du client est incompatible.",
  "Reconnexion de Discord pour {platform}…",
  "Identify pour {platform} transmis à Discord. Connexion native en attente.",
  "Une connexion prépare une identité. Plusieurs plateformes exigent de vraies sessions.",
  "Identité de console non vérifiée.",
  "Discord reconnecté. Vérifiez la visibilité depuis un autre compte.",
  "Impossible d’appliquer. Attendez 15 secondes avant de réessayer et vérifiez la connexion."
 ],
 "pt-BR": [
  "Aplicar reconecta o Discord brevemente para enviar a identidade escolhida. Uma conexão aceita uma plataforma; outras exigem sessões reais.",
  "Escolhas salvas. Confira o estado da identidade abaixo.",
  "Experimental · aplicar reconectando",
  "Adaptador nativo indisponível. Reinicie após instalar; se continuar indisponível, esta versão do cliente não é compatível.",
  "Reconectando o Discord para {platform}…",
  "Identify de {platform} entregue ao Discord. Aguardando a conexão nativa.",
  "Uma conexão prepara uma identidade. Várias plataformas exigem sessões reais.",
  "Identidade de console não verificada.",
  "Discord reconectado. Verifique a visibilidade em outra conta.",
  "Não foi possível aplicar. Aguarde 15 segundos antes de tentar novamente e verifique a conexão."
 ],
 "it": [
  "Applica riconnette brevemente Discord per inviare l’identità scelta. Una connessione supporta una piattaforma; le altre richiedono sessioni reali.",
  "Scelte salvate. Controlla lo stato dell’identità qui sotto.",
  "Sperimentale · applica riconnettendo",
  "Adattatore nativo non disponibile. Riavvia dopo l’installazione; se persiste, questa versione del client non è supportata.",
  "Riconnessione di Discord per {platform}…",
  "Identify per {platform} inoltrato a Discord. In attesa della connessione nativa.",
  "Una connessione prepara un’identità. Più piattaforme richiedono sessioni reali.",
  "Identità console non verificata.",
  "Discord riconnesso. Verifica la visibilità da un altro account.",
  "Impossibile applicare. Attendi 15 secondi prima di riprovare e controlla la connessione."
 ],
 "nl": [
  "Toepassen verbindt Discord kort opnieuw om de gekozen identiteit te verzenden. Eén verbinding ondersteunt één platform; extra platforms vereisen echte sessies.",
  "Keuzes opgeslagen. Bekijk hieronder de identiteitsstatus.",
  "Experimenteel · toepassen met opnieuw verbinden",
  "Native adapter niet beschikbaar. Herstart na installatie; blijft dit zo, dan wordt deze clientversie niet ondersteund.",
  "Discord opnieuw verbinden voor {platform}…",
  "Identify voor {platform} doorgegeven aan Discord. Wachten op de verbinding.",
  "Eén verbinding bereidt één identiteit voor. Meerdere platforms vereisen echte sessies.",
  "Console-identiteit is niet geverifieerd.",
  "Discord opnieuw verbonden. Controleer de zichtbaarheid vanuit een ander account.",
  "Toepassen mislukt. Wacht 15 seconden voordat je opnieuw probeert en controleer de verbinding."
 ],
 "pl": [
  "Zastosowanie na krótko łączy Discord ponownie, wysyłając wybraną tożsamość. Jedno połączenie obsługuje jedną platformę; pozostałe wymagają rzeczywistych sesji.",
  "Zapisano wybór. Sprawdź stan tożsamości poniżej.",
  "Eksperymentalne · zastosuj z ponownym połączeniem",
  "Adapter natywny niedostępny. Uruchom ponownie po instalacji; jeśli problem trwa, wersja klienta nie jest obsługiwana.",
  "Ponowne łączenie Discord dla {platform}…",
  "Identify dla {platform} przekazano do Discord. Oczekiwanie na połączenie.",
  "Jedno połączenie przygotowuje jedną tożsamość. Wiele platform wymaga prawdziwych sesji.",
  "Tożsamość konsoli niezweryfikowana.",
  "Discord połączony ponownie. Sprawdź widoczność z innego konta.",
  "Nie udało się zastosować. Odczekaj 15 sekund przed ponowną próbą i sprawdź połączenie."
 ],
 "ru": [
  "Применение ненадолго переподключает Discord для отправки выбранной идентичности. Одно соединение — одна платформа; другие требуют реальных сеансов.",
  "Выбор сохранён. Проверьте состояние идентичности ниже.",
  "Экспериментально · с переподключением",
  "Нативный адаптер недоступен. Перезапустите после установки; если не помогло, версия клиента не поддерживается.",
  "Переподключение Discord для {platform}…",
  "Identify для {platform} передан Discord. Ожидание подключения.",
  "Одно соединение готовит одну идентичность. Нескольким платформам нужны реальные сеансы.",
  "Идентичность консоли не проверена.",
  "Discord переподключён. Проверьте видимость с другого аккаунта.",
  "Не удалось применить. Подождите 15 секунд перед повтором и проверьте соединение."
 ],
 "uk": [
  "Застосування ненадовго перепідключає Discord для надсилання вибраної ідентичності. Одне з’єднання підтримує одну платформу; інші потребують справжніх сеансів.",
  "Вибір збережено. Перевірте стан ідентичності нижче.",
  "Експериментально · з перепідключенням",
  "Нативний адаптер недоступний. Перезапустіть після встановлення; якщо проблема лишається, версія клієнта не підтримується.",
  "Перепідключення Discord для {platform}…",
  "Identify для {platform} передано Discord. Очікування з’єднання.",
  "Одне з’єднання готує одну ідентичність. Кілька платформ потребують справжніх сеансів.",
  "Ідентичність консолі не перевірена.",
  "Discord перепідключено. Перевірте видимість з іншого облікового запису.",
  "Не вдалося застосувати. Зачекайте 15 секунд перед повтором і перевірте з’єднання."
 ],
 "cs": [
  "Použití krátce znovu připojí Discord a odešle vybranou identitu. Jedno připojení podporuje jednu platformu; další vyžadují skutečné relace.",
  "Výběr uložen. Zkontrolujte stav identity níže.",
  "Experimentální · použít s opětovným připojením",
  "Nativní adaptér není dostupný. Po instalaci restartujte; pokud problém trvá, verze klienta není podporována.",
  "Opětovné připojování Discordu pro {platform}…",
  "Identify pro {platform} předáno Discordu. Čekání na připojení.",
  "Jedno připojení připraví jednu identitu. Více platforem potřebuje skutečné relace.",
  "Identita konzole není ověřena.",
  "Discord znovu připojen. Ověřte viditelnost z jiného účtu.",
  "Použití se nezdařilo. Před dalším pokusem počkejte 15 sekund a zkontrolujte připojení."
 ],
 "ja": [
  "適用するとDiscordを短時間再接続して選択した識別情報を送信します。1接続につき1プラットフォームで、追加には実際のセッションが必要です。",
  "選択を保存しました。下の識別情報の状態を確認してください。",
  "実験的 · 再接続して適用",
  "ネイティブアダプターが利用できません。インストール後に再起動し、それでも利用できない場合はクライアントのバージョンが未対応です。",
  "{platform} のためにDiscordを再接続中…",
  "{platform} のIdentifyをDiscordに渡しました。接続を待っています。",
  "1つの接続では1つの識別情報を準備します。複数のプラットフォームには実際のセッションが必要です。",
  "コンソールの識別情報は未検証です。",
  "Discordが再接続しました。別のアカウントで表示を確認してください。",
  "適用できませんでした。15秒待ってから再試行し、Discordの接続を確認してください。"
 ],
 "zh-CN": [
  "应用会短暂重新连接 Discord 以发送所选身份。每个连接仅支持一个平台，其他平台需要真实会话。",
  "已保存选择。请检查下方身份状态。",
  "实验性 · 重新连接后应用",
  "原生适配器不可用。安装后请重启；若仍不可用，则此客户端版本不受支持。",
  "正在为 {platform} 重新连接 Discord…",
  "{platform} 的 Identify 已交给 Discord。正在等待原生连接。",
  "一个连接可准备一种身份。多平台需要真实会话。",
  "主机身份支持尚未验证。",
  "Discord 已重新连接。请从其他账号验证平台显示。",
  "无法应用。请等待 15 秒再重试，并检查 Discord 连接。"
 ],
 "ko": [
  "적용하면 Discord가 잠시 재연결되어 선택한 식별 정보를 전송합니다. 연결 하나는 플랫폼 하나를 지원하며 추가 플랫폼은 실제 세션이 필요합니다.",
  "선택 사항을 저장했습니다. 아래 ID 상태를 확인하세요.",
  "실험적 · 재연결하여 적용",
  "네이티브 어댑터를 사용할 수 없습니다. 설치 후 재시작하세요. 계속 사용할 수 없으면 지원하지 않는 클라이언트 버전입니다.",
  "{platform}용 Discord 재연결 중…",
  "{platform} Identify를 Discord에 전달했습니다. 연결을 기다립니다.",
  "연결 하나는 ID 하나를 준비합니다. 여러 플랫폼은 실제 세션이 필요합니다.",
  "콘솔 ID 지원은 미확인입니다.",
  "Discord가 재연결되었습니다. 다른 계정에서 표시를 확인하세요.",
  "적용하지 못했습니다. 15초 후 다시 시도하고 연결을 확인하세요."
 ],
 "id": [
  "Terapkan menyambungkan ulang Discord sebentar untuk mengirim identitas pilihan. Satu koneksi mendukung satu platform; platform lain memerlukan sesi nyata.",
  "Pilihan tersimpan. Periksa status identitas di bawah.",
  "Eksperimental · terapkan dengan koneksi ulang",
  "Adaptor bawaan tidak tersedia. Mulai ulang setelah pemasangan; jika tetap tidak tersedia, versi klien ini tidak didukung.",
  "Menyambungkan ulang Discord untuk {platform}…",
  "Identify untuk {platform} diteruskan ke Discord. Menunggu koneksi asli.",
  "Satu koneksi menyiapkan satu identitas. Banyak platform memerlukan sesi nyata.",
  "Dukungan identitas konsol belum diverifikasi.",
  "Discord tersambung kembali. Periksa tampilan platform dari akun lain.",
  "Tidak dapat menerapkan. Tunggu 15 detik sebelum mencoba lagi dan periksa koneksi Discord."
 ],
 "fa": [
  "اعمال، Discord را برای ارسال هویت انتخاب‌شده کوتاه‌مدت دوباره متصل می‌کند. هر اتصال یک پلتفرم را پشتیبانی می‌کند؛ بقیه به نشست واقعی نیاز دارند.",
  "انتخاب‌ها ذخیره شد. وضعیت شناسه را در پایین بررسی کنید.",
  "آزمایشی · اعمال با اتصال مجدد",
  "آداپتور بومی در دسترس نیست. پس از نصب دوباره راه‌اندازی کنید؛ اگر مشکل باقی ماند این نسخه پشتیبانی نمی‌شود.",
  "اتصال مجدد Discord برای {platform}…",
  "Identify برای {platform} به Discord تحویل داده شد. در انتظار اتصال اصلی.",
  "هر اتصال یک شناسه آماده می‌کند. چند پلتفرم به نشست‌های واقعی نیاز دارند.",
  "پشتیبانی شناسهٔ کنسول تأیید نشده است.",
  "Discord دوباره متصل شد. نمایش پلتفرم را از حساب دیگری بررسی کنید.",
  "اعمال نشد. پیش از تلاش دوباره ۱۵ ثانیه صبر کنید و اتصال Discord را بررسی کنید."
 ],
 "vi": [
  "Áp dụng sẽ kết nối lại Discord trong chốc lát để gửi danh tính đã chọn. Mỗi kết nối hỗ trợ một nền tảng; nền tảng khác cần phiên thực.",
  "Đã lưu lựa chọn. Kiểm tra trạng thái danh tính bên dưới.",
  "Thử nghiệm · áp dụng bằng kết nối lại",
  "Bộ chuyển đổi gốc không khả dụng. Khởi động lại sau khi cài; nếu vẫn không khả dụng, phiên bản máy khách không được hỗ trợ.",
  "Đang kết nối lại Discord cho {platform}…",
  "Đã chuyển Identify cho {platform} tới Discord. Đang chờ kết nối gốc.",
  "Một kết nối chuẩn bị một danh tính. Nhiều nền tảng cần các phiên thực.",
  "Chưa xác minh hỗ trợ danh tính Console.",
  "Discord đã kết nối lại. Hãy kiểm tra hiển thị từ tài khoản khác.",
  "Không thể áp dụng. Chờ 15 giây trước khi thử lại và kiểm tra kết nối Discord."
 ]
};
export function platformSpooferCatalog(locale:Locale):Catalog{
 const row=[...rows[locale]];row[2]=updates[locale][0];row[8]=updates[locale][1];if(row.length!==keys.length)throw Error('Invalid Platform Spoofer catalog');
 return {'ps.name':pluginNamesCatalog(locale)['ps.name'],...Object.fromEntries(keys.map((key,i)=>['ps.'+key,row[i]])),...Object.fromEntries(identityKeys.map((key,i)=>['ps.'+key,updates[locale][i+2]]))};
}
