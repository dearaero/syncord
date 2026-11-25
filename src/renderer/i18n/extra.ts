import {performanceCatalog} from './performance';
import {perfDiagnosticsCatalog} from './perfDiagnostics';
import {pluginBulkCatalog} from './pluginBulk';
import {pluginNamesCatalog} from './pluginNames';
import {fakeDMCatalog} from './fakeDM';
import {timeMachineCatalog} from './timeMachine';
import {platformSpooferCatalog} from './platformSpoofer';
import {supporterCatalog} from './supporter';
import {virtualServersCatalog} from './virtualServers';
import {serverClonerCatalog} from './serverCloner';
import {longMessagesCatalog} from './longMessages';
import {emojiFreedomCatalog} from './emojiFreedom';
import {gameCatalog} from './gamePresence';
import {dropCatalog} from '../../shared/dropMessages';
import {experimentsCatalog} from './experiments';
import {spotifyCatalog} from "./spotify";
import {popoutCatalog} from "./popout";
import {markReadCatalog} from "./markRead";
import {shortcutMessagesCatalog} from "./shortcutMessages";
import type {Catalog,Locale} from './core';
const cursor: Record<Locale,string> = {
 'en-US':'Line {line}:{column}', 'es-ES':'Línea {line}:{column}', de:'Zeile {line}:{column}',
 ja:'{line}行、{column}列', fr:'Ligne {line}:{column}', 'pt-BR':'Linha {line}:{column}',
 ru:'Строка {line}, столбец {column}', it:'Riga {line}:{column}', nl:'Regel {line}:{column}',
 pl:'Wiersz {line}, kolumna {column}', tr:'Satır {line}, sütun {column}',
 'zh-CN':'第{line}行，第{column}列', id:'Baris {line}, kolom {column}', fa:'خط {line}، ستون {column}',
 cs:'Řádek {line}, sloupec {column}', vi:'Dòng {line}, cột {column}', ko:'{line}행, {column}열',
 uk:'Рядок {line}, стовпець {column}',
};
export function extraCatalog(locale: Locale): Catalog { return {...pluginBulkCatalog(locale),...performanceCatalog(locale),...perfDiagnosticsCatalog(locale),...fakeDMCatalog(locale),...timeMachineCatalog(locale),...platformSpooferCatalog(locale),...supporterCatalog(locale),...virtualServersCatalog(locale),...serverClonerCatalog(locale),...longMessagesCatalog(locale),...emojiFreedomCatalog(locale),...gameCatalog(locale),...dropCatalog(locale),...experimentsCatalog(locale),...spotifyCatalog(locale),...popoutCatalog(locale),...markReadCatalog(locale),...shortcutMessagesCatalog(locale),...pluginNamesCatalog(locale),'notes.cursor':cursor[locale]}; }
