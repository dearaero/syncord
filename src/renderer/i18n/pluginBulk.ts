import type {Locale} from './core';
type Copy=readonly [string,string,string,string,string,string,string,string];
const copy:Record<Locale,Copy>={
 'en-US':['Disable all','Enable all','Restore previous state','Applies to all plugins, including search results hidden from view. The state before the last bulk change is saved.','Updating plugins…','Plugin states updated.','Some plugins could not start or stop. Check their status and security mode.','Could not complete the operation. Check plugin states before retrying.'],
 tr:['Tümünü kapat','Tümünü aç','Önceki durumu geri yükle','Aramada görünmeyenler dahil tüm eklentilere uygulanır. Son toplu değişiklikten önceki durum saklanır.','Eklentiler güncelleniyor…','Eklenti durumları güncellendi.','Bazı eklentiler başlatılamadı veya durdurulamadı. Durumlarını ve güvenlik modunu kontrol edin.','İşlem tamamlanamadı. Tekrar denemeden önce eklenti durumlarını kontrol edin.'],
 'es-ES':['Desactivar todos','Activar todos','Restaurar estado anterior','Se aplica a todos los complementos, incluidos los ocultos por la búsqueda. Se guarda el estado anterior al último cambio masivo.','Actualizando complementos…','Estados actualizados.','Algunos complementos no pudieron iniciarse o detenerse. Revisa su estado y el modo de seguridad.','No se pudo completar la operación. Revisa los estados antes de reintentar.'],
 de:['Alle deaktivieren','Alle aktivieren','Vorherigen Zustand wiederherstellen','Gilt für alle Plugins, auch ausgeblendete Suchergebnisse. Der Zustand vor der letzten Sammeländerung wird gespeichert.','Plugins werden aktualisiert…','Plugin-Zustände aktualisiert.','Einige Plugins konnten nicht gestartet oder gestoppt werden. Prüfe ihren Status und den Sicherheitsmodus.','Vorgang nicht abgeschlossen. Prüfe die Plugin-Zustände vor einem erneuten Versuch.'],
 fr:['Tout désactiver','Tout activer','Restaurer l’état précédent','Concerne tous les plugins, même masqués par la recherche. L’état avant la dernière modification groupée est conservé.','Mise à jour des plugins…','États des plugins mis à jour.','Certains plugins n’ont pas pu démarrer ou s’arrêter. Vérifiez leur état et le mode de sécurité.','Opération incomplète. Vérifiez les états avant de réessayer.'],
 'pt-BR':['Desativar todos','Ativar todos','Restaurar estado anterior','Aplica-se a todos os plugins, inclusive os ocultos pela busca. Salva o estado anterior à última alteração em grupo.','Atualizando plugins…','Estados dos plugins atualizados.','Alguns plugins não puderam iniciar ou parar. Confira o estado e o modo de segurança.','Não foi possível concluir. Confira os estados antes de tentar novamente.'],
 it:['Disattiva tutti','Attiva tutti','Ripristina stato precedente','Si applica a tutti i plugin, anche quelli nascosti dalla ricerca. Salva lo stato precedente all’ultima modifica collettiva.','Aggiornamento dei plugin…','Stati dei plugin aggiornati.','Alcuni plugin non sono stati avviati o arrestati. Controlla stato e modalità di sicurezza.','Operazione non completata. Controlla gli stati prima di riprovare.'],
 nl:['Alles uitschakelen','Alles inschakelen','Vorige toestand herstellen','Geldt voor alle plugins, ook verborgen zoekresultaten. De toestand vóór de laatste groepswijziging wordt bewaard.','Plugins bijwerken…','Pluginstatussen bijgewerkt.','Sommige plugins konden niet starten of stoppen. Controleer hun status en de beveiligingsmodus.','Bewerking niet voltooid. Controleer de statussen voordat je opnieuw probeert.'],
 pl:['Wyłącz wszystkie','Włącz wszystkie','Przywróć poprzedni stan','Dotyczy wszystkich wtyczek, także ukrytych przez wyszukiwanie. Zachowuje stan sprzed ostatniej zmiany zbiorczej.','Aktualizowanie wtyczek…','Stany wtyczek zaktualizowane.','Niektórych wtyczek nie udało się uruchomić lub zatrzymać. Sprawdź ich stan i tryb bezpieczeństwa.','Nie udało się ukończyć operacji. Sprawdź stany przed ponowieniem.'],
 ru:['Выключить все','Включить все','Восстановить прежнее состояние','Применяется ко всем плагинам, включая скрытые поиском. Сохраняется состояние до последнего группового изменения.','Обновление плагинов…','Состояния плагинов обновлены.','Некоторые плагины не удалось запустить или остановить. Проверьте их состояние и режим безопасности.','Операция не завершена. Проверьте состояния перед повтором.'],
 uk:['Вимкнути всі','Увімкнути всі','Відновити попередній стан','Застосовується до всіх плагінів, навіть прихованих пошуком. Зберігає стан перед останньою груповою зміною.','Оновлення плагінів…','Стани плагінів оновлено.','Деякі плагіни не вдалося запустити або зупинити. Перевірте їхній стан і режим безпеки.','Операцію не завершено. Перевірте стани перед повторенням.'],
 ja:['すべて無効にする','すべて有効にする','前の状態を復元','検索で非表示のものを含むすべてのプラグインに適用します。最後の一括変更前の状態を保存します。','プラグインを更新中…','プラグインの状態を更新しました。','一部のプラグインを開始または停止できませんでした。状態とセキュリティモードを確認してください。','操作を完了できませんでした。再試行する前に状態を確認してください。'],
 'zh-CN':['全部关闭','全部开启','恢复之前状态','应用于所有插件，包括搜索隐藏的插件。保存上次批量更改前的状态。','正在更新插件…','插件状态已更新。','部分插件无法启动或停止。请检查状态和安全模式。','操作未完成。重试前请检查插件状态。'],
 ko:['모두 끄기','모두 켜기','이전 상태 복원','검색에서 숨겨진 플러그인을 포함해 모두 적용합니다. 마지막 일괄 변경 전 상태를 저장합니다.','플러그인 업데이트 중…','플러그인 상태를 업데이트했습니다.','일부 플러그인을 시작하거나 중지할 수 없습니다. 상태와 보안 모드를 확인하세요.','작업을 완료하지 못했습니다. 다시 시도하기 전에 상태를 확인하세요.'],
 id:['Nonaktifkan semua','Aktifkan semua','Pulihkan keadaan sebelumnya','Berlaku untuk semua plugin, termasuk yang tersembunyi oleh pencarian. Keadaan sebelum perubahan massal terakhir disimpan.','Memperbarui plugin…','Keadaan plugin diperbarui.','Beberapa plugin tidak dapat dimulai atau dihentikan. Periksa status dan mode keamanan.','Operasi belum selesai. Periksa status sebelum mencoba lagi.'],
 fa:['غیرفعال کردن همه','فعال کردن همه','بازیابی وضعیت قبلی','برای همه افزونه‌ها، حتی موارد پنهان در جستجو اعمال می‌شود. وضعیت پیش از آخرین تغییر گروهی ذخیره می‌شود.','در حال به‌روزرسانی افزونه‌ها…','وضعیت افزونه‌ها به‌روز شد.','برخی افزونه‌ها شروع یا متوقف نشدند. وضعیت و حالت امنیتی را بررسی کنید.','عملیات کامل نشد. پیش از تلاش دوباره وضعیت افزونه‌ها را بررسی کنید.'],
 cs:['Vypnout vše','Zapnout vše','Obnovit předchozí stav','Platí pro všechny pluginy včetně skrytých hledáním. Uloží stav před poslední hromadnou změnou.','Aktualizace pluginů…','Stavy pluginů aktualizovány.','Některé pluginy se nepodařilo spustit nebo zastavit. Zkontrolujte stav a bezpečnostní režim.','Operaci nelze dokončit. Před opakováním zkontrolujte stavy.'],
 vi:['Tắt tất cả','Bật tất cả','Khôi phục trạng thái trước','Áp dụng cho mọi plugin, kể cả plugin bị ẩn bởi tìm kiếm. Lưu trạng thái trước lần thay đổi hàng loạt gần nhất.','Đang cập nhật plugin…','Đã cập nhật trạng thái plugin.','Không thể khởi động hoặc dừng một số plugin. Kiểm tra trạng thái và chế độ bảo mật.','Chưa hoàn tất thao tác. Kiểm tra trạng thái trước khi thử lại.'],
};
const restart:Record<Locale,string>={
 'en-US':'Restart Discord to fully remove changes applied during startup.',
 tr:'Başlangıçta uygulanan değişiklikleri tamamen kaldırmak için Discord’u yeniden başlatın.',
 'es-ES':'Reinicia Discord para eliminar por completo los cambios aplicados al inicio.',
 de:'Starte Discord neu, um die beim Start angewendeten Änderungen vollständig zu entfernen.',
 fr:'Redémarrez Discord pour supprimer entièrement les changements appliqués au démarrage.',
 'pt-BR':'Reinicie o Discord para remover totalmente as alterações aplicadas na inicialização.',
 it:'Riavvia Discord per rimuovere completamente le modifiche applicate all’avvio.',
 nl:'Herstart Discord om wijzigingen die bij het opstarten zijn toegepast volledig te verwijderen.',
 pl:'Uruchom Discord ponownie, aby całkowicie usunąć zmiany zastosowane przy uruchamianiu.',
 ru:'Перезапустите Discord, чтобы полностью удалить изменения, применённые при запуске.',
 uk:'Перезапустіть Discord, щоб повністю прибрати зміни, застосовані під час запуску.',
 ja:'起動時に適用された変更を完全に解除するには、Discordを再起動してください。',
 'zh-CN':'请重启 Discord，以完全移除启动时应用的更改。',
 ko:'시작 시 적용된 변경 사항을 완전히 제거하려면 Discord를 다시 시작하세요.',
 id:'Mulai ulang Discord untuk sepenuhnya menghapus perubahan yang diterapkan saat startup.',
 fa:'برای حذف کامل تغییرات اعمال‌شده هنگام راه‌اندازی، دیسکورد را دوباره راه‌اندازی کنید.',
 cs:'Restartujte Discord, aby se zcela odstranily změny provedené při spuštění.',
 vi:'Khởi động lại Discord để xóa hoàn toàn những thay đổi được áp dụng khi khởi động.',
};
export function pluginBulkCatalog(locale:Locale){
 const [off,on,restore,hint,busy,done,partial,failed]=copy[locale];
 return {'pluginsBulk.off':off,'pluginsBulk.on':on,'pluginsBulk.restore':restore,'pluginsBulk.hint':hint,'pluginsBulk.busy':busy,'pluginsBulk.done':done,'pluginsBulk.partial':partial,'pluginsBulk.failed':failed,'pluginsBulk.restart':restart[locale]};
}
