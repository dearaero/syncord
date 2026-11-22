import {definePlugin} from '../../api/plugin';
import {createSpotifySession,emptyPlayback} from '../../api/spotify';
import {registerTitlebarAddon} from '../../ui/titlebarButton';
import {t} from '../../i18n';
import {SPOTIFY_ID} from './settings';
import {publishSpotify} from './state';
import {mountIsland,type IslandView} from './view';
import {SPOTIFY_CSS} from './styles';
export const SpotifyControls=definePlugin({
  id:SPOTIFY_ID,get name(){return t('spotify.name');},get description(){return t('spotify.description');},enabledByDefault:false,
  permissions:{media:true,userData:true,discordStores:['SpotifyStore'],discordActions:['spotify-playback']},
  start(ctx){
    ctx.css.inject(SPOTIFY_CSS);let view:IslandView|undefined,ready=false;
    const session=createSpotifySession(()=>{if(!ready)return;publishSpotify(session.snapshot(),true);view?.update();});ready=true;
    ctx.disposable(session.dispose);
    ctx.disposable(registerTitlebarAddon(button=>{view=mountIsland(button,session);return()=>{view?.dispose();view=undefined;};}));
    publishSpotify(session.snapshot(),true);
    ctx.disposable(()=>publishSpotify(emptyPlayback(),false));
  },
});
