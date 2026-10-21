import { pendingPlay } from './legacy';
import { render } from 'solid-js/web';
import { App } from './App';
import { api } from './api';
import { playTracks } from './player';
import './styles.css';

render(() => <App />, document.getElementById('root')!);

if (pendingPlay) {
  api.track(pendingPlay).then((t) => playTracks([t], 0, { radio: true }), () => {});
}
