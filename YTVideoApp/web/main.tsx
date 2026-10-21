import './legacy';
import { render } from 'solid-js/web';
import { App } from './App';
import './prefs';
import './styles.css';

render(() => <App />, document.getElementById('root')!);
