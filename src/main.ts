import './styles.css';
import { App } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app container is missing from index.html');

const app = new App({ manifestUrl: 'firmware/manifest.json' });
root.appendChild(app.root);

// Handy for debugging from the browser console.
Object.assign(window as unknown as Record<string, unknown>, { espBrowserTool: app });
