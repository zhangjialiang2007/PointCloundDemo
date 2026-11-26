import { PointCloudViewer } from './core/viewer.js';
import { HOME_ID, features } from './demos/index.js';

const homeEl = document.getElementById('home');
const stageEl = document.getElementById('stage');
const viewportEl = document.getElementById('viewport');
const panelEl = document.getElementById('panel');
const gridEl = document.getElementById('entry-grid');
const crumbEl = document.getElementById('crumb');
const backEl = document.getElementById('back-home');

let viewer = null;
let activeInstance = null;

/** 生成总览页的三个入口卡片 */
for (const feature of features) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'entry-card';
  card.style.setProperty('--accent', feature.accent);
  card.innerHTML =
    `<span class="entry-step">${feature.step}</span>` +
    `<span class="entry-head">` +
    `<span class="entry-title">${feature.title}</span>` +
    `<span class="entry-subtitle">${feature.subtitle}</span>` +
    `</span>` +
    `<span class="entry-desc">${feature.description}</span>` +
    `<span class="entry-tags">${feature.tags.map((t) => `<span class="tag">${t}</span>`).join('')}</span>` +
    `<span class="entry-cta">进入${feature.title}<i>→</i></span>`;
  card.addEventListener('click', () => {
    location.hash = feature.id;
  });
  gridEl.appendChild(card);
}

/** 3D 视口按需创建：首次进入功能页时才建立渲染上下文 */
function ensureViewer() {
  if (!viewer) viewer = new PointCloudViewer(viewportEl);
  return viewer;
}

/** 卸载当前功能页：示例的返回值可能是函数，也可能是 { dispose } */
function disposeActive() {
  if (activeInstance) {
    if (typeof activeInstance === 'function') activeInstance();
    else activeInstance.dispose?.();
  }
  activeInstance = null;
}

/** 进入功能页 */
function activate(id) {
  const feature = features.find((f) => f.id === id);
  if (!feature) {
    showHome();
    return;
  }

  disposeActive();
  panelEl.replaceChildren();
  homeEl.hidden = true;
  stageEl.hidden = false;
  crumbEl.textContent = feature.title;
  backEl.hidden = false;

  const instance = ensureViewer();
  instance.disposePoints();
  instance.disposeMesh();
  // 页面隐藏期间视口尺寸为 0，进入后补发一次 resize 让相机与画布对齐
  window.dispatchEvent(new Event('resize'));

  const title = document.createElement('h2');
  title.textContent = feature.title;
  title.title = feature.description;
  panelEl.appendChild(title);

  activeInstance = feature.mount({ viewer: instance, panel: panelEl });
}

/** 回到总览页 */
function showHome() {
  disposeActive();
  panelEl.replaceChildren();
  if (viewer) {
    viewer.disposePoints();
    viewer.disposeMesh();
  }
  stageEl.hidden = true;
  homeEl.hidden = false;
  crumbEl.textContent = '总览';
  backEl.hidden = true;
}

/** 基于 hash 的简单路由：空 hash 即总览页 */
function route() {
  const id = location.hash.slice(1);
  if (!id || id === HOME_ID) showHome();
  else activate(id);
}

backEl.addEventListener('click', () => {
  location.hash = HOME_ID;
});
window.addEventListener('hashchange', route);

route();
